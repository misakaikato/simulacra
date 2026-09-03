// Every interface a plugin implements or the kernel hands to a plugin: rng, clock, world views,
// actions, policies, executors, providers, gateway, event log, modules, instruments and the
// registry. Implementations live beside their callers; nothing here carries state.
// 插件实现或内核交给插件的全部接口：rng、时钟、世界视图、动作、策略、执行体、提供者、网关、事件日志、
// 模块、仪器与注册表。实现放在各自调用方旁边；这里不持有任何状态。

import type { z } from "zod";
import type { Logger } from "../logging/logger";
import type {
	ActionCall,
	Activation,
	BatchEventFilter,
	ColumnDecl,
	Cost,
	Decision,
	DecisionRequest,
	Effect,
	EffectReport,
	EntityId,
	Event,
	EventFilter,
	EventId,
	JsonObject,
	JsonValue,
	LogicalTime,
	PluginSpec,
	PromptMessage,
	ProviderFailure,
	Result,
	RoundContext,
	RunId,
	RunResult,
	Scalar,
	Scenario,
	WorldSnapshot,
} from "./types";

// Random numbers

// path is the derivation path from the scenario seed; fork(key) appends to it, so any plugin
// can obtain a stream that is reproducible and disjoint from the kernel's own.
// path 是从 Scenario 种子出发的派生路径；fork(key) 在其后追加，因此任何插件都能拿到可复现且与
// 内核互不重叠的随机流。
export interface Rng {
	readonly path: readonly number[];
	next(): number;
	int(n: number): number;
	pick<T>(xs: readonly T[]): T;
	shuffle<T>(xs: readonly T[]): readonly T[];
	bernoulli(p: number): boolean;
	normal(mu?: number, sigma?: number): number;
	fork(key: number): Rng;
}

// Clock

// Logical time only. due() returns the callbacks whose time is not after now; ties break by
// priority (lower first) and then insertion order.
// 只有逻辑时间。due() 返回时间不晚于 now 的回调；同时刻按 priority（小者先）再按插入顺序。
export interface Clock {
	readonly now: LogicalTime;
	nextSeq(): number;
	advanceTick(): LogicalTime;
	advanceSubstep(): LogicalTime;
	schedule(at: LogicalTime, fn: () => Promise<void>, priority?: number, tag?: string): string;
	cancel(handle: string): void;
	due(): readonly (() => Promise<void>)[];
}

// World

export interface ReadonlyColumn<T extends Scalar> {
	readonly length: number;
	at(i: number): T;
	get(id: EntityId): T | undefined;
	toArray(): readonly T[];
}

// WorldView is the read side handed to plugins; World adds declare, create and snapshot.
// Neither exposes a write: every mutation goes through applyEffects in resolver.ts.
// WorldView 是交给插件的只读面；World 增加 declare、create 与 snapshot。两者都不暴露写入口：
// 所有修改都经 resolver.ts 的 applyEffects。
export interface WorldView {
	readonly entities: readonly string[];
	ids(entity: string): readonly EntityId[];
	count(entity: string): number;
	column<T extends Scalar>(entity: string, name: string): ReadonlyColumn<T>;
	row(entity: string, id: EntityId): Readonly<Record<string, Scalar>> | undefined;
	env<T extends JsonValue>(key: string): T | undefined;
	columns(entity: string): readonly ColumnDecl[];
	hash(): string;
}

export interface ColumnConflict {
	readonly kind: "ColumnConflict";
	readonly message: string;
}

export interface World extends WorldView {
	declare(decl: ColumnDecl): Result<void, ColumnConflict>;
	create(
		entity: string,
		rows: readonly Readonly<Record<string, Scalar>>[],
		rng: Rng,
	): readonly EntityId[];
	snapshot(): WorldSnapshot;
}

export type DeclareError =
	| ColumnConflict
	| {
			readonly kind: "ComponentDependencyError";
			readonly component: string;
			readonly missing: readonly string[];
	  }
	| { readonly kind: "DeclareFailed"; readonly message: string };

// Actions

export interface ResolveContext {
	readonly world: WorldView;
	readonly t: LogicalTime;
	readonly modules: ReadonlyMap<string, Module>;
	readonly rng: Rng;
	newEventId(): EventId;
	newEntityId(): EntityId;
}

// One declaration yields the LLM tool schema, argument validation and the resolver. Exactly
// one action per registry is the fallback the kernel substitutes when a decision cannot
// be honoured.
// 一次声明同时产出 LLM 工具 schema、参数校验与解析器。每个注册表恰有一个 fallback 动作，
// 决策无法执行时由内核代入。
export interface ActionDef<P extends z.ZodType = z.ZodType> {
	readonly name: string;
	readonly description: string;
	readonly params: P;
	readonly requiresModules: readonly string[];
	readonly fallback: boolean;
	resolve(call: ActionCall<z.output<P>>, ctx: ResolveContext): Promise<readonly Effect[]>;
}

