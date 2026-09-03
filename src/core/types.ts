// Every public data type of the kernel: brands, logical time, Result, the scenario family
// inferred from the zod schemas, world effects and snapshots, the event union, decisions and
// the harness records. Types only; the invariants they describe are enforced in world.ts and
// simulation.ts.
// 内核全部公共数据类型：品牌类型、逻辑时间、Result、由 zod schema 推导的 Scenario 族、世界效果与快照、
// 事件联合、决策与 harness 记录。此处只有类型；它们描述的不变量由 world.ts 与 simulation.ts 强制。

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

// Brands keep entity, event and run ids apart at compile time; all three are ULID strings
// handed out only by world.create and the event rng, never by callers.
// 品牌类型在编译期区分实体、事件与运行 id；三者都是 ULID 字符串，只由 world.create 与事件 rng 分配。
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type EntityId = Brand<string, "EntityId">;
export type EventId = Brand<string, "EventId">;
export type RunId = Brand<string, "RunId">;

// Ordered lexicographically: substep separates the phases of one tick, seq orders events
// inside a phase. No wall clock enters simulation semantics.
// 按字典序比较：substep 区分一个 tick 内的阶段，seq 排列阶段内的事件。墙钟时间不进入模拟语义。
export interface LogicalTime {
	readonly tick: number;
	readonly substep: number;
	readonly seq: number;
}

// Business failures travel as values; exceptions are reserved for kernel bugs.
// 业务失败以值传递；异常只留给内核 bug。
export type Result<T, E> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

// Scalar is what a world cell can hold; JsonValue is what events, params and plugin state
// carry. Keeping them apart stops arbitrary JSON from reaching a typed column.
// Scalar 是世界单元格能存的值；JsonValue 是事件、参数与插件状态携带的值。分开两者是为了阻止任意 JSON
// 流入带类型的列。
export type Scalar = number | string | boolean | null | readonly string[];
export type JsonValue =
	string | number | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue };
export type JsonObject = { readonly [k: string]: JsonValue };

// Who produced a decision or event; kernel marks what the simulation itself emits.
// 决策或事件由谁产生；kernel 标记模拟自身发出的事件。
export type Provenance =
	"llm" | "surrogate" | "prototype" | "cache" | "rule" | "manual" | "interview" | "kernel";

// Scenario values are frozen to the leaf because plugins share the scenario object with the
// kernel; a hot override replaces the object rather than mutating it.
// Scenario 值冻结到叶子，因为插件与内核共享同一个 scenario 对象；热覆盖用整体替换而不是原地修改。
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

// complete holds when no tick threw IncompleteTick and activated === ok + failed. parseFailures
// is the subset of failed caused by parse or validation; llmFailures counts gateway failures
// written as failure events; droppedEffects counts effects applyEffects rejected.
// complete 成立的条件是没有 tick 抛出 IncompleteTick 且 activated === ok + failed。parseFailures 是
// failed 中由解析或校验引起的子集；llmFailures 是写成 failure 事件的网关失败数；droppedEffects 是
// applyEffects 拒绝的效果数。
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

// Only real network calls enter cost; replay hits and rejected calls contribute nothing.
// 只有真实网络请求计入 cost；replay 命中与被拒绝的调用不计。
export interface Cost {
	readonly llmCalls: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
	readonly wallMs: number;
}

// A failed run still carries full integrity and cost; failure names the stage that broke.
// 失败的 run 仍带完整的 integrity 与 cost；failure 指明出错的阶段。
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

// merge settles two writes to one cell within a tick. Declared columns are namespaced
// `${owner}.${name}` unless the owner is the kernel.
// merge 裁决同一 tick 内对同一单元格的两次写入。声明的列以 `${owner}.${name}` 命名空间化，
// owner 为 kernel 时除外。
export interface ColumnDecl {
	readonly entity: string;
	readonly name: string;
	readonly dtype: ColumnDtype;
	readonly default: Scalar;
	readonly owner: string;
	readonly merge: MergeRule;
}

