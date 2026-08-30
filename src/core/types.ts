import type { EventLog, GraphView, WorldView } from "./protocols";

// Base types

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type EntityId = Brand<string, "EntityId">;
export type EventId = Brand<string, "EventId">;
export type RunId = Brand<string, "RunId">;

export interface LogicalTime {
	readonly tick: number;
	readonly substep: number;
	readonly seq: number;
}

export type Result<T, E> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type Scalar = number | string | boolean | null | readonly string[];
export type JsonValue =
	string | number | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue };
export type JsonObject = { readonly [k: string]: JsonValue };

export type Provenance =
	"llm" | "surrogate" | "prototype" | "cache" | "rule" | "manual" | "interview" | "kernel";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly [unknown, ...unknown[]]
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T extends readonly (infer U)[]
			? readonly DeepReadonly<U>[]
			: T extends object
				? { readonly [K in keyof T]: DeepReadonly<T[K]> }
				: T;

// Scenario family

export type ColumnDtype = "f64" | "i32" | "bool" | "str" | "strlist";

export type PersonaSampling =
	| { readonly kind: "value"; readonly value: Scalar }
	| {
			readonly kind: "choice";
			readonly choices: readonly Scalar[];
			readonly weights?: readonly number[] | undefined;
	  }
	| { readonly kind: "range"; readonly min: number; readonly max: number };

export interface PersonaField {
	readonly name: string;
	readonly dtype: ColumnDtype;
	readonly private?: boolean | undefined;
	readonly sampling: PersonaSampling;
}

export type PopulationSource =
	| { readonly kind: "synthetic" }
	| { readonly kind: "csv"; readonly path: string }
	| { readonly kind: "json"; readonly path: string };

export interface PopulationSpec {
	readonly n: number;
	readonly fields: readonly PersonaField[];
	readonly source: PopulationSource;
	readonly provenance: "demographic" | "survey" | "interview" | "synthetic";
	readonly stratify?: Readonly<Record<string, Readonly<Record<string, number>>>> | undefined;
}

export interface PluginSpec {
	readonly kind: string;
	readonly name?: string | undefined;
	readonly options?: JsonObject | undefined;
}
export type ModuleSpec = PluginSpec;
export type ExecutorSpec = PluginSpec;
export type ProviderSpec = PluginSpec;
export type PolicySpec = PluginSpec;
export interface InstrumentSpec extends PluginSpec {
	readonly every?: number | undefined;
}

export type SelectorPredicate =
	| JsonValue
	| { readonly in: readonly Scalar[] }
	| { readonly gt: number }
	| { readonly lt: number };
export interface Selector {
	readonly where: Readonly<Record<string, SelectorPredicate>>;
	readonly fraction?: number | undefined;
	readonly n?: number | undefined;
}

export type Step =
	| { readonly kind: "run"; readonly ticks: number }
	| {
			readonly kind: "intervene";
			readonly arm: string;
			readonly instruction?: string | undefined;
	  }
	| {
			readonly kind: "questionnaire";
			readonly name: string;
			readonly targets?: Selector | undefined;
	  }
	| { readonly kind: "checkpoint" };

export interface LLMSpec {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKeyEnv: string;
	readonly mode: "live" | "record" | "replay";
	readonly recordDir?: string | undefined;
	readonly concurrency: { readonly initial: number; readonly max: number };
	readonly structured: "auto" | "json_schema" | "prompt";
	readonly budget: { readonly maxCalls: number; readonly maxCompletionTokens: number };
	readonly timeoutMs: number;
}

export interface PromptOptions {
	readonly personaFormat: "plain" | "bullets" | "table";
	readonly instructionOrder: "first" | "last";
	readonly rolePlacement: "system" | "user";
	readonly naming: "id" | "name" | "anonymous";
	readonly memoryRepresentation: "transcript" | "json" | "bullets";
	readonly contextWindow: number;
}

export interface Scenario {
	readonly scenarioId: string;
	readonly replicationId: number;
	readonly seed: number;
	readonly seedPath: readonly number[];
	readonly params: JsonObject;
	readonly population: PopulationSpec;
	readonly modules: readonly ModuleSpec[];
	readonly executors: readonly ExecutorSpec[];
	readonly providers: Readonly<Record<string, ProviderSpec>>;
	readonly policy: PolicySpec;
	readonly instruments: readonly InstrumentSpec[];
	readonly steps: readonly Step[];
	readonly llm: LLMSpec;
	readonly prompt: PromptOptions;
}

// Run results

export interface FailureInfo {
	readonly stage: "instantiate" | "run" | "extract";
	readonly excType: string;
	readonly message: string;
	readonly stack: string;
	readonly at?: LogicalTime;
}

export interface Integrity {
	readonly activated: number;
	readonly ok: number;
	readonly failed: number;
	readonly parseFailures: number;
	readonly llmCalls: number;
	readonly llmFailures: number;
	readonly droppedEffects: number;
	readonly complete: boolean;
}

export interface Cost {
	readonly llmCalls: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
	readonly wallMs: number;
}

