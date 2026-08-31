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
import { saveCheckpoint } from "./checkpoint";
import { FAILURE_TYPES } from "./failures";
import type { LLMGateway, Registry } from "./protocols";
import { err, ok } from "./result";
import {
	IncompleteTick,
	createSimulation,
	type GatewayFactory,
	type Simulation,
} from "./simulation";
import type {
	FailureInfo,
	JsonValue,
	ProviderSpec,
	Result,
	RunResult,
	Scenario,
	Step,
} from "./types";

export const RESULT_FILE = "result.json";
export const LOG_FILE = "log.jsonl";
export const CHECKPOINTS_DIR = "checkpoints";

export interface RunOptions {
	readonly overwrite?: boolean;
	readonly ticksOverride?: number;
	readonly providerOverride?: string;
	readonly logLevel?: LogLevel;
	readonly sinks?: readonly LogSink[];
	readonly gateway?: LLMGateway;
	readonly createGateway?: GatewayFactory;
	readonly baseDir?: string;
}

export const withProviderOverride = (scenario: Scenario, kind: string): Scenario => {
	const providers: Record<string, ProviderSpec> = {};
	for (const [name, spec] of Object.entries(scenario.providers))
		providers[name] = { kind, ...(spec.name === undefined ? {} : { name: spec.name }) };
	return { ...scenario, providers };
};

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

const notImplemented = (sim: Simulation, logger: Logger, stage: string, what: string): void => {
	sim.emit(
		{
			kind: "failure",
			payload: {
				stage,
				excType: FAILURE_TYPES.notImplemented,
				message: `${what} is not implemented in this kernel version`,
				retryable: false,
			},
		},
		{ provenance: "kernel" },
	);
	logger.error(`${what} skipped`, { stage, excType: FAILURE_TYPES.notImplemented });
};

const executeSteps = async (
	sim: Simulation,
	outDir: string,
	logger: Logger,
): Promise<FailureInfo | undefined> => {
	checkpoint(sim, outDir, logger);
	for (const [index, step] of sim.scenario.steps.entries()) {
		switch (step.kind) {
			case "run":
				for (let k = 0; k < step.ticks; k += 1) {
					const r = await sim.step();
					if (!r.ok) return r.error;
				}
				break;
			case "intervene":
				sim.emit(
					{
						kind: "intervention",
						payload: { stepIndex: index, arm: step.arm, targets: [] },
					},
					{ provenance: "kernel" },
				);
				notImplemented(sim, logger, "intervene", `intervention '${step.arm}'`);
				break;
			case "questionnaire":
				sim.emit(
					{
						kind: "measurement",
						payload: { instrument: "questionnaire", name: step.name, value: null },
					},
					{ provenance: "kernel" },
				);
				notImplemented(sim, logger, "questionnaire", `questionnaire '${step.name}'`);
				break;
			case "checkpoint":
				checkpoint(sim, outDir, logger);
				break;
		}
	}
	return undefined;
};

export const runScenario = async (
	scenario: Scenario,
	registry: Registry,
	outDir: string,
	opts: RunOptions = {},
): Promise<Result<RunResult, FailureInfo>> => {
	const prepared = prepareOutDir(outDir, opts.overwrite ?? false);
	if (!prepared.ok) return prepared;
	const logPath = join(outDir, LOG_FILE);
	const fileSink = jsonlSink(logPath);
	const logger = createLogger({
		level: opts.logLevel ?? levelFromEnv(),
		sinks: [fileSink, ...(opts.sinks ?? [])],
	});
	let effective = scenario;
	if (opts.providerOverride !== undefined)
		effective = withProviderOverride(effective, opts.providerOverride);
	if (opts.ticksOverride !== undefined)
		effective = withTicksOverride(effective, opts.ticksOverride);

	const created = createSimulation(effective, registry, {
		outDir,
		logger,
		...(opts.gateway === undefined ? {} : { gateway: opts.gateway }),
		...(opts.createGateway === undefined ? {} : { createGateway: opts.createGateway }),
		...(opts.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
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
			runId: `${effective.scenarioId}:${effective.replicationId}` as RunResult["runId"],
			scenarioHash: "",
			seed: effective.seed,
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
				complete: false,
			},
			cost: { llmCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, wallMs: 0 },
			logPath,
		});
	}
	const sim = created.value;
	let failure: FailureInfo | undefined;
	try {
		failure = await executeSteps(sim, outDir, sim.logger);
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