// The only vocabulary of change. Every effect names the event that caused it; setColumn is
// the batch form cohort transitions use so a 100k-agent update is one effect, not 100k.
// 变更的唯一词汇表。每个效果都记录引起它的事件；setColumn 是 cohort 转移使用的批量形式，
// 十万 agent 的更新是一个效果而不是十万个。
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

// Numeric columns are serialised as base64 little-endian bytes, string columns as arrays;
// the encoding is platform-independent so a live run and its replay hash identically.
// 数值列序列化为 base64 小端字节，字符串列为数组；编码与平台无关，实时运行与回放的哈希因此一致。
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

// seedPath records which rng path produced the event id; parent is the causal link that
// chain() and inspect follow.
// seedPath 记录产生事件 id 的 rng 路径；parent 是 chain() 与 inspect 追踪的因果链接。
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
	// One event per executor and tick for executors that declare batchEvents; agentIds are the
	// activated agents the executor observed, in request order.
	// 声明 batchEvents 的执行体每 tick 一条；agentIds 是该执行体观察到的激活 agent，按请求顺序排列。
	| (EventBase & {
			readonly kind: "observation_batch";
			readonly payload: {
				readonly executor: string;
				readonly agentIds: readonly EntityId[];
				readonly count: number;
				readonly featuresSha?: string;
			};
	  })
	// actions align with agentIds; parseFailures counts the agents in this batch whose
	// failure was a parse or validation failure, the same subset Integrity.parseFailures counts.
	// actions 与 agentIds 对齐；parseFailures 统计本批中因解析或校验失败的 agent 数，
	// 与 Integrity.parseFailures 同口径。
	| (EventBase & {
			readonly kind: "decision_batch";
			readonly payload: {
				readonly executor: string;
				readonly provider: string;
				readonly agentIds: readonly EntityId[];
				readonly actions: readonly string[];
				readonly provenance: Exclude<Provenance, "kernel" | "manual">;
				readonly parseFailures: number;
				readonly cost: Cost;
			};
	  })
	| (EventBase & {
			// params records the structured mode actually used; recorded marks a replayed response.
			// params 记录实际使用的结构化模式；recorded 标记来自录制回放的响应。
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
export type BatchEventKind = "observation_batch" | "decision_batch";

export interface EventFilter {
	readonly kind?: readonly EventKind[];
	readonly agentId?: EntityId;
	readonly tick?: number;
	readonly fromTick?: number;
	readonly toTick?: number;
	readonly limit?: number;
	readonly offset?: number;
}

// Batch events carry no agentId; membership is by payload.agentIds, so the filter has none.
// 批量事件没有 agentId；成员关系由 payload.agentIds 决定，所以该过滤器没有 agentId 字段。
export type BatchEventFilter = Omit<EventFilter, "agentId">;

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

// features is the cohort path (no prompt), prompt the focal path; observationEvent is the
// parent every decision or failure event for this request hangs from.
// features 是 cohort 路径（无 prompt），prompt 是 focal 路径；observationEvent 是本请求的
// 决策或失败事件挂靠的父事件。
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

// parseOk false means the provider fell back to a default action; cost is the share of
// gateway spend attributed to this agent.
// parseOk 为 false 表示提供者回退到了默认动作；cost 是归属到该 agent 的网关开销份额。
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

// manualCalls supplies the ActionCall for agents activated in manual mode; the kernel
// dispatches them without observe or decide.
// manualCalls 为 manual 模式激活的 agent 提供 ActionCall；内核直接派发，不经 observe 与 decide。
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

// holmP is mwuP after Holm correction within one metric; directionFlip is judged against
// the hypothesis outcome direction and is false when there is no hypothesis.
// holmP 是同一指标内经 Holm 校正后的 mwuP；directionFlip 依据假设中 outcome 的方向判定，
// 无假设时恒为 false。
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

// evidenceGrade is a function of replications, axis levels and model count, never of the
// p-values: it grades the design, not the result.
// evidenceGrade 只取决于复制数、轴的水平数与模型数，与 p 值无关：它评的是设计，不是结果。
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
