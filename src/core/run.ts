// Run driver: prepares the output directory, wires the logger and gateway factory into
// createSimulation, executes the scenario steps (run, intervene, questionnaire, checkpoint) and
// writes result.json. resumeRun rebuilds the same drive from a checkpoint and copies the
// history that precedes it.
// run 驱动器：准备输出目录，把 logger 与网关工厂接入 createSimulation，执行场景步骤（run、intervene、
// questionnaire、checkpoint）并写 result.json。resumeRun 从检查点重建同样的驱动并复制之前的历史。

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createLogger,
	levelFromEnv,
	type Logger,
	type LogLevel,
	type LogSink,
} from "../logging/logger";
import { jsonlSink } from "../logging/sinks";
import type { EventHandler } from "./bus";
import { loadCheckpoint, saveCheckpoint, type CheckpointState } from "./checkpoint";
import { ZERO_EVENT_ID, makeRunId } from "./ids";
import type { EventLog, Registry } from "./protocols";
import { err, ok } from "./result";
import {
	CHECKPOINTS_DIR,
	openRunLog,
	readRunScenario,
	runDirOfCheckpoint,
	writeRunScenario,
} from "./runDir";
import { scenarioHash } from "./scenario";
import {
	IncompleteTick,
	createSimulation,
	type GatewayFactory,
	type Simulation,
} from "./simulation";
import type {
	EventId,
	FailureInfo,
	JsonValue,
	LLMSpec,
	ProviderSpec,
	Result,
	RunResult,
	Scenario,
	Step,
} from "./types";

export { CHECKPOINTS_DIR } from "./runDir";

export const RESULT_FILE = "result.json";
export const LOG_FILE = "log.jsonl";

export interface RunOptions {
	readonly overwrite?: boolean;
	readonly ticksOverride?: number;
	readonly providerOverride?: string;
	readonly logLevel?: LogLevel;
	readonly sinks?: readonly LogSink[];
	readonly createGateway: GatewayFactory;
	readonly baseDir?: string;
	readonly checkpointEvery?: number;
	readonly onEvent?: EventHandler;
	readonly llmOverride?: Partial<LLMSpec>;
}

export type ResumeOptions = Omit<RunOptions, "ticksOverride" | "providerOverride" | "llmOverride">;

export const withLlmOverride = (scenario: Scenario, override: Partial<LLMSpec>): Scenario => ({
	...scenario,
	llm: { ...scenario.llm, ...override },
});

// Replaces the kind of every declared provider but keeps their names so executors still
// resolve; a mock override therefore swaps rule opponents as well.
// 替换所有已声明提供者的 kind 但保留名字，执行体仍能解析到它们；mock 覆盖因此连规则对手一起替换。
export const withProviderOverride = (scenario: Scenario, kind: string): Scenario => {
	const providers: Record<string, ProviderSpec> = {};
	for (const [name, spec] of Object.entries(scenario.providers))
		providers[name] = { kind, ...(spec.name === undefined ? {} : { name: spec.name }) };
	return { ...scenario, providers };
};

// A ticks override redistributes the budget across the existing run steps so interventions
// between them keep their position; surplus ticks go to the last run step.
// ticks 覆盖把预算重新分配到已有的 run 步骤上，夹在中间的干预保持原位；多出的 tick 归最后一个 run 步骤。
export const withTicksOverride = (scenario: Scenario, ticks: number): Scenario => {
	const runSteps = scenario.steps.filter((s) => s.kind === "run");
	if (runSteps.length === 0)
		return { ...scenario, steps: [...scenario.steps, { kind: "run", ticks }] };
	let remaining = ticks;
	let seen = 0;
	const steps: Step[] = scenario.steps.map((step) => {
		if (step.kind !== "run") return step;
		seen += 1;
		const isLast = seen === runSteps.length;
		const allotted = isLast ? remaining : Math.min(step.ticks, remaining);
		remaining -= allotted;
		return { kind: "run", ticks: allotted };
	});
	return { ...scenario, steps: steps.filter((s) => s.kind !== "run" || s.ticks > 0) };
};

const describeError = (e: unknown, at?: FailureInfo["at"]): FailureInfo => ({
	stage: "run",
	excType: e instanceof Error ? e.name : "Error",
	message: e instanceof Error ? e.message : String(e),
	stack: e instanceof Error ? (e.stack ?? "") : "",
	...(at === undefined ? {} : { at }),
});

const prepareOutDir = (outDir: string, overwrite: boolean): Result<void, FailureInfo> => {
	if (existsSync(outDir) && readdirSync(outDir).length > 0) {
		if (!overwrite)
			return err({
				stage: "instantiate",
				excType: "OutputDirNotEmpty",
				message: `output directory ${outDir} is not empty; pass overwrite to replace it`,
				stack: "",
			});
		rmSync(outDir, { recursive: true, force: true });
	}
	mkdirSync(outDir, { recursive: true });
	return ok(undefined);
};