export interface DuplicateAction {
	readonly kind: "DuplicateAction";
	readonly name: string;
}

export interface DuplicateFallback {
	readonly kind: "DuplicateFallback";
	readonly name: string;
	readonly existing: string;
}

export type ValidationFailure =
	| { readonly kind: "UnknownAction"; readonly name: string }
	| {
			readonly kind: "InvalidArgs";
			readonly name: string;
			readonly issues: readonly { readonly path: string; readonly message: string }[];
	  };

// toolSchemas throws on an unknown name because that is kernel misuse; validate returns a
// Result because bad arguments are data from a provider.
// toolSchemas 遇到未知名字抛异常，因为那是内核误用；validate 返回 Result，因为坏参数是提供者
// 产出的数据。
export interface ActionRegistry {
	register(a: ActionDef): Result<void, DuplicateAction | DuplicateFallback>;
	get(name: string): ActionDef | undefined;
	names(): readonly string[];
	fallback(): ActionDef | undefined;
	toolSchemas(names: readonly string[]): readonly JsonValue[];
	validate(call: ActionCall): Result<ActionCall, ValidationFailure>;
}

// Activation policies

export interface ActivationPolicy {
	readonly name: string;
	select(world: WorldView, t: LogicalTime, rng: Rng): Activation;
}

// Executors and components

export type ModuleObservations = ReadonlyMap<EntityId, JsonObject>;

export interface ObserveContext {
	readonly activationEvent: EventId;
}

// observe writes the observation events itself because it owns the prompt; act is the
// vectorised path for batch executors, focal executors return [] and let the kernel resolve
// each action call. resolvesOwnActions skips the action registry entirely.
// observe 自己写 observation 事件，因为 prompt 归它所有；act 是批量执行体的向量化路径，focal
// 执行体返回 []，由内核逐个解析动作调用。resolvesOwnActions 为 true 时完全绕过动作注册表。
export interface Executor {
	readonly name: string;
	readonly entity: string;
	readonly provider: string;
	readonly resolvesOwnActions?: boolean;
	readonly fallbackAction?: string;
	// Batch executors write one observation_batch per tick from observe and get one
	// decision_batch per tick from the kernel instead of per-agent observation and decision events.
	// 批量执行体在 observe 中每 tick 写一条 observation_batch，并由内核每 tick 写一条 decision_batch，
	// 取代逐 agent 的 observation 与 decision 事件。
	readonly batchEvents?: boolean;
	declare(world: World): Result<void, DeclareError>;
	owns?(world: WorldView, id: EntityId): boolean;
	observe(
		world: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
		log: EventLog,
		rng: Rng,
		observations?: ModuleObservations,
		ctx?: ObserveContext,
	): Promise<readonly DecisionRequest[]>;
	act(decisions: readonly Decision[], ctx: ResolveContext): Promise<readonly Effect[]>;
	after(decisions: readonly Decision[], report: EffectReport, log: EventLog): Promise<void>;
	// Questionnaire requests rendered with the executor's own components; executors without
	// this hook are interviewed with a bare request built by the kernel.
	// 用执行体自己的组件渲染问卷请求；没有该钩子的执行体由内核构造裸请求进行访谈。
	interview?(
		world: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
		log: EventLog,
		rng: Rng,
		questionnaire: Questionnaire,
	): Promise<readonly DecisionRequest[]>;
	getState(): JsonValue;
	setState(s: JsonValue): void;
}

export interface ConsolidateContext {
	readonly t: LogicalTime;
	readonly runId: RunId;
	readonly seedPath: readonly number[];
	readonly rng: Rng;
}

// reads must be declared columns or another component's writes; the executor checks this at
// declare. preAct and postAct are synchronous; consolidate is the async hook for compaction.
// reads 必须是已声明的列或其它组件的 writes，执行体在 declare 时校验。preAct 与 postAct 同步；
// consolidate 是异步的整理钩子。
export interface Component {
	readonly name: string;
	readonly reads: readonly string[];
	readonly writes: readonly string[];
	preAct(
		agentId: EntityId,
		view: WorldView,
		t: LogicalTime,
		ctx: ReadonlyMap<string, JsonValue>,
		log: EventLog,
	): JsonObject;
	postAct(agentId: EntityId, decision: Decision, report: EffectReport, log: EventLog): void;
	consolidate?(agentId: EntityId, log: EventLog, ctx: ConsolidateContext): Promise<void>;
	getState(): JsonValue;
	setState(s: JsonValue): void;
}