export interface RunResult {
	readonly runId: RunId;
	readonly scenarioHash: string;
	readonly seed: number;
	readonly status: "succeeded" | "failed";
	readonly failure?: FailureInfo;
	readonly metrics: Readonly<Record<string, number>>;
	readonly distributions: Readonly<Record<string, readonly number[]>>;
	readonly integrity: Integrity;
	readonly cost: Cost;
	readonly logPath: string;
}

// World state and effects

export type MergeRule = "last" | "sum" | "max" | "append";

export interface ColumnDecl {
	readonly entity: string;
	readonly name: string;
	readonly dtype: ColumnDtype;
	readonly default: Scalar;
	readonly owner: string;
	readonly merge: MergeRule;
}

export type Effect =
	| {
			readonly op: "set";
			readonly entity: string;
			readonly id: EntityId;
			readonly column: string;
			readonly value: Scalar;
			readonly cause: EventId;
	  }
	| {
			readonly op: "inc";
			readonly entity: string;
			readonly id: EntityId;
			readonly column: string;
			readonly value: number;
			readonly cause: EventId;
	  }
	| {
			readonly op: "append";
			readonly entity: string;
			readonly id: EntityId;
			readonly column: string;
			readonly value: string;
			readonly cause: EventId;
	  }
	| {
			readonly op: "create";
			readonly entity: string;
			readonly id: EntityId;
			readonly row: Readonly<Record<string, Scalar>>;
			readonly cause: EventId;
	  }
	| {
			readonly op: "delete";
			readonly entity: string;
			readonly id: EntityId;
			readonly cause: EventId;
	  }
	| {
			readonly op: "envSet";
			readonly key: string;
			readonly value: JsonValue;
			readonly cause: EventId;
	  }
	| {
			readonly op: "setColumn";
			readonly entity: string;
			readonly column: string;
			readonly ids: readonly EntityId[];
			readonly values: readonly Scalar[];
			readonly cause: EventId;
	  };

export interface EffectRejection {
	readonly effect: Effect;
	readonly reason: string;
}

export interface EffectReport {
	readonly applied: number;
	readonly rejected: readonly EffectRejection[];
}

export type ColumnSnapshot =
	| { readonly decl: ColumnDecl; readonly encoding: "base64"; readonly data: string }
	| { readonly decl: ColumnDecl; readonly encoding: "strings"; readonly data: readonly string[] }
	| {
			readonly decl: ColumnDecl;
			readonly encoding: "stringLists";
			readonly data: readonly (readonly string[])[];
	  };

export type EntitySnapshot = {
	readonly name: string;
	readonly ids: readonly EntityId[];
	readonly columns: readonly ColumnSnapshot[];
};

export type WorldSnapshot = {
	readonly version: 1;
	readonly entities: readonly EntitySnapshot[];
	readonly env: JsonObject;
};

// Events

export type ActivationMode = "llm" | "rule" | "manual" | "interview";

export interface EventBase {
	readonly eventId: EventId;
	readonly runId: RunId;
	readonly t: LogicalTime;
	readonly agentId?: EntityId;
	readonly parent?: EventId;
	readonly seedPath: readonly number[];
	readonly provenance?: Provenance;
}

export interface TokenUsage {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
}

export type Event =
	| (EventBase & {
			readonly kind: "activation";
			readonly payload: {
				readonly policy: string;
				readonly agentIds: readonly EntityId[];
				readonly modes: Readonly<Record<string, ActivationMode>>;
			};
	  })
	| (EventBase & {
			readonly kind: "observation";
			readonly payload: {
				readonly contentSha: string;
				readonly refs: readonly EventId[];
				readonly truncated: boolean;
				readonly promptHash?: string;
			};
	  })
	| (EventBase & {
			readonly kind: "decision";
			readonly payload: {
				readonly action: string;
				readonly args: JsonValue;
				readonly soft?: Readonly<Record<string, number>>;
				readonly rationaleSha?: string;
				readonly provider: string;
				readonly parseOk: boolean;
			};
	  })
	| (EventBase & {
			readonly kind: "llm_call";
			readonly payload: {
				readonly promptHash: string;
				readonly responseSha: string;
				readonly model: string;
				readonly params: JsonValue;
				readonly usage: TokenUsage;
				readonly latencyMs: number;
				readonly recorded: boolean;
			};
	  })
	| (EventBase & {
			readonly kind: "effect";
			readonly payload: {
				readonly effects: readonly Effect[];
				readonly rejected: readonly EffectRejection[];
			};
	  })
	| (EventBase & {
			readonly kind: "intervention";
			readonly payload: {
				readonly stepIndex: number;
				readonly arm: string;
				readonly targets: readonly EntityId[];
			};
	  })
	| (EventBase & {
			readonly kind: "measurement";
			readonly payload: {
				readonly instrument: string;
				readonly name: string;
				readonly value: JsonValue;
			};
	  })
	| (EventBase & {
			readonly kind: "failure";
			readonly payload: {
				readonly stage: string;
				readonly excType: string;
				readonly message: string;
				readonly stack?: string;
				readonly retryable: boolean;
			};
	  })
	| (EventBase & {
			readonly kind: "checkpoint";
			readonly payload: { readonly path: string; readonly worldHash: string };
	  })
	| (EventBase & {
			readonly kind: "module_step";
			readonly payload: { readonly module: string; readonly summary: JsonValue };
	  });

