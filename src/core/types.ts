import type { z } from "zod";
import type { EventLog, GraphView, WorldView } from "./protocols";
import type {
	ArmSchema,
	AuditPlanSchema,
	ColumnDtypeSchema,
	HypothesisSchema,
	InstrumentSpecSchema,
	LLMSpecSchema,
	PersonaFieldSchema,
	OutcomeSchema,
	PersonaSamplingSchema,
	PerturbationAxisSchema,
	PluginSpecSchema,
	PopulationSourceSchema,
	PopulationSpecSchema,
	PromptOptionsSchema,
	ScenarioSchema,
	SelectorPredicateSchema,
	SelectorSchema,
	StepSchema,
} from "./schema";

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

// Scenario family, derived from the zod schemas in schema.ts

export type ColumnDtype = z.infer<typeof ColumnDtypeSchema>;
export type PersonaSampling = DeepReadonly<z.infer<typeof PersonaSamplingSchema>>;
export type PersonaField = DeepReadonly<z.infer<typeof PersonaFieldSchema>>;
export type PopulationSource = DeepReadonly<z.infer<typeof PopulationSourceSchema>>;
export type PopulationSpec = DeepReadonly<z.infer<typeof PopulationSpecSchema>>;
export type PluginSpec = DeepReadonly<z.infer<typeof PluginSpecSchema>>;
export type ModuleSpec = PluginSpec;
export type ExecutorSpec = PluginSpec;
export type ProviderSpec = PluginSpec;
export type PolicySpec = PluginSpec;
export type InstrumentSpec = DeepReadonly<z.infer<typeof InstrumentSpecSchema>>;
export type SelectorPredicate = DeepReadonly<z.infer<typeof SelectorPredicateSchema>>;
export type Selector = DeepReadonly<z.infer<typeof SelectorSchema>>;
export type Step = DeepReadonly<z.infer<typeof StepSchema>>;
export type LLMSpec = DeepReadonly<z.infer<typeof LLMSpecSchema>>;
export type PromptOptions = DeepReadonly<z.infer<typeof PromptOptionsSchema>>;
export type Scenario = DeepReadonly<z.infer<typeof ScenarioSchema>>;

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
	readonly rejectedActions: number;
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
	readonly excType?: string;
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

// Experiment design, derived from the zod schemas in schema.ts

export type Arm = DeepReadonly<z.infer<typeof ArmSchema>>;
export type Outcome = DeepReadonly<z.infer<typeof OutcomeSchema>>;
export type Hypothesis = DeepReadonly<z.infer<typeof HypothesisSchema>>;

// Harness

export type PerturbationAxis = DeepReadonly<z.infer<typeof PerturbationAxisSchema>>;
export type AuditPlan = DeepReadonly<z.infer<typeof AuditPlanSchema>>;

export type ConditionFlag = "identicalToBase";

export interface Condition {
	readonly conditionId: string;
	readonly axisValues: JsonObject;
	readonly model: string;
	readonly scenario: Scenario;
	readonly flags?: readonly ConditionFlag[];
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
	readonly tvdBase?: number;
}

export interface AuditPlanSummary {
	readonly scenarioId: string;
	readonly design: AuditPlan["design"];
	readonly replications: number;
	readonly models: readonly string[];
	readonly metrics: readonly string[];
	readonly claimType: AuditPlan["claimType"];
	readonly axes: readonly PerturbationAxis[];
}

export interface AuditRunRef {
	readonly conditionId: string;
	readonly replicationId: number;
	readonly dir: string;
}

export interface AuditOptionsSummary {
	readonly includeIncomplete: boolean;
	readonly bootstrapIters: number;
	readonly providerOverride?: string;
}

export interface AuditReport {
	readonly planHash: string;
	readonly plan: AuditPlanSummary;
	readonly options: AuditOptionsSummary;
	readonly conditions: readonly Condition[];
	readonly runIndex: readonly AuditRunRef[];
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