// Vectorised update for cohort executors: reads columns for all ids at once and returns
// setColumn effects rather than one effect per agent.
// cohort 执行体的向量化更新：一次读取全部 id 的列，返回 setColumn 效果而不是逐 agent 的效果。
export interface Transition {
	readonly name: string;
	readonly reads: readonly string[];
	readonly writes: readonly string[];
	apply(
		view: WorldView,
		ids: readonly EntityId[],
		decisions: readonly Decision[],
		rng: Rng,
		graph?: GraphView,
	): readonly Effect[];
}

// Decision providers

// decide returns one Result per request in request order; a length or agentId mismatch is a
// contract violation the kernel treats as a whole-batch failure. reset re-seeds per
// replication so composite providers stay deterministic.
// decide 按请求顺序返回等长的 Result；长度或 agentId 错位视为契约违反，内核按整批失败处理。
// reset 按复制重新播种，使组合提供者保持确定性。
export interface DecisionProvider {
	readonly name: string;
	decide(
		requests: readonly DecisionRequest[],
		ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]>;
	fit?(
		trace: readonly { readonly request: DecisionRequest; readonly decision: Decision }[],
	): void;
	audit?(ctx: RoundContext): Readonly<Record<string, number>> | undefined;
	reset(seedPath: readonly number[]): void;
	getState(): JsonValue;
	setState(s: JsonValue): void;
}

// LLM gateway

// tags.purpose buckets the ledger; tags.eventId feeds the homogeneousGuard nonce. maxTokens
// is capped by the spec budget at the gateway.
// tags.purpose 给账本分桶；tags.eventId 用于 homogeneousGuard 的 nonce。maxTokens 在网关处
// 被预算上限截断。
export interface LLMRequest {
	readonly messages: readonly PromptMessage[];
	readonly schema?: JsonValue;
	readonly temperature: number;
	readonly maxTokens: number;
	readonly seed?: number;
	readonly tags: Readonly<Record<string, string>>;
	readonly homogeneousGuard: boolean;
}

// promptHash excludes the nonce and the prompt-mode schema instruction; structured is the
// mode actually used; finishReason is the provider's finish_reason verbatim.
// promptHash 不含 nonce 与 prompt 模式的 schema 指令；structured 是实际使用的模式；
// finishReason 原样转录提供方的 finish_reason。
export interface LLMResponse {
	readonly text: string;
	readonly parsed?: JsonValue;
	readonly usage: {
		readonly promptTokens: number;
		readonly completionTokens: number;
		readonly cachedTokens: number;
	};
	readonly latencyMs: number;
	readonly model: string;
	readonly promptHash: string;
	readonly responseSha: string;
	readonly recorded: boolean;
	readonly structured?: StructuredMode;
	readonly finishReason?: string;
}

export type StructuredMode = "json_schema" | "prompt";

// retryable separates transient failures (429, 5xx, timeout) from final ones (budget, replay
// miss, other 4xx); attempts counts network attempts actually made.
// retryable 区分瞬时失败（429、5xx、超时）与最终失败（预算、回放未命中、其它 4xx）；attempts
// 是实际发出的网络尝试数。
export interface LLMFailure {
	readonly promptHash: string;
	readonly excType: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly attempts: number;
}

// ledger counts real network calls only; failures counts final failures after retries.
// ledger 只计真实网络请求；failures 只计重试耗尽后的最终失败。
export interface LLMGateway {
	complete(req: LLMRequest): Promise<Result<LLMResponse, LLMFailure>>;
	completeMany(reqs: readonly LLMRequest[]): Promise<readonly Result<LLMResponse, LLMFailure>[]>;
	ledger(): Cost;
	ledgerByPurpose(): Readonly<Record<string, Cost>>;
	failures(): number;
}

// Event log

// beginTick/endTick bracket one tick's writes in one transaction. digest is independent of
// insertion order because events are hashed in (t, eventId) order.
// beginTick/endTick 把一个 tick 的写入包在一个事务里。digest 与插入顺序无关，因为事件按
// (t, eventId) 排序后哈希。
export interface EventLog {
	append(e: Event): void;
	beginTick(): void;
	endTick(): void;
	putContent(text: string): string;
	getContent(sha: string): string | undefined;
	query(filter: EventFilter): readonly Event[];
	// Batch events (observation_batch, decision_batch) whose agentIds contain the agent
	// agentIds 包含该 agent 的批量事件（observation_batch、decision_batch）
	batchesOf(agentId: EntityId, filter?: BatchEventFilter): readonly Event[];
	sql<T>(sql: string, params?: readonly (string | number)[]): readonly T[];
	chain(eventId: EventId): readonly Event[];
	digest(): string;
	count(): number;
	close(): void;
}

// World modules

