import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { registerBuiltinAdapters } from "./adapters";
import { registerBuiltinExecutors, registerBuiltinTransitions } from "./agents";
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
import { err, ok } from "./core/result";
import { digestRun, readRunScenario, runDirOfCheckpoint } from "./core/runDir";
export { openRunLog, withRunLog } from "./core/runDir";
import { parseScenarioYaml, resolveScenarioPlugins, type ScenarioIssue } from "./core/scenario";
import type { GatewayFactory } from "./core/simulation";
import type { AuditPlan, FailureInfo, Result, RunResult, Scenario } from "./core/types";
import { parseAuditPlanYaml } from "./harness/plan";
import { failedRunResult } from "./harness/runner";
import type { RunFn } from "./core/protocols";
import { createGateway } from "./llm/gateway";
import { loadPlugins, type PluginLoadError } from "./plugins";
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
	AuditOptionsSummary,
	AuditPlan,
	AuditPlanSummary,
	AuditReport,
	AuditRunRef,
	ColumnDecl,
	Condition,
	ConditionFlag,
	Cost,
	DistributionTest,
	Hypothesis,
	Outcome,
	PairwiseTest,
	PerturbationAxis,
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
export type { Logger, LogLevel, LogRecord, LogSink } from "./logging/logger";
export { createLogger, isLogLevel, levelFromEnv, silentLogger } from "./logging/logger";
export type { PluginLoadError } from "./plugins";
export { loadPlugins } from "./plugins";
export type { DoctorCheck, DoctorOptions } from "./doctor";
export {
	API_KEY_ENV,
	BASE_URL_ENV,
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	MODEL_ENV,
	doctor,
} from "./doctor";
export type { ProbeCheck, ProbeOptions, ProbeResult } from "./llm/probe";
export { PROBE_MAX_CALLS, probeEndpoint } from "./llm/probe";
export { EXAMPLES_DIR, copyExample, examplePath, listExamples } from "./examples";
export { ActionRejected, defineAction, zodToJsonSchema } from "./core/actions";
export { loadCheckpoint, saveCheckpoint } from "./core/checkpoint";
export { ZERO_EVENT_ID, newEntityId, newEventId, toEntityId, toEventId } from "./core/ids";
export { parseOptions } from "./core/registry";
export { andThen, collect, err, map, mapErr, ok, partition, unwrapOr } from "./core/result";
export { keyFromLabel, rngFromSeed } from "./core/rng";
export { AGENT_ENTITY, ORDINAL_COLUMN, PERSONA_PREFIX } from "./core/population";
export {
	overrideScenario,
	parseScenario,
	resolveScenarioPlugins,
	scenarioHash,
	spawnReplications,
} from "./core/scenario";
export type { AxisTemplate } from "./harness/axes";
export {
	AXIS_CATALOG,
	DESIGN_AXES,
	REPRESENTATION_AXES,
	axisFromTemplate,
	axisTemplate,
} from "./harness/axes";
export type { AuditPlanDocument, LoadScenario, ParsePlanOptions } from "./harness/plan";
export {
	AuditPlanDocumentSchema,
	parseAuditPlan,
	parseAuditPlanYaml,
	planHash,
} from "./harness/plan";
export type { Assignment } from "./harness/conditions";
export {
	BASE_CONDITION_ID,
	assignmentsOf,
	baselineOf,
	conditionIdOf,
	generateConditions,
	isBaseCondition,
	modelsOf,
} from "./harness/conditions";
export { LOG_FILE, RESULT_FILE } from "./core/run";
export { CHECKPOINTS_DIR, SCENARIO_FILE } from "./core/runDir";
export {
	createRuleProvider,
	ruleDecision,
	thresholdRule,
	type RuleFn,
	type ThresholdRuleOptions,
} from "./providers/rule";
export { createMockProvider } from "./providers/mock";
export {
	ARCHETYPE_KIND,
	ArchetypeOptionsSchema,
	aggregateObservations,
	createArchetypeProvider,
	groupRequests,
	majorityVote,
	publicPersonaOf,
	type ArchetypeProvider,
	type ArchetypeProviderOptions,
	type ArchetypeReport,
} from "./providers/archetype";
export {
	SURROGATE_KIND,
	SurrogateOptionsSchema,
	createSurrogateProvider,
	fitSoftmax,
	predictProbabilities,
	softmax,
	type SoftmaxModel,
	type SurrogateProvider,
	type SurrogateProviderOptions,
	type TraceEntry,
} from "./providers/surrogate";
export {
	CACHE_KIND,
	CacheOptionsSchema,
	cacheKeyOf,
	createCacheProvider,
	type CacheProviderOptions,
} from "./providers/cache";
export {
	TOPO_KIND,
	TopoOptionsSchema,
	buildCells,
	createTopoProvider,
	execDistance,
	exposureHistogram,
	profilesOf,
	type AgentProfile,
	type Cell,
	type TopoProvider,
	type TopoProviderOptions,
} from "./providers/routers/topo";
export {
	APS_KIND,
	ApsOptionsSchema,
	apportion,
	createApsProvider,
	interpolate,
	miniBatchKMeans,
	projectToSimplex,
	tailScores,
	type ApsProvider,
	type ApsProviderOptions,
	type ApsReport,
} from "./providers/routers/aps";
export { registerBuiltinModules } from "./modules";
export { registerBuiltinMetrics } from "./metrics";
export { COHORT_RULE_KIND, downstreamOf, registerBuiltinProviders } from "./providers";
export { registerBuiltinPolicies } from "./policies";
export type { Transition } from "./core/protocols";
export {
	COHORT_KIND,
	CohortOptionsSchema,
	registerBuiltinExecutors,
	registerBuiltinTransitions,
} from "./agents";
export { OPINION_DYNAMICS_KIND, opinionDynamics } from "./agents/transitions";
export { jsonlSink, prettySink } from "./logging/sinks";
export type { AuditError, AuditOptions, AuditRun, AnalyzeOptions } from "./harness/runner";
export {
	AUDIT_FILE,
	DEFAULT_BOOTSTRAP_ITERS,
	PLAN_FILE,
	REPORT_FILE,
	RUNS_DIR,
	analyze,
	audit,
	conditionDirName,
	effectivePlan,
	failedRunResult,
	readAuditReport,
	runPool,
} from "./harness/runner";
export { escapeHtml, formatNumber, renderReportHtml } from "./harness/report";
export type {
	MetricRequest,
	OasisAdapterOptions,
	OasisImportOptions,
	OasisImportSummary,
	ScriptAdapterOptions,
	ScriptResult,
} from "./adapters";
export {
	OASIS_ADAPTER_KIND,
	OASIS_DB_FILE,
	OASIS_SCENARIO_ID,
	OASIS_WORLD_FILE,
	SCRIPT_ADAPTER_KIND,
	SCRIPT_CONFIG_FILE,
	SCRIPT_LOG_FILE,
	SCRIPT_RESULT_FILE,
	ScriptResultSchema,
	createOasisAdapter,
	createScriptAdapter,
	importOasis,
	registerBuiltinAdapters,
} from "./adapters";
export * as stats from "./harness/stats";

