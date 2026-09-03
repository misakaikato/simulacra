// In-process registry of runs and audits behind the API and MCP: starts them in the background
// on the public runScenario/audit functions, advances progress on activation events and
// completed runs, fans events out to subscribers and reads finished ones back from the data
// directory. Directories are runs/<runId with ':' as '__'>/ and audits/<name or 12-char hash>/.
// API 与 MCP 背后的进程内运行与审计注册表：用公共 runScenario/audit 在后台启动，
// 以 activation 事件与完成的运行推进进度，把事件分发给订阅者，并从数据目录读回已结束的项目。
// 目录为 runs/<runId 的 ':' 换成 '__'>/ 与 audits/<名字或 12 位哈希>/。

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

// runIds contain a colon (scenarioId:replicationId), which is not filename-safe everywhere;
// ':' becomes '__' and any other unsafe character '_'.
// runId 含冒号（scenarioId:replicationId），并非处处文件名安全；':' 换成 '__'，其它不安全字符换成 '_'。
export const runDirName = (runId: RunId): string =>
	[...String(runId)]
		.map((ch) =>
			ch === RUN_ID_SEPARATOR ? RUN_DIR_SEPARATOR : SAFE_DIR_CHAR.test(ch) ? ch : "_",
		)
		.join("");

// Naming rule shared by POST /api/runs and MCP run_scenario: without a name the scenarioId
// becomes <scenarioId>-s<seed>, so runs of one scenario with different seeds get distinct ids.
// POST /api/runs 与 MCP run_scenario 共用的命名规则：未给 name 时 scenarioId 变成
// <scenarioId>-s<seed>，同一场景不同种子的运行因此得到不同的 id。
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

// Read failures come back as err with the path and reason and are logged by the caller; they
// must not collapse into undefined, which would look like a run that never finished.
// 读取失败以带路径与原因的 err 返回并由调用方记日志；绝不能吞成 undefined，
// 那看起来会像一个从未结束的运行。
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

// A directory with scenario.json but no result.json is a run aborted before finishing (server
// killed); it is listed as failed at tick 0 rather than hidden.
// 有 scenario.json 却没有 result.json 的目录是结束前被中止的运行（服务被杀）；
// 列为 tick 0 失败而不是隐藏。
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

// audit.json present means the audit finished; otherwise the total is recomputed from the plan
// so an aborted audit still shows 0/N, and read errors are joined into the summary's error.
// 有 audit.json 表示审计已完成；否则从计划重算 total，被中止的审计仍显示 0/N，
// 读取错误合并进摘要的 error。
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

// A throwing subscriber must not break the run loop or the other subscribers; the error is
// logged and delivery continues.
// 抛异常的订阅者不能拖垮运行循环或其它订阅者；记下错误后继续分发。
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

	// A run that failed before the kernel wrote anything still gets scenario.json and result.json,
	// so it survives a restart and is listed like any other failed run.
	// 在内核写下任何东西之前就失败的运行也会得到 scenario.json 与 result.json，
	// 重启后仍在，并像其它失败的运行一样被列出。
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
				// Progress advances on activation events because they open each tick; that tick is
				// what the GUI shows while the run is in flight.
				// 进度靠 activation 事件推进，因为它开启每个 tick；运行中 GUI 显示的就是这个 tick。
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
		// Audit progress counts completed runs, not ticks: the harness runs them in a pool and
		// only their completion is observable from here.
		// 审计进度按完成的运行计数而非 tick：harness 在池里跑它们，这里只能观察到完成。
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
		// The seed is applied before the runId is derived; existence is checked in memory and on
		// disk so a restarted server cannot overwrite an earlier run's directory.
		// 种子先套用再派生 runId；内存与磁盘都查存在性，重启后的服务不会覆盖早先运行的目录。
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
		// Conditions are generated up front so an invalid axis fails synchronously instead of
		// inside the background task. The automatic id omits the provider, so the same plan with
		// another provider needs an explicit name.
		// 条件先行生成，无效的轴同步失败而不是在后台任务里失败。自动 id 不含 provider，
		// 同一计划换 provider 需要显式 name。
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
		// Disk entries first, then in-memory entries override them: a running run has fresher
		// progress than whatever its directory says.
		// 先读磁盘条目，再用内存条目覆盖：运行中的运行，其进度比目录里的更新。
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
		// Subscriptions are accepted only while running; callers use the undefined return to switch
		// to replay (SSE) or to an immediate read (MCP).
		// 只在运行中接受订阅；调用方用返回的 undefined 切换到回放（SSE）或立即读取（MCP）。
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