const splitMeasurements = (
	values: Readonly<Record<string, JsonValue>>,
): Pick<RunResult, "metrics" | "distributions"> => {
	const metrics: Record<string, number> = {};
	const distributions: Record<string, readonly number[]> = {};
	for (const [name, value] of Object.entries(values)) {
		if (typeof value === "number") metrics[name] = value;
		else if (Array.isArray(value) && value.every((v) => typeof v === "number"))
			distributions[name] = value;
	}
	return { metrics, distributions };
};

// Run steps a checkpoint at `tick` already covers are dropped and the one straddling it is
// shortened. Boundary steps that precede the resumed run step are dropped with the covered
// ones, a documented limitation of resume; those after it are kept as written.
// 检查点 `tick` 已覆盖的 run 步骤被丢弃，跨过它的那个被缩短。位于续跑起始 run 步骤之前的边界步骤随已覆盖
// 的步骤一起丢弃，这是 resume 已知的局限；之后的边界步骤原样保留。
export const remainingSteps = (steps: readonly Step[], tick: number): readonly Step[] => {
	const out: Step[] = [];
	let consumed = 0;
	let started = false;
	for (const step of steps) {
		if (started) {
			out.push(step);
			continue;
		}
		if (step.kind !== "run") continue;
		if (consumed + step.ticks <= tick) {
			consumed += step.ticks;
			continue;
		}
		started = true;
		out.push({ kind: "run", ticks: consumed + step.ticks - tick });
	}
	return out;
};

// The checkpoint event stores the path relative to the run directory so digests agree
// across output locations; a failed save is a failure event, not an abort.
// checkpoint 事件存相对 run 目录的路径，不同输出位置的 digest 因此一致；保存失败写 failure 事件，不中止。
const checkpoint = (sim: Simulation, outDir: string, logger: Logger): void => {
	const tick = sim.clock.now.tick;
	const relative = join(CHECKPOINTS_DIR, String(tick));
	const dir = join(outDir, relative);
	const saved = saveCheckpoint(sim.checkpointInput(), dir);
	if (!saved.ok) {
		sim.emit(
			{
				kind: "failure",
				payload: {
					stage: "checkpoint",
					excType: "CheckpointFailed",
					message: saved.error,
					retryable: false,
				},
			},
			{ provenance: "kernel" },
		);
		logger.error("checkpoint failed", { tick, message: saved.error });
		return;
	}
	sim.emit(
		{ kind: "checkpoint", payload: { path: relative, worldHash: saved.value.worldHash } },
		{ provenance: "kernel" },
	);
	logger.info("checkpoint written", { tick, path: dir, worldHash: saved.value.worldHash });
};

// A checkpoint is written at most once per tick; the first one captures the initialised
// world at tick 0, or the resume tick.
// 每个 tick 最多写一次检查点；第一次写的是 tick 0（或续跑起点）的已初始化世界。
const executeSteps = async (
	sim: Simulation,
	outDir: string,
	logger: Logger,
	steps: readonly Step[],
	checkpointEvery: number | undefined,
): Promise<FailureInfo | undefined> => {
	let lastCheckpointTick = -1;
	const writeCheckpoint = (): void => {
		const tick = sim.clock.now.tick;
		if (tick === lastCheckpointTick) return;
		lastCheckpointTick = tick;
		checkpoint(sim, outDir, logger);
	};
	writeCheckpoint();
	for (const [index, step] of steps.entries()) {
		switch (step.kind) {
			case "run":
				for (let k = 0; k < step.ticks; k += 1) {
					const r = await sim.step();
					if (!r.ok) return r.error;
					if (checkpointEvery !== undefined && sim.clock.now.tick % checkpointEvery === 0)
						writeCheckpoint();
				}
				break;
			case "intervene":
				await sim.intervene(step.arm, step.instruction, index);
				break;
			case "questionnaire":
				await sim.questionnaire(step.name, step.targets, index);
				break;
			case "checkpoint":
				writeCheckpoint();
				break;
		}
	}
	return undefined;
};

interface Drive {
	readonly scenario: Scenario;
	readonly steps: readonly Step[];
	readonly resumeFrom?: CheckpointState;
	readonly beforeSteps?: (sim: Simulation) => void;
}