export const version: string = pkg.version;

const gatewayFactory: GatewayFactory = (spec, opts) => createGateway(spec, opts);

export const createDefaultRegistry = (): Registry => {
	const registry = createRegistry();
	const results = [
		registerBuiltinPolicies(registry),
		registerBuiltinProviders(registry),
		registerBuiltinTransitions(registry),
		registerBuiltinExecutors(registry),
		registerBuiltinModules(registry),
		registerBuiltinMetrics(registry),
		registerBuiltinAdapters(registry),
	];
	for (const r of results)
		if (!r.ok)
			throw new Error(`builtin ${r.error.slot} '${r.error.pluginKind}' registered twice`);
	return registry;
};

export const loadScenario = (pathOrText: string): Result<Scenario, readonly ScenarioIssue[]> => {
	const isFile = existsSync(pathOrText) && statSync(pathOrText).isFile();
	const parsed = parseScenarioYaml(isFile ? readFileSync(pathOrText, "utf8") : pathOrText);
	if (!parsed.ok) return parsed;
	return ok(
		resolveScenarioPlugins(parsed.value, isFile ? dirname(resolve(pathOrText)) : process.cwd()),
	);
};

export const loadAuditPlan = (path: string): Result<AuditPlan, readonly ScenarioIssue[]> => {
	if (!existsSync(path) || !statSync(path).isFile())
		return err([{ code: "custom", path: [], message: `${path}: file not found`, input: path }]);
	return parseAuditPlanYaml(readFileSync(path, "utf8"), {
		baseDir: dirname(resolve(path)),
		loadScenario,
	});
};