export type EventKind = Event["kind"];
export type EventOf<K extends EventKind> = Extract<Event, { readonly kind: K }>;
export type EventPayload<K extends EventKind> = EventOf<K>["payload"];

export interface EventFilter {
	readonly kind?: readonly EventKind[];
	readonly agentId?: EntityId;
	readonly tick?: number;
	readonly fromTick?: number;
	readonly toTick?: number;
	readonly limit?: number;
	readonly offset?: number;
}

// Decisions

export interface PromptMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

export interface RenderedPrompt {
	readonly system: string;
	readonly messages: readonly PromptMessage[];
	readonly schema?: JsonValue;
	readonly hash: string;
}

export interface DecisionRequest {
	readonly agentId: EntityId;
	readonly t: LogicalTime;
	readonly state: JsonObject;
	readonly observation: JsonObject;
	readonly observationEvent: EventId;
	readonly features?: readonly number[];
	readonly actionSpace: readonly string[];
	readonly prompt?: RenderedPrompt;
}

export interface Decision {
	readonly agentId: EntityId;
	readonly action: string;
	readonly args: JsonObject;
	readonly soft?: Readonly<Record<string, number>>;
	readonly rationale?: string;
	readonly provenance: Exclude<Provenance, "kernel" | "manual">;
	readonly cost: Cost;
	readonly parseOk: boolean;
	readonly llmEvent?: EventId;
}

export interface ProviderFailure {
	readonly agentId: EntityId;
	readonly reason: string;
	readonly retryable: boolean;
}

export interface RoundContext {
	readonly t: LogicalTime;
	readonly runId: RunId;
	readonly seedPath: readonly number[];
	readonly graph?: GraphView;
	readonly world: WorldView;
	readonly log: EventLog;
}

export interface ActionCall<A = JsonObject> {
	readonly agentId: EntityId;
	readonly name: string;
	readonly args: A;
	readonly cause: EventId;
}

export interface Activation {
	readonly agents: Readonly<Record<EntityId, ActivationMode>>;
	readonly manualCalls?: Readonly<Record<EntityId, ActionCall>>;
}

// Experiment design

export interface Arm {
	readonly name: string;
	readonly role: "treatment" | "control";
	readonly overrides: JsonObject;
	readonly selection?: Selector;
}

export interface Outcome {
	readonly name: string;
	readonly metric: string;
	readonly direction: "increase" | "decrease" | "any";
	readonly targetDistribution?: readonly number[];
}

export interface Hypothesis {
	readonly id: string;
	readonly claim: string;
	readonly claimType: "exploratory" | "mechanism" | "policy";
	readonly arms: readonly Arm[];
	readonly outcomes: readonly Outcome[];
}

// Harness

export interface PerturbationAxis {
	readonly id: string;
	readonly level: "micro" | "meso" | "macro";
	readonly kind: "design" | "representation";
	readonly dimension: string;
	readonly target: string;
	readonly levels: readonly JsonValue[];
}

export interface AuditPlan {
	readonly base: Scenario;
	readonly hypothesis?: Hypothesis;
	readonly axes: readonly PerturbationAxis[];
	readonly design: "one_at_a_time" | "full_factorial";
	readonly replications: number;
	readonly models: readonly string[];
	readonly metrics: readonly string[];
	readonly claimType: Hypothesis["claimType"];
	readonly concurrency: number;
}

export interface Condition {
	readonly conditionId: string;
	readonly axisValues: JsonObject;
	readonly model: string;
	readonly scenario: Scenario;
}

export interface PairwiseTest {
	readonly metric: string;
	readonly a: string;
	readonly b: string;
	readonly nA: number;
	readonly nB: number;
	readonly meanA: number;
	readonly meanB: number;
	readonly meanDiff: number;
	readonly ci95: readonly [number, number];
	readonly cohenD: number;
	readonly mwuP: number;
	readonly holmP: number;
	readonly directionFlip: boolean;
}

export interface DistributionTest {
	readonly metric: string;
	readonly a: string;
	readonly b: string;
	readonly w1: number;
	readonly cliffDelta: number;
	readonly tvd?: number;
}

export interface AuditReport {
	readonly planHash: string;
	readonly conditions: readonly Condition[];
	readonly runs: readonly RunResult[];
	readonly pairwise: readonly PairwiseTest[];
	readonly directionConsistency: Readonly<Record<string, number>>;
	readonly sensitivityRank: readonly (readonly [string, number])[];
	readonly distributionTests: readonly DistributionTest[];
	readonly crossModel: Readonly<Record<string, Readonly<Record<string, number>>>>;
	readonly integritySummary: Readonly<Record<string, number>>;
	readonly costSummary: Cost;
	readonly evidenceGrade: "weak" | "moderate" | "strong";
}