export interface GraphView {
	readonly edgeCount: number;
	neighbors(id: EntityId): readonly EntityId[];
	degree(id: EntityId): number;
}

// step runs after every executor has acted; concurrencySafe modules step under Promise.all.
// initialize runs once before tick 0 and its effects belong to the initialised world the
// tick 0 checkpoint captures.
// step 在所有执行体行动之后运行；concurrencySafe 的模块在 Promise.all 下并行 step。initialize
// 在 tick 0 之前执行一次，其效果属于 tick 0 检查点所捕获的已初始化世界。
export interface Module {
	readonly name: string;
	readonly concurrencySafe: boolean;
	declare(world: World): Result<void, DeclareError>;
	actions(): readonly ActionDef[];
	observe(
		view: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
	): Readonly<Record<EntityId, JsonValue>>;
	step(view: WorldView, t: LogicalTime, rng: Rng): Promise<readonly Effect[]>;
	initialize?(world: WorldView, rng: Rng): Promise<readonly Effect[]>;
	graph?(): GraphView;
	getState(): JsonValue;
	setState(s: JsonValue): void;
}

export interface Recommender {
	readonly name: string;
	rank(
		view: WorldView,
		userIds: readonly EntityId[],
		t: LogicalTime,
		rng: Rng,
		k: number,
	): Readonly<Record<EntityId, readonly EntityId[]>>;
}

// Instruments

export interface Metric {
	readonly name: string;
	compute(view: WorldView, log: EventLog, runId: RunId): number | readonly number[];
}

export interface Question {
	readonly id: string;
	readonly prompt: string;
	readonly responseType: "text" | "integer" | "float" | "choice";
	readonly choices?: readonly string[];
}

// A questionnaire is answered through the agent's own provider with provenance interview;
// answers become measurement events and never touch the world.
// 问卷经 agent 自己的提供者以 interview 来源作答；答案写成 measurement 事件，不改世界。
export interface Questionnaire {
	readonly name: string;
	readonly questions: readonly Question[];
	readonly entersMemory: boolean;
}

// Run contract and adapters

export type RunFn = (scenario: Scenario, seed: number, outDir: string) => Promise<RunResult>;

export interface Adapter {
	readonly name: string;
	toScenario(external: JsonValue): Result<Scenario, string>;
	run: RunFn;
}

// Plugin registry

// gateway is the run's single gateway; plugins must not build their own.
// gateway 是本 run 唯一的网关；插件不得自建。
export interface PluginContext {
	readonly scenario: Scenario;
	readonly registry: Registry;
	readonly logger: Logger;
	readonly gateway?: LLMGateway;
	// Resolves a provider declared in the scenario by name; composite providers use it for
	// their downstream. The simulation memoises instances and rejects cycles.
	// 按名字解析 Scenario 里声明的提供者；组合提供者用它取下游。模拟记忆化实例并拒绝循环引用。
	readonly provider?: (name: string) => Result<DecisionProvider, PluginError>;
}

export type PluginError =
	| { readonly reason: "unknown_kind"; readonly slot: string; readonly kind: string }
	| {
			readonly reason: "invalid_options";
			readonly slot: string;
			readonly kind: string;
			readonly issues: readonly string[];
	  }
	| {
			readonly reason: "construct_failed";
			readonly slot: string;
			readonly kind: string;
			readonly message: string;
	  };

export type PluginFactory<T> = (spec: PluginSpec, ctx: PluginContext) => Result<T, PluginError>;

export interface DuplicatePlugin {
	readonly kind: "DuplicatePlugin";
	readonly slot: string;
	readonly pluginKind: string;
}

// register refuses duplicates with a Result so built-in registration cannot silently shadow
// a user plugin of the same kind.
// register 对重复项返回 Result 而不是覆盖，内置注册因此不会悄悄遮蔽同名的用户插件。
export interface PluginRegistry<T> {
	readonly slot: string;
	register(kind: string, factory: PluginFactory<T>): Result<void, DuplicatePlugin>;
	get(kind: string): PluginFactory<T> | undefined;
	has(kind: string): boolean;
	kinds(): readonly string[];
	create(spec: PluginSpec, ctx: PluginContext): Result<T, PluginError>;
}

export interface Registry {
	readonly actions: ActionRegistry;
	readonly executors: PluginRegistry<Executor>;
	readonly transitions: PluginRegistry<Transition>;
	readonly modules: PluginRegistry<Module>;
	readonly providers: PluginRegistry<DecisionProvider>;
	readonly policies: PluginRegistry<ActivationPolicy>;
	readonly metrics: PluginRegistry<Metric>;
	readonly instruments: PluginRegistry<Questionnaire>;
	readonly adapters: PluginRegistry<Adapter>;
}
