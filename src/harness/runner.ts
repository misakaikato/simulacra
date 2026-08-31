import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRunId } from "../core/ids";
import type { RunFn } from "../core/protocols";
import { err, ok } from "../core/result";
import { keyFromLabel, rngFromSeed } from "../core/rng";
import { LOG_FILE, withProviderOverride } from "../core/run";
import { scenarioHash, spawnReplications, type OverrideError } from "../core/scenario";
import type {
	AuditOptionsSummary,
	AuditPlan,
	AuditReport,
	AuditRunRef,
	Condition,
	Cost,
	DistributionTest,
	FailureInfo,
	Outcome,
	PairwiseTest,
	ProviderSpec,
	Result,
	RunResult,
	Scenario,
} from "../core/types";
import type { Logger } from "../logging/logger";
import { baselineOf, generateConditions, isBaseCondition } from "./conditions";
import { planHash } from "./plan";
import { renderReportHtml } from "./report";
import {
	bootstrapMeanDiffCI,
	cliffDelta,
	cohenD,
	directionFlip,
	evidenceGrade,
	holm,
	mannWhitneyU,
	mean,
	simbenchScore,
	wasserstein1,
} from "./stats";

export const AUDIT_FILE = "audit.json";
export const PLAN_FILE = "plan.json";
export const REPORT_FILE = "report.html";
export const RUNS_DIR = "runs";
export const DEFAULT_BOOTSTRAP_ITERS = 2000;
export const CONDITION_SCENARIO_SEPARATOR = "#";

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

export interface AuditOptions {
	readonly logger: Logger;
	readonly includeIncomplete?: boolean;
	readonly providerOverride?: string;
	readonly replications?: number;
	readonly concurrency?: number;
	readonly overwrite?: boolean;
	readonly bootstrapIters?: number;
}

export type AuditError =
	OverrideError | { readonly kind: "OutputDirNotEmpty"; readonly path: string };

export interface AuditRun {
	readonly ref: AuditRunRef;
	readonly result: RunResult;
}

export interface AnalyzeOptions {
	readonly includeIncomplete: boolean;
	readonly bootstrapIters: number;
	readonly providerOverride?: string;
}

// Directory names: the separators of a condition id become file-system safe characters

const SEPARATOR_DIR_CHARS: Readonly<Record<string, string>> = { "=": "-", "|": "+", "@": "~" };
const SAFE_DIR_CHAR = /[A-Za-z0-9._+~-]/;

export const conditionDirName = (conditionId: string): string => {
	const name = [...conditionId]
		.map((ch) => SEPARATOR_DIR_CHARS[ch] ?? (SAFE_DIR_CHAR.test(ch) ? ch : "_"))
		.join("");
	return name.length === 0 ? "condition" : name;
};

export const conditionDirNames = (
	conditions: readonly Condition[],
): ReadonlyMap<string, string> => {
	const used = new Set<string>();
	const names = new Map<string, string>();
	for (const c of conditions) {
		const base = conditionDirName(c.conditionId);
		let name = base;
		let k = 2;
		while (used.has(name)) {
			name = `${base}-${k}`;
			k += 1;
		}
		used.add(name);
		names.set(c.conditionId, name);
	}
	return names;
};

// Scenario preparation: provider override, temperature 0 and a condition-specific scenario id

const withZeroTemperature = (scenario: Scenario): Scenario => {
	const providers: Record<string, ProviderSpec> = {};
	for (const [name, spec] of Object.entries(scenario.providers))
		providers[name] =
			spec.kind === "llm"
				? { ...spec, options: { ...(spec.options ?? {}), temperature: 0 } }
				: spec;
	return { ...scenario, providers };
};

export const auditScenario = (
	condition: Condition,
	providerOverride: string | undefined,
): Scenario => {
	const overridden =
		providerOverride === undefined
			? condition.scenario
			: withProviderOverride(condition.scenario, providerOverride);
	return {
		...withZeroTemperature(overridden),
		scenarioId: `${condition.scenario.scenarioId}${CONDITION_SCENARIO_SEPARATOR}${condition.conditionId}`,
	};
};

export const effectivePlan = (
	plan: AuditPlan,
	opts: Pick<AuditOptions, "replications" | "concurrency">,
): AuditPlan => ({
	...plan,
	replications: opts.replications ?? plan.replications,
	concurrency: opts.concurrency ?? plan.concurrency,
});

// Running

const describeError = (e: unknown): FailureInfo => ({
	stage: "run",
	excType: e instanceof Error ? e.name : "Error",
	message: e instanceof Error ? e.message : String(e),
	stack: e instanceof Error ? (e.stack ?? "") : "",
});

