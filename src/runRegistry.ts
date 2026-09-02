import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeRunId } from "./core/ids";
import type { RunFn } from "./core/protocols";
import { err, ok } from "./core/result";
import { RESULT_FILE } from "./core/run";
import { SCENARIO_FILE, readRunScenario } from "./core/runDir";
import type { OverrideError } from "./core/scenario";
import type {
	AuditPlan,
	AuditReport,
	Event,
	FailureInfo,
	Result,
	RunId,
	RunResult,
	Scenario,
} from "./core/types";
import { generateConditions } from "./harness/conditions";
import { parseAuditPlan, planHash } from "./harness/plan";
import {
	AUDIT_FILE,
	audit,
	effectivePlan,
	failedRunResult,
	readAuditReport,
	PLAN_FILE,
} from "./harness/runner";
import type { AuditSummary, RunStatus, RunSummary } from "./api/contract";
import { kernelRunFn, loadScenario, runScenario } from "./index";
import type { Logger, LogLevel } from "./logging/logger";

export const DEFAULT_DATA_DIR = "./simulacra-data";
export const RUNS_DATA_DIR = "runs";
export const AUDITS_DATA_DIR = "audits";
export const AUDIT_ID_CHARS = 12;

const RUN_ID_SEPARATOR = ":";
const RUN_DIR_SEPARATOR = "__";
const SAFE_DIR_CHAR = /[A-Za-z0-9._-]/;
const AUDIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type RunMessage =
	| { readonly kind: "event"; readonly event: Event }
	| { readonly kind: "done"; readonly status: RunResult["status"] };

export type AuditMessage =
	| { readonly kind: "progress"; readonly completed: number; readonly total: number }
	| { readonly kind: "done"; readonly status: "succeeded" | "failed" };

export interface StartRunInput {
	readonly scenario: Scenario;
	readonly seed?: number;
	readonly ticks?: number;
	readonly provider?: string;
}

export interface StartAuditInput {
	readonly plan: AuditPlan;
	readonly name?: string;
	readonly replications?: number;
	readonly provider?: string;
}

export type StartRunError = { readonly kind: "RunExists"; readonly runId: RunId };

export type StartAuditError =
	| { readonly kind: "AuditExists"; readonly auditId: string }
	| { readonly kind: "InvalidAuditName"; readonly name: string }
	| OverrideError;

export interface RunRegistry {
	readonly dataDir: string;
	startRun(input: StartRunInput): Result<{ readonly runId: RunId }, StartRunError>;
	startAudit(input: StartAuditInput): Result<{ readonly auditId: string }, StartAuditError>;
	listRuns(): readonly RunSummary[];
	getRun(runId: RunId): RunSummary | undefined;
	listAudits(): readonly AuditSummary[];
	getAudit(auditId: string): AuditSummary | undefined;
	subscribe(runId: RunId, handler: (message: RunMessage) => void): (() => void) | undefined;
	subscribeAudit(
		auditId: string,
		handler: (message: AuditMessage) => void,
	): (() => void) | undefined;
	runDir(runId: RunId): string;
	auditDir(auditId: string): string;
}

export interface RunRegistryOptions {
	readonly dataDir: string;
	readonly logger: Logger;
	readonly logLevel?: LogLevel;
}

interface RunEntry {
	readonly runId: RunId;
	readonly ticks: number;
	readonly agentCount: number;
	readonly handlers: Set<(message: RunMessage) => void>;
	tick: number;
	status: RunStatus;
	result?: RunResult;
}

interface AuditEntry {
	readonly auditId: string;
	readonly plan: AuditPlan;
	readonly total: number;
	readonly handlers: Set<(message: AuditMessage) => void>;
	completed: number;
	status: RunStatus;
	report?: AuditReport;
}

export const runDirName = (runId: RunId): string =>
	[...String(runId)]
		.map((ch) =>
			ch === RUN_ID_SEPARATOR ? RUN_DIR_SEPARATOR : SAFE_DIR_CHAR.test(ch) ? ch : "_",
		)
		.join("");

export const namedScenario = (scenario: Scenario, seed: number, name?: string): Scenario => ({
	...scenario,
	scenarioId: name ?? `${scenario.scenarioId}-s${seed}`,
	seed,
});