interface PluginOptions {
	readonly registry?: Registry;
	readonly plugins?: readonly string[];
}

export interface RunOptions extends Omit<CoreRunOptions, "createGateway">, PluginOptions {}

export type ResumeOptions = Omit<CoreResumeOptions, "createGateway"> & PluginOptions;

const withGateway = <O extends PluginOptions>(
	opts: O,
): Omit<O, "registry" | "plugins"> & { readonly createGateway: GatewayFactory } => {
	const { registry: _registry, plugins: _plugins, ...rest } = opts;
	return { ...rest, createGateway: gatewayFactory };
};

const pluginFailure = (e: PluginLoadError): FailureInfo => ({
	stage: "instantiate",
	excType: "PluginLoad",
	message: `plugin ${e.path}: ${e.message}`,
	stack: "",
});

const assemble = async (
	declared: readonly string[] | undefined,
	opts: PluginOptions,
): Promise<Result<Registry, FailureInfo>> => {
	const registry = opts.registry ?? createDefaultRegistry();
	const loaded = await loadPlugins(registry, [...(declared ?? []), ...(opts.plugins ?? [])]);
	return loaded.ok ? ok(registry) : err(pluginFailure(loaded.error));
};

export const runScenario = async (
	scenario: Scenario,
	outDir: string,
	opts: RunOptions = {},
): Promise<Result<RunResult, FailureInfo>> => {
	const registry = await assemble(scenario.plugins, opts);
	if (!registry.ok) return registry;
	return coreRunScenario(scenario, registry.value, outDir, withGateway(opts));
};

export const resume = async (
	checkpointDir: string,
	ticks: number,
	outDir: string,
	opts: ResumeOptions = {},
): Promise<Result<RunResult, FailureInfo>> => {
	const scenario = readRunScenario(runDirOfCheckpoint(checkpointDir));
	const registry = await assemble(scenario.ok ? scenario.value.plugins : undefined, opts);
	if (!registry.ok) return registry;
	return coreResumeRun(checkpointDir, ticks, registry.value, outDir, withGateway(opts));
};

export type KernelRunOptions = Omit<RunOptions, "overwrite" | "ticksOverride">;

export const kernelRunFn =
	(opts: KernelRunOptions = {}): RunFn =>
	async (scenario, seed, outDir) => {
		const effective = { ...scenario, seed };
		const r = await runScenario(effective, outDir, { ...opts, overwrite: true });
		return r.ok ? r.value : failedRunResult(effective, outDir, r.error);
	};

export const replay = (runDir: string, toTick?: number): Result<ReplayResult, string> =>
	replayRun(runDir, toTick);

export const inspect = (runDir: string, query: InspectQuery): Result<InspectResult, string> =>
	inspectRun(runDir, query);

export const digest = (runDir: string): Result<string, string> => digestRun(runDir);