export const failedRunResult = (
	scenario: Scenario,
	dir: string,
	failure: FailureInfo,
): RunResult => ({
	runId: makeRunId(scenario.scenarioId, scenario.replicationId),
	scenarioHash: scenarioHash(scenario),
	seed: scenario.seed,
	status: "failed",
	failure,
	metrics: {},
	distributions: {},
	integrity: {
		activated: 0,
		ok: 0,
		failed: 0,
		parseFailures: 0,
		llmCalls: 0,
		llmFailures: 0,
		droppedEffects: 0,
		rejectedActions: 0,
		complete: false,
	},
	cost: ZERO_COST,
	logPath: join(dir, LOG_FILE),
});

export const runPool = async <T>(
	tasks: readonly (() => Promise<T>)[],
	concurrency: number,
): Promise<readonly T[]> => {
	const results = new Array<T>(tasks.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			next += 1;
			const task = tasks[index];
			if (task === undefined) return;
			results[index] = await task();
		}
	};
	const workers = Math.max(1, Math.min(Math.floor(concurrency), tasks.length));
	await Promise.all(Array.from({ length: workers }, worker));
	return results;
};

const executeRun = async (
	run: RunFn,
	scenario: Scenario,
	ref: AuditRunRef,
	logger: Logger,
): Promise<AuditRun> => {
	const log = logger.child({ conditionId: ref.conditionId, replicationId: ref.replicationId });
	mkdirSync(ref.dir, { recursive: true });
	try {
		const result = await run(scenario, scenario.seed, ref.dir);
		log.info("run finished", { status: result.status, complete: result.integrity.complete });
		return { ref, result };
	} catch (e) {
		const failure = describeError(e);
		log.error("run threw", { excType: failure.excType, message: failure.message });
		return { ref, result: failedRunResult(scenario, ref.dir, failure) };
	}
};

const prepareOutDir = (outDir: string, overwrite: boolean): Result<void, AuditError> => {
	if (existsSync(outDir) && readdirSync(outDir).length > 0) {
		if (!overwrite) return err({ kind: "OutputDirNotEmpty", path: outDir });
		rmSync(outDir, { recursive: true, force: true });
	}
	mkdirSync(outDir, { recursive: true });
	return ok(undefined);
};

// Statistics over the collected runs (pure)

const eligible = (run: AuditRun, includeIncomplete: boolean): boolean =>
	run.result.status === "succeeded" && (includeIncomplete || run.result.integrity.complete);

const sortedUnion = (keys: Iterable<readonly string[]>): readonly string[] => {
	const out = new Set<string>();
	for (const list of keys) for (const k of list) out.add(k);
	return [...out].sort();
};

const directionOf = (plan: AuditPlan, metric: string): Outcome["direction"] =>
	plan.hypothesis?.outcomes.find((o) => o.metric === metric)?.direction ?? "any";

const targetOf = (plan: AuditPlan, metric: string): readonly number[] | undefined =>
	plan.hypothesis?.outcomes.find((o) => o.metric === metric && o.targetDistribution !== undefined)
		?.targetDistribution;

export const histogram = (
	values: readonly number[],
	bins: number,
	lo: number,
	hi: number,
): readonly number[] => {
	const counts = new Array<number>(bins).fill(0);
	const width = hi - lo;
	for (const v of values) {
		const raw = width > 0 ? Math.floor(((v - lo) / width) * bins) : 0;
		const i = Math.max(0, Math.min(bins - 1, raw));
		counts[i] = (counts[i] ?? 0) + 1;
	}
	return counts;
};

const seedOf = (hash: string): number => Number.parseInt(hash.slice(0, 8), 16) >>> 0;

const absDescending = (a: number, b: number): number => {
	const x = Math.abs(a);
	const y = Math.abs(b);
	if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
	if (Number.isNaN(y)) return -1;
	return y - x;
};