export const totalTicks = (scenario: Scenario): number =>
	scenario.steps.reduce((sum, step) => (step.kind === "run" ? sum + step.ticks : sum), 0);

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const describeError = (e: unknown): FailureInfo => ({
	stage: "run",
	excType: e instanceof Error ? e.name : "Error",
	message: e instanceof Error ? e.message : String(e),
	stack: e instanceof Error ? (e.stack ?? "") : "",
});

const isRunResult = (raw: unknown): raw is RunResult =>
	typeof raw === "object" &&
	raw !== null &&
	typeof (raw as { runId?: unknown }).runId === "string" &&
	((raw as { status?: unknown }).status === "succeeded" ||
		(raw as { status?: unknown }).status === "failed");

const readRunResult = (dir: string): Result<RunResult | undefined, string> => {
	const path = join(dir, RESULT_FILE);
	if (!existsSync(path)) return ok(undefined);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return err(`${path}: ${reasonOf(e)}`);
	}
	return isRunResult(raw) ? ok(raw) : err(`${path}: not a RunResult`);
};

const subdirectories = (dir: string): readonly string[] =>
	existsSync(dir)
		? readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort()
		: [];

const summaryOfEntry = (entry: RunEntry): RunSummary => ({
	runId: entry.runId,
	progress: { tick: entry.tick, ticks: entry.ticks, status: entry.status },
	agentCount: entry.agentCount,
	...(entry.result === undefined ? {} : { result: entry.result }),
});

const summaryOfDir = (dir: string, logger: Logger): RunSummary | undefined => {
	const scenario = readRunScenario(dir);
	if (!scenario.ok) {
		logger.error("run directory unreadable", { dir, error: scenario.error });
		return undefined;
	}
	const ticks = totalTicks(scenario.value);
	const agentCount = scenario.value.population.n;
	const runId = makeRunId(scenario.value.scenarioId, scenario.value.replicationId);
	const aborted: RunSummary = {
		runId,
		progress: { tick: 0, ticks, status: "failed" },
		agentCount,
	};
	const result = readRunResult(dir);
	if (!result.ok) {
		logger.error("result.json unreadable", { dir, error: result.error });
		return { ...aborted, error: result.error };
	}
	if (result.value === undefined) return aborted;
	const tick =
		result.value.status === "succeeded" ? ticks : (result.value.failure?.at?.tick ?? 0);
	return {
		runId: result.value.runId,
		progress: { tick, ticks, status: result.value.status },
		agentCount,
		result: result.value,
	};
};

const auditSummaryOfEntry = (entry: AuditEntry): AuditSummary => ({
	auditId: entry.auditId,
	progress: { completed: entry.completed, total: entry.total, status: entry.status },
	plan: entry.plan,
	...(entry.report === undefined ? {} : { report: entry.report }),
});

