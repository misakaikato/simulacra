import type { z } from "zod";
import type { Logger } from "../logging/logger";
import type {
	ActionCall,
	Activation,
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

export interface Executor {
	readonly name: string;
	readonly entity: string;
	readonly provider: string;
	readonly resolvesOwnActions?: boolean;
	readonly fallbackAction?: string;
	declare(world: World): Result<void, DeclareError>;
	owns?(world: WorldView, id: EntityId): boolean;
	observe(
		world: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
		log: EventLog,
		rng: Rng,
		observations?: ModuleObservations,
	): Promise<readonly DecisionRequest[]>;
	act(decisions: readonly Decision[], ctx: ResolveContext): Promise<readonly Effect[]>;
	after(decisions: readonly Decision[], report: EffectReport, log: EventLog): Promise<void>;
	getState(): JsonValue;
	setState(s: JsonValue): void;
}

export interface ConsolidateContext {
	readonly t: LogicalTime;
	readonly runId: RunId;
	readonly seedPath: readonly number[];
	readonly rng: Rng;
}

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

export interface LLMRequest {
	readonly messages: readonly PromptMessage[];
	readonly schema?: JsonValue;
	readonly temperature: number;
	readonly maxTokens: number;
	readonly seed?: number;
	readonly tags: Readonly<Record<string, string>>;
	readonly homogeneousGuard: boolean;
}

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
}

export type StructuredMode = "json_schema" | "prompt";

export interface LLMFailure {
	readonly promptHash: string;
	readonly excType: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly attempts: number;
}

export interface LLMGateway {
	complete(req: LLMRequest): Promise<Result<LLMResponse, LLMFailure>>;
	completeMany(reqs: readonly LLMRequest[]): Promise<readonly Result<LLMResponse, LLMFailure>[]>;
	ledger(): Cost;
	ledgerByPurpose(): Readonly<Record<string, Cost>>;
	failures(): number;
}

// Event log

export interface EventLog {
	append(e: Event): void;
	beginTick(): void;
	endTick(): void;
	putContent(text: string): string;
	getContent(sha: string): string | undefined;
	query(filter: EventFilter): readonly Event[];
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

export interface Questionnaire {
	readonly name: string;
	readonly questions: readonly {
		readonly id: string;
		readonly prompt: string;
		readonly responseType: "text" | "integer" | "float" | "choice";
		readonly choices?: readonly string[];
	}[];
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

export interface PluginContext {
	readonly scenario: Scenario;
	readonly registry: Registry;
	readonly logger: Logger;
	readonly gateway?: LLMGateway;
	// Resolves a provider declared in the scenario by name; composite providers use it for
	// their downstream. The simulation memoises instances and rejects cycles.
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
	readonly adapters: PluginRegistry<Adapter>;
}