export const analyze = (
	plan: AuditPlan,
	hash: string,
	conditions: readonly Condition[],
	runs: readonly AuditRun[],
	opts: AnalyzeOptions,
): AuditReport => {
	const byCondition = new Map<string, AuditRun[]>();
	for (const run of runs) {
		const list = byCondition.get(run.ref.conditionId);
		if (list === undefined) byCondition.set(run.ref.conditionId, [run]);
		else list.push(run);
	}
	const usable = runs.filter((r) => eligible(r, opts.includeIncomplete));
	const metricNames =
		plan.metrics.length > 0
			? plan.metrics
			: sortedUnion(usable.map((r) => Object.keys(r.result.metrics)));
	const distributionNames = sortedUnion(usable.map((r) => Object.keys(r.result.distributions)));
	const samples = (conditionId: string, metric: string): readonly number[] =>
		(byCondition.get(conditionId) ?? [])
			.filter((r) => eligible(r, opts.includeIncomplete))
			.flatMap((r) => {
				const v = r.result.metrics[metric];
				return v === undefined ? [] : [v];
			});
	const pooled = (conditionId: string, metric: string): readonly number[] =>
		(byCondition.get(conditionId) ?? [])
			.filter((r) => eligible(r, opts.includeIncomplete))
			.flatMap((r) => r.result.distributions[metric] ?? []);
	const seed = seedOf(hash);

	const pairwise: PairwiseTest[] = [];
	for (const metric of metricNames) {
		const direction = directionOf(plan, metric);
		const tests: Omit<PairwiseTest, "holmP">[] = [];
		for (const condition of conditions) {
			if (isBaseCondition(condition)) continue;
			const baseline = baselineOf(conditions, condition);
			if (baseline === undefined) continue;
			const a = samples(baseline.conditionId, metric);
			const b = samples(condition.conditionId, metric);
			if (a.length < 2 || b.length < 2) continue;
			const meanA = mean(a);
			const meanB = mean(b);
			const rng = rngFromSeed(seed, [
				keyFromLabel(metric),
				keyFromLabel(condition.conditionId),
			]);
			tests.push({
				metric,
				a: baseline.conditionId,
				b: condition.conditionId,
				nA: a.length,
				nB: b.length,
				meanA,
				meanB,
				meanDiff: meanB - meanA,
				ci95: bootstrapMeanDiffCI(b, a, rng, opts.bootstrapIters),
				cohenD: cohenD(b, a),
				mwuP: mannWhitneyU(a, b).p,
				directionFlip: directionFlip(meanA, meanB, direction),
			});
		}
		const adjusted = holm(tests.map((t) => t.mwuP));
		tests.forEach((t, i) => pairwise.push({ ...t, holmP: adjusted[i] ?? 1 }));
	}

	const directionConsistency: Record<string, number> = {};
	for (const metric of metricNames) {
		const tests = pairwise.filter((t) => t.metric === metric);
		if (tests.length === 0) continue;
		directionConsistency[metric] = tests.filter((t) => !t.directionFlip).length / tests.length;
	}

	const best = new Map<string, number>(plan.axes.map((axis) => [axis.id, 0] as const));
	for (const t of pairwise) {
		const condition = conditions.find((c) => c.conditionId === t.b);
		if (condition === undefined) continue;
		const d = Math.abs(t.cohenD);
		if (Number.isNaN(d)) continue;
		for (const axisId of Object.keys(condition.axisValues))
			best.set(axisId, Math.max(best.get(axisId) ?? 0, d));
	}
	const sensitivityRank = [...best.entries()].sort(
		(x, y) => absDescending(x[1], y[1]) || x[0].localeCompare(y[0]),
	);

	const distributionTests: DistributionTest[] = [];
	for (const metric of distributionNames) {
		const target = targetOf(plan, metric);
		for (const condition of conditions) {
			if (isBaseCondition(condition)) continue;
			const baseline = baselineOf(conditions, condition);
			if (baseline === undefined) continue;
			const a = pooled(baseline.conditionId, metric);
			const b = pooled(condition.conditionId, metric);
			if (a.length === 0 || b.length === 0) continue;
			const base: DistributionTest = {
				metric,
				a: baseline.conditionId,
				b: condition.conditionId,
				w1: wasserstein1(a, b),
				cliffDelta: cliffDelta(b, a),
			};
			if (target === undefined) {
				distributionTests.push(base);
				continue;
			}
			const all = [...a, ...b];
			const lo = Math.min(...all);
			const hi = Math.max(...all);
			const normalizedTvd = (values: readonly number[]): number =>
				1 - simbenchScore(target, histogram(values, target.length, lo, hi)) / 100;
			distributionTests.push({ ...base, tvd: normalizedTvd(b), tvdBase: normalizedTvd(a) });
		}
	}

	const crossModel: Record<string, Record<string, number>> = {};
	for (const model of new Set(conditions.map((c) => c.model))) {
		const ids = new Set(conditions.filter((c) => c.model === model).map((c) => c.conditionId));
		const row: Record<string, number> = {};
		for (const metric of metricNames) {
			const values = usable
				.filter((r) => ids.has(r.ref.conditionId))
				.flatMap((r) => {
					const v = r.result.metrics[metric];
					return v === undefined ? [] : [v];
				});
			if (values.length > 0) row[metric] = mean(values);
		}
		crossModel[model] = row;
	}

	const integritySummary: Record<string, number> = {
		runs: runs.length,
		succeeded: 0,
		failed: 0,
		incomplete: 0,
		excluded: runs.length - usable.length,
		activated: 0,
		agentOk: 0,
		agentFailed: 0,
		parseFailures: 0,
		llmCalls: 0,
		llmFailures: 0,
		droppedEffects: 0,
		rejectedActions: 0,
	};
	const cost = { ...ZERO_COST };
	const add = (key: string, value: number): void => {
		integritySummary[key] = (integritySummary[key] ?? 0) + value;
	};
	for (const { result } of runs) {
		add(result.status, 1);
		if (!result.integrity.complete) add("incomplete", 1);
		add("activated", result.integrity.activated);
		add("agentOk", result.integrity.ok);
		add("agentFailed", result.integrity.failed);
		add("parseFailures", result.integrity.parseFailures);
		add("llmCalls", result.integrity.llmCalls);
		add("llmFailures", result.integrity.llmFailures);
		add("droppedEffects", result.integrity.droppedEffects);
		add("rejectedActions", result.integrity.rejectedActions);
		cost.llmCalls += result.cost.llmCalls;
		cost.promptTokens += result.cost.promptTokens;
		cost.completionTokens += result.cost.completionTokens;
		cost.cachedTokens += result.cost.cachedTokens;
		cost.wallMs += result.cost.wallMs;
	}

	const options: AuditOptionsSummary = {
		includeIncomplete: opts.includeIncomplete,
		bootstrapIters: opts.bootstrapIters,
		...(opts.providerOverride === undefined ? {} : { providerOverride: opts.providerOverride }),
	};
	return {
		planHash: hash,
		plan: {
			scenarioId: plan.base.scenarioId,
			design: plan.design,
			replications: plan.replications,
			models: plan.models,
			metrics: metricNames,
			claimType: plan.claimType,
			axes: plan.axes,
		},
		options,
		conditions,
		runIndex: runs.map((r) => r.ref),
		runs: runs.map((r) => r.result),
		pairwise,
		directionConsistency,
		sensitivityRank,
		distributionTests,
		crossModel,
		integritySummary,
		costSummary: cost,
		evidenceGrade: evidenceGrade(plan),
	};
};