const readPlan = (dir: string): Result<AuditPlan | undefined, string> => {
	const path = join(dir, PLAN_FILE);
	if (!existsSync(path)) return ok(undefined);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return err(`${path}: ${reasonOf(e)}`);
	}
	const parsed = parseAuditPlan(raw, { baseDir: dir, loadScenario });
	return parsed.ok
		? ok(parsed.value)
		: err(`${path}: ${parsed.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
};

const auditSummaryOfDir = (auditId: string, dir: string, logger: Logger): AuditSummary => {
	const errors: string[] = [];
	const plan = readPlan(dir);
	if (!plan.ok) {
		logger.error("plan.json unreadable", { dir, error: plan.error });
		errors.push(plan.error);
	}
	const planValue = plan.ok ? plan.value : undefined;
	const report = existsSync(join(dir, AUDIT_FILE)) ? readAuditReport(dir) : undefined;
	if (report !== undefined && !report.ok) {
		logger.error("audit.json unreadable", { dir, error: report.error });
		errors.push(report.error);
	}
	const withPlan = planValue === undefined ? {} : { plan: planValue };
	const withError = errors.length === 0 ? {} : { error: errors.join("; ") };
	if (report !== undefined && report.ok)
		return {
			auditId,
			progress: {
				completed: report.value.runs.length,
				total: report.value.runs.length,
				status: "succeeded",
			},
			...withPlan,
			report: report.value,
			...withError,
		};
	const conditions = planValue === undefined ? undefined : generateConditions(planValue);
	const total =
		planValue !== undefined && conditions !== undefined && conditions.ok
			? conditions.value.length * planValue.replications
			: 0;
	return {
		auditId,
		progress: { completed: 0, total, status: "failed" },
		...withPlan,
		...withError,
	};
};

const notifyAll = <M>(
	handlers: ReadonlySet<(message: M) => void>,
	message: M,
	logger: Logger,
): void => {
	for (const handler of handlers) {
		try {
			handler(message);
		} catch (e) {
			logger.error("subscriber threw", { error: e instanceof Error ? e.message : String(e) });
		}
	}
};

export const createRunRegistry = (opts: RunRegistryOptions): RunRegistry => {
	const dataDir = resolve(opts.dataDir);
	const runsDir = join(dataDir, RUNS_DATA_DIR);
	const auditsDir = join(dataDir, AUDITS_DATA_DIR);
	const logger = opts.logger.child({ dataDir });
	const runs = new Map<RunId, RunEntry>();
	const audits = new Map<string, AuditEntry>();
	const runDir = (runId: RunId): string => join(runsDir, runDirName(runId));
	const auditDir = (auditId: string): string => join(auditsDir, auditId);

	const persistEarlyFailure = (dir: string, scenario: Scenario, result: RunResult): void => {
		mkdirSync(dir, { recursive: true });
		if (!existsSync(join(dir, SCENARIO_FILE)))
			writeFileSync(join(dir, SCENARIO_FILE), JSON.stringify(scenario, null, "\t"));
		if (!existsSync(join(dir, RESULT_FILE)))
			writeFileSync(join(dir, RESULT_FILE), JSON.stringify(result, null, "\t"));
	};

	const finishRun = (entry: RunEntry, result: RunResult): void => {
		entry.result = result;
		entry.status = result.status;
		entry.tick =
			result.status === "succeeded" ? entry.ticks : (result.failure?.at?.tick ?? entry.tick);
		notifyAll(entry.handlers, { kind: "done", status: result.status }, logger);
		entry.handlers.clear();
	};

	const executeRun = async (
		entry: RunEntry,
		scenario: Scenario,
		dir: string,
		input: StartRunInput,
	): Promise<void> => {
		const log = logger.child({ runId: entry.runId });
		let result: RunResult;
		try {
			const r = await runScenario(scenario, dir, {
				...(input.ticks === undefined ? {} : { ticksOverride: input.ticks }),
				...(input.provider === undefined ? {} : { providerOverride: input.provider }),
				...(opts.logLevel === undefined ? {} : { logLevel: opts.logLevel }),
				onEvent: (event) => {
					if (event.kind === "activation") entry.tick = event.t.tick;
					notifyAll(entry.handlers, { kind: "event", event }, logger);
				},
			});
			if (r.ok) result = r.value;
			else {
				result = failedRunResult(scenario, dir, r.error);
				persistEarlyFailure(dir, scenario, result);
				log.error("run failed to start", {
					excType: r.error.excType,
					message: r.error.message,
				});
			}
		} catch (e) {
			const failure = describeError(e);
			result = failedRunResult(scenario, dir, failure);
			persistEarlyFailure(dir, scenario, result);
			log.error("run threw", { excType: failure.excType, message: failure.message });
		}
		log.info("run finished", { status: result.status, complete: result.integrity.complete });
		finishRun(entry, result);
	};

	const finishAudit = (entry: AuditEntry, status: "succeeded" | "failed"): void => {
		entry.status = status;
		notifyAll(entry.handlers, { kind: "done", status }, logger);
		entry.handlers.clear();
	};

	const executeAudit = async (
		entry: AuditEntry,
		dir: string,
		input: StartAuditInput,
	): Promise<void> => {
		const log = logger.child({ auditId: entry.auditId });
		const run = kernelRunFn({
			...(input.provider === undefined ? {} : { providerOverride: input.provider }),
			...(opts.logLevel === undefined ? {} : { logLevel: opts.logLevel }),
		});
		const counting: RunFn = async (scenario, seed, outDir) => {
			const result = await run(scenario, seed, outDir);
			entry.completed += 1;
			notifyAll(
				entry.handlers,
				{ kind: "progress", completed: entry.completed, total: entry.total },
				logger,
			);
			return result;
		};
		try {
			const r = await audit(entry.plan, counting, dir, {
				logger: log,
				...(input.provider === undefined ? {} : { providerOverride: input.provider }),
			});
			if (r.ok) {
				entry.report = r.value;
				log.info("audit finished", {
					runs: r.value.runs.length,
					evidenceGrade: r.value.evidenceGrade,
				});
				finishAudit(entry, "succeeded");
				return;
			}
			log.error("audit failed", { kind: r.error.kind });
		} catch (e) {
			const failure = describeError(e);
			log.error("audit threw", { excType: failure.excType, message: failure.message });
		}
		finishAudit(entry, "failed");
	};

	return {
		dataDir,
		runDir,
		auditDir,
		startRun(input) {
			const scenario =
				input.seed === undefined ? input.scenario : { ...input.scenario, seed: input.seed };
			const runId = makeRunId(scenario.scenarioId, scenario.replicationId);
			const dir = runDir(runId);
			if (runs.has(runId) || existsSync(dir)) return err({ kind: "RunExists", runId });
			const entry: RunEntry = {
				runId,
				ticks: input.ticks ?? totalTicks(scenario),
				agentCount: scenario.population.n,
				handlers: new Set(),
				tick: 0,
				status: "running",
			};
			runs.set(runId, entry);
			void executeRun(entry, scenario, dir, input);
			return ok({ runId });
		},
		startAudit(input) {
			if (input.name !== undefined && !AUDIT_NAME.test(input.name))
				return err({ kind: "InvalidAuditName", name: input.name });
			const plan = effectivePlan(input.plan, {
				...(input.replications === undefined ? {} : { replications: input.replications }),
			});
			const conditions = generateConditions(plan);
			if (!conditions.ok) return conditions;
			const auditId = input.name ?? planHash(plan).slice(0, AUDIT_ID_CHARS);
			const dir = auditDir(auditId);
			if (audits.has(auditId) || existsSync(dir))
				return err({ kind: "AuditExists", auditId });
			const entry: AuditEntry = {
				auditId,
				plan,
				total: conditions.value.length * plan.replications,
				handlers: new Set(),
				completed: 0,
				status: "running",
			};
			audits.set(auditId, entry);
			void executeAudit(entry, dir, input);
			return ok({ auditId });
		},
		listRuns() {
			const out = new Map<RunId, RunSummary>();
			for (const name of subdirectories(runsDir)) {
				const summary = summaryOfDir(join(runsDir, name), logger);
				if (summary !== undefined) out.set(summary.runId, summary);
			}
			for (const entry of runs.values()) out.set(entry.runId, summaryOfEntry(entry));
			return [...out.values()].sort((a, b) =>
				a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0,
			);
		},
		getRun(runId) {
			const entry = runs.get(runId);
			if (entry !== undefined) return summaryOfEntry(entry);
			const dir = runDir(runId);
			if (!existsSync(dir)) return undefined;
			const summary = summaryOfDir(dir, logger);
			return summary !== undefined && summary.runId === runId ? summary : undefined;
		},
		listAudits() {
			const out = new Map<string, AuditSummary>();
			for (const name of subdirectories(auditsDir))
				out.set(name, auditSummaryOfDir(name, join(auditsDir, name), logger));
			for (const entry of audits.values()) out.set(entry.auditId, auditSummaryOfEntry(entry));
			return [...out.values()].sort((a, b) => a.auditId.localeCompare(b.auditId));
		},
		getAudit(auditId) {
			const entry = audits.get(auditId);
			if (entry !== undefined) return auditSummaryOfEntry(entry);
			if (!AUDIT_NAME.test(auditId)) return undefined;
			const dir = auditDir(auditId);
			return existsSync(dir) ? auditSummaryOfDir(auditId, dir, logger) : undefined;
		},
		subscribe(runId, handler) {
			const entry = runs.get(runId);
			if (entry === undefined || entry.status !== "running") return undefined;
			entry.handlers.add(handler);
			return () => {
				entry.handlers.delete(handler);
			};
		},
		subscribeAudit(auditId, handler) {
			const entry = audits.get(auditId);
			if (entry === undefined || entry.status !== "running") return undefined;
			entry.handlers.add(handler);
			return () => {
				entry.handlers.delete(handler);
			};
		},
	};
};