// Instantiation failures still produce a result.json with status failed and an empty
// integrity, so the harness can count them like any other failed run.
// 实例化失败同样产出 status 为 failed、integrity 为空的 result.json，harness 能像其它失败 run 一样计数。
const drive = async (
	drive: Drive,
	registry: Registry,
	outDir: string,
	opts: RunOptions,
): Promise<Result<RunResult, FailureInfo>> => {
	const prepared = prepareOutDir(outDir, opts.overwrite ?? false);
	if (!prepared.ok) return prepared;
	const { scenario, steps } = drive;
	writeRunScenario(outDir, scenario);
	const logPath = join(outDir, LOG_FILE);
	const fileSink = jsonlSink(logPath);
	const logger = createLogger({
		level: opts.logLevel ?? levelFromEnv(),
		sinks: [fileSink, ...(opts.sinks ?? [])],
	});
	const created = createSimulation(scenario, registry, {
		outDir,
		logger,
		createGateway: opts.createGateway,
		...(opts.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
		...(opts.onEvent === undefined ? {} : { onEvent: opts.onEvent }),
		...(drive.resumeFrom === undefined ? {} : { resumeFrom: drive.resumeFrom }),
	});
	const finish = (result: RunResult): Result<RunResult, FailureInfo> => {
		writeFileSync(join(outDir, RESULT_FILE), JSON.stringify(result, null, "\t"));
		logger.info("run finished", {
			status: result.status,
			integrity: { ...result.integrity },
			cost: { ...result.cost },
		});
		fileSink.close();
		return ok(result);
	};
	if (!created.ok) {
		logger.error("instantiate failed", {
			excType: created.error.excType,
			message: created.error.message,
		});
		return finish({
			runId: makeRunId(scenario.scenarioId, scenario.replicationId),
			scenarioHash: "",
			seed: scenario.seed,
			status: "failed",
			failure: created.error,
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
			cost: { llmCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, wallMs: 0 },
			logPath,
		});
	}
	const sim = created.value;
	let failure: FailureInfo | undefined;
	try {
		drive.beforeSteps?.(sim);
		const initialized = await sim.initialize();
		failure = initialized.ok
			? await executeSteps(sim, outDir, sim.logger, steps, opts.checkpointEvery)
			: initialized.error;
	} catch (e) {
		failure = describeError(e, sim.clock.now);
		sim.logger.error(e instanceof IncompleteTick ? "incomplete tick" : "run aborted", {
			excType: failure.excType,
			message: failure.message,
		});
	}
	const integrity = sim.integrity();
	const cost = sim.cost();
	const measured = splitMeasurements(sim.measurements());
	sim.close();
	return finish({
		runId: sim.runId,
		scenarioHash: sim.scenarioHash,
		seed: sim.scenario.seed,
		status: failure === undefined ? "succeeded" : "failed",
		...(failure === undefined ? {} : { failure }),
		...measured,
		integrity,
		cost,
		logPath,
	});
};

export const runScenario = async (
	scenario: Scenario,
	registry: Registry,
	outDir: string,
	opts: RunOptions,
): Promise<Result<RunResult, FailureInfo>> => {
	let effective = scenario;
	if (opts.providerOverride !== undefined)
		effective = withProviderOverride(effective, opts.providerOverride);
	if (opts.ticksOverride !== undefined)
		effective = withTicksOverride(effective, opts.ticksOverride);
	if (opts.llmOverride !== undefined) effective = withLlmOverride(effective, opts.llmOverride);
	return drive({ scenario: effective, steps: effective.steps }, registry, outDir, opts);
};

const instantiateFailure = (excType: string, message: string): FailureInfo => ({
	stage: "instantiate",
	excType,
	message,
	stack: "",
});

// A resumed run keeps the full history before its checkpoint so digest, inspect and replay
// work on the new directory; content is copied wholesale since it is addressed by sha.
// 续跑的 run 保留检查点之前的全部历史，digest、inspect 与回放在新目录上照常工作；content 按 sha 寻址，
// 直接整体复制。
const copyHistory = (source: EventLog, target: EventLog, upTo: EventId, tick: number): void => {
	target.beginTick();
	try {
		for (const row of source.sql<{ readonly sha: string; readonly text: string }>(
			"SELECT sha, text FROM content",
		))
			target.putContent(row.text);
		if (upTo === ZERO_EVENT_ID) return;
		for (const e of source.query({ toTick: tick })) {
			target.append(e);
			if (e.eventId === upTo) break;
		}
	} finally {
		target.endTick();
	}
};

// Steps come from the run's own scenario.json so a resumed run follows the original design;
// the checkpoint fixes the starting tick, the ticks argument fixes how far to go.
// 步骤取自该 run 自己的 scenario.json，续跑遵循原设计；检查点决定起始 tick，ticks 参数决定跑多远。
export const resumeRun = async (
	checkpointDir: string,
	ticks: number,
	registry: Registry,
	outDir: string,
	opts: ResumeOptions,
): Promise<Result<RunResult, FailureInfo>> => {
	const runDir = runDirOfCheckpoint(checkpointDir);
	const scenario = readRunScenario(runDir);
	if (!scenario.ok) return err(instantiateFailure("RunDirUnreadable", scenario.error));
	const checkpoint = loadCheckpoint(checkpointDir, scenarioHash(scenario.value));
	if (!checkpoint.ok)
		return err(instantiateFailure(checkpoint.error.kind, checkpoint.error.message));
	const source = openRunLog(runDir);
	if (!source.ok) return err(instantiateFailure("RunDirUnreadable", source.error));
	const tick = checkpoint.value.clock.now.tick;
	const steps = withTicksOverride(
		{ ...scenario.value, steps: remainingSteps(scenario.value.steps, tick) },
		ticks,
	).steps;
	try {
		return await drive(
			{
				scenario: scenario.value,
				steps,
				resumeFrom: checkpoint.value,
				beforeSteps: (sim) =>
					copyHistory(source.value, sim.log, checkpoint.value.lastEventId, tick),
			},
			registry,
			outDir,
			opts,
		);
	} finally {
		source.value.close();
	}
};