export const audit = async (
	plan: AuditPlan,
	run: RunFn,
	outDir: string,
	opts: AuditOptions,
): Promise<Result<AuditReport, AuditError>> => {
	const effective = effectivePlan(plan, opts);
	const generated = generateConditions(effective);
	if (!generated.ok) return generated;
	const prepared = prepareOutDir(outDir, opts.overwrite ?? false);
	if (!prepared.ok) return prepared;
	const conditions: readonly Condition[] = generated.value.map((c) => ({
		...c,
		scenario: auditScenario(c, opts.providerOverride),
	}));
	const hash = planHash(effective);
	writeFileSync(join(outDir, PLAN_FILE), JSON.stringify(effective, null, "\t"));
	const dirNames = conditionDirNames(conditions);
	const logger = opts.logger.child({ planHash: hash.slice(0, 12) });
	const tasks: (() => Promise<AuditRun>)[] = [];
	for (const condition of conditions) {
		const dirName =
			dirNames.get(condition.conditionId) ?? conditionDirName(condition.conditionId);
		for (const replication of spawnReplications(condition.scenario, effective.replications)) {
			const ref: AuditRunRef = {
				conditionId: condition.conditionId,
				replicationId: replication.replicationId,
				dir: join(outDir, RUNS_DIR, dirName, String(replication.replicationId)),
			};
			tasks.push(() => executeRun(run, replication, ref, logger));
		}
	}
	logger.info("audit started", {
		conditions: conditions.length,
		runs: tasks.length,
		concurrency: effective.concurrency,
	});
	const runs = await runPool(tasks, effective.concurrency);
	const report = analyze(effective, hash, conditions, runs, {
		includeIncomplete: opts.includeIncomplete ?? false,
		bootstrapIters: opts.bootstrapIters ?? DEFAULT_BOOTSTRAP_ITERS,
		...(opts.providerOverride === undefined ? {} : { providerOverride: opts.providerOverride }),
	});
	writeFileSync(join(outDir, AUDIT_FILE), JSON.stringify(report, null, "\t"));
	writeFileSync(join(outDir, REPORT_FILE), renderReportHtml(report));
	logger.info("audit finished", {
		runs: runs.length,
		failed: report.integritySummary.failed ?? 0,
		evidenceGrade: report.evidenceGrade,
	});
	return ok(report);
};

export const readAuditReport = (auditDir: string): Result<AuditReport, string> => {
	const path = join(auditDir, AUDIT_FILE);
	if (!existsSync(path)) return err(`${path} does not exist; is ${auditDir} an audit directory?`);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return err(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (
		typeof raw !== "object" ||
		raw === null ||
		typeof (raw as { planHash?: unknown }).planHash !== "string" ||
		!Array.isArray((raw as { conditions?: unknown }).conditions) ||
		!Array.isArray((raw as { pairwise?: unknown }).pairwise)
	)
		return err(`${path}: not an audit report`);
	return ok(raw as AuditReport);
};
