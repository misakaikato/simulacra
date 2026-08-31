import { existsSync, readFileSync, statSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { registerBuiltinExecutors } from "./agents";
import { inspectRun, type InspectQuery, type InspectResult } from "./core/inspect";
import type { Registry } from "./core/protocols";
import { createRegistry } from "./core/registry";
import { replayRun, type ReplayResult } from "./core/replay";
import {
	resumeRun as coreResumeRun,
	runScenario as coreRunScenario,
	type ResumeOptions as CoreResumeOptions,
	type RunOptions as CoreRunOptions,
} from "./core/run";
import { digestRun } from "./core/runDir";
import { parseScenarioYaml, type ScenarioIssue } from "./core/scenario";
import type { GatewayFactory } from "./core/simulation";
import type { FailureInfo, Result, RunResult, Scenario } from "./core/types";
import { createGateway } from "./llm/gateway";
import { registerBuiltinMetrics } from "./metrics";
import { registerBuiltinModules } from "./modules";
import { registerBuiltinPolicies } from "./policies";
import { registerBuiltinProviders } from "./providers";

export type {
	ActionDef,
	ActionRegistry,
	ActivationPolicy,
	Adapter,
	Component,
	DecisionProvider,
	DeclareError,
	DuplicatePlugin,
	EventLog,
	Executor,
	GraphView,
	LLMGateway,
	Metric,
	Module,
	PluginContext,
	PluginError,
	PluginFactory,
	PluginRegistry,
	Recommender,
	Registry,
	ResolveContext,
	Rng,
	World,
	WorldView,
} from "./core/protocols";
export type {
	ActionCall,
	Activation,
	ActivationMode,
	ColumnDecl,
	Cost,
	Decision,
	DecisionRequest,
	Effect,
	EffectReport,
	EntityId,
	Event,
	EventId,
	EventKind,
	FailureInfo,
	Integrity,
	InstrumentSpec,
	JsonObject,
	JsonValue,
	LogicalTime,
	ModuleSpec,
	PluginSpec,
	ProviderFailure,
	ProviderSpec,
	Result,
	RoundContext,
	RunId,
	RunResult,
	Scalar,
	Scenario,
} from "./core/types";
export type { InspectQuery, InspectResult } from "./core/inspect";
export type { ReplayResult } from "./core/replay";
export type { ScenarioIssue } from "./core/scenario";
export type { LogLevel, LogSink } from "./logging/logger";
export { ActionRejected, defineAction, zodToJsonSchema } from "./core/actions";
export { loadCheckpoint, saveCheckpoint } from "./core/checkpoint";
export { ZERO_EVENT_ID, newEntityId, newEventId, toEntityId, toEventId } from "./core/ids";
export { parseOptions } from "./core/registry";
export { andThen, collect, err, map, mapErr, ok, partition, unwrapOr } from "./core/result";
export { keyFromLabel, rngFromSeed } from "./core/rng";
export { AGENT_ENTITY, ORDINAL_COLUMN, PERSONA_PREFIX } from "./core/population";
export { overrideScenario, parseScenario, scenarioHash, spawnReplications } from "./core/scenario";
export { LOG_FILE, RESULT_FILE } from "./core/run";
export { CHECKPOINTS_DIR, SCENARIO_FILE } from "./core/runDir";
export { createRuleProvider, type RuleFn } from "./providers/rule";
export { createMockProvider } from "./providers/mock";
export { registerBuiltinModules } from "./modules";
export { registerBuiltinMetrics } from "./metrics";
export { registerBuiltinProviders } from "./providers";
export { registerBuiltinPolicies } from "./policies";
export { registerBuiltinExecutors } from "./agents";
export { prettySink } from "./logging/sinks";

export const version: string = pkg.version;

const gatewayFactory: GatewayFactory = (spec, opts) => createGateway(spec, opts);

export const createDefaultRegistry = (): Registry => {
	const registry = createRegistry();
	const results = [
		registerBuiltinPolicies(registry),
		registerBuiltinProviders(registry),
		registerBuiltinExecutors(registry),
		registerBuiltinModules(registry),
		registerBuiltinMetrics(registry),
	];
	for (const r of results)
		if (!r.ok)
			throw new Error(`builtin ${r.error.slot} '${r.error.pluginKind}' registered twice`);
	return registry;
};

export const loadScenario = (pathOrText: string): Result<Scenario, readonly ScenarioIssue[]> => {
	const isFile = existsSync(pathOrText) && statSync(pathOrText).isFile();
	return parseScenarioYaml(isFile ? readFileSync(pathOrText, "utf8") : pathOrText);
};

export interface RunOptions extends Omit<CoreRunOptions, "createGateway"> {
	readonly registry?: Registry;
}

export type ResumeOptions = Omit<CoreResumeOptions, "createGateway"> & {
	readonly registry?: Registry;
};

const withGateway = <O extends { readonly registry?: Registry }>(
	opts: O,
): Omit<O, "registry"> & { readonly createGateway: GatewayFactory } => {
	const { registry: _registry, ...rest } = opts;
	return { ...rest, createGateway: gatewayFactory };
};

export const runScenario = (
	scenario: Scenario,
	outDir: string,
	opts: RunOptions = {},
): Promise<Result<RunResult, FailureInfo>> =>
	coreRunScenario(scenario, opts.registry ?? createDefaultRegistry(), outDir, withGateway(opts));

export const resume = (
	checkpointDir: string,
	ticks: number,
	outDir: string,
	opts: ResumeOptions = {},
): Promise<Result<RunResult, FailureInfo>> =>
	coreResumeRun(
		checkpointDir,
		ticks,
		opts.registry ?? createDefaultRegistry(),
		outDir,
		withGateway(opts),
	);

export const replay = (runDir: string, toTick?: number): Result<ReplayResult, string> =>
	replayRun(runDir, toTick);

export const inspect = (runDir: string, query: InspectQuery): Result<InspectResult, string> =>
	inspectRun(runDir, query);

export const digest = (runDir: string): Result<string, string> => digestRun(runDir);
