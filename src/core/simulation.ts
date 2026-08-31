import { join, resolve } from "node:path";
import type { Logger } from "../logging/logger";
import type { CheckpointInput } from "./checkpoint";
import { createClock } from "./clock";
import { makeEvent, type EventInit } from "./events";
import { FAILURE_TYPES, PARSE_FAILURE_TYPES } from "./failures";
import { makeRunId, newEntityId, newEventId, toEntityId, toEventId } from "./ids";
import { eventLogPath, openSqliteEventLog } from "./log";
import { AGENT_ENTITY, buildPopulation } from "./population";
import type {
	ActivationPolicy,
	Clock,
	DecisionProvider,
	EventLog,
	Executor,
	GraphView,
	LLMGateway,
	Metric,
	Module,
	ModuleObservations,
	PluginContext,
	Registry,
	ResolveContext,
	Rng,
	World,
} from "./protocols";
import { applyEffects } from "./resolver";
import { err, ok } from "./result";
import { keyFromLabel, rngFromSeed } from "./rng";
import { scenarioHash } from "./scenario";
import type {
	ActionCall,
	Activation,
	Cost,
	Decision,
	DecisionRequest,
	Effect,
	EffectReport,
	EntityId,
	Event,
	EventId,
	FailureInfo,
	Integrity,
	JsonObject,
	JsonValue,
	LLMSpec,
	LogicalTime,
	Provenance,
	ProviderFailure,
	Result,
	RunId,
	Scenario,
} from "./types";
import { createWorld } from "./world";

export const RECORDINGS_DIR = "recordings";
export const MAX_CONSECUTIVE_BATCH_FAILURES = 3;
export const MAX_CONSECUTIVE_MODULE_FAILURES = 3;
const ZERO_EVENT_ID = toEventId("00000000000000000000000000");
const MANUAL = "manual";
const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

export class IncompleteTick extends Error {
	constructor(tick: number, detail: string) {
		super(`tick ${tick} is incomplete: ${detail}`);
		this.name = "IncompleteTick";
	}
}

export type GatewayFactory = (spec: LLMSpec, logger: Logger) => LLMGateway;

export interface SimulationDeps {
	readonly outDir: string;
	readonly logger: Logger;
	readonly gateway?: LLMGateway;
	readonly createGateway?: GatewayFactory;
	readonly log?: EventLog;
	readonly baseDir?: string;
}

export interface TickReport {
	readonly tick: number;
	readonly activated: number;
	readonly ok: number;
	readonly failed: number;
}

export interface EventFields {
	readonly agentId?: EntityId;
	readonly parent?: EventId;
	readonly provenance?: Provenance;
}

export interface Instrument {
	readonly name: string;
	readonly kind: string;
	readonly every: number;
	readonly metric: Metric;
}

export interface Simulation {
	readonly runId: RunId;
	readonly scenario: Scenario;
	readonly scenarioHash: string;
	readonly world: World;
	readonly clock: Clock;
	readonly log: EventLog;
	readonly gateway: LLMGateway | undefined;
	readonly logger: Logger;
	step(activationOverride?: Activation): Promise<Result<TickReport, FailureInfo>>;
	emit(init: EventInit, fields?: EventFields): Event;
	integrity(): Integrity;
	cost(): Cost;
	measurements(): Readonly<Record<string, JsonValue>>;
	checkpointInput(): CheckpointInput;
	close(): void;
}

interface AgentOutcome {
	readonly decision: Decision;
	readonly call: ActionCall;
}

interface ExecutorSlot {
	readonly executor: Executor;
	readonly provider: DecisionProvider;
	consecutiveBatchFailures: number;
}

interface ModuleSlot {
	readonly module: Module;
	consecutiveFailures: number;
}

const describeError = (
	e: unknown,
): { readonly excType: string; readonly message: string; readonly stack: string } =>
	e instanceof Error
		? { excType: e.name, message: e.message, stack: e.stack ?? "" }
		: { excType: "Error", message: String(e), stack: "" };

const failureInfo = (
	stage: FailureInfo["stage"],
	excType: string,
	message: string,
	at?: LogicalTime,
): FailureInfo => ({
	stage,
	excType,
	message,
	stack: "",
	...(at === undefined ? {} : { at }),
});

const isObject = (v: JsonValue): v is JsonObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

class KernelSimulation implements Simulation {
	readonly runId: RunId;
	readonly scenario: Scenario;
	readonly scenarioHash: string;
	readonly world: World;
	readonly clock: Clock;
	readonly log: EventLog;
	readonly gateway: LLMGateway | undefined;
	readonly logger: Logger;
	private readonly registry: Registry;
	private readonly rootRng: Rng;
	private readonly boundaryRng: Rng;
	private readonly modules: ReadonlyMap<string, Module>;
	private readonly moduleSlots: readonly ModuleSlot[];
	private readonly executorSlots: readonly ExecutorSlot[];
	private readonly providers: ReadonlyMap<string, DecisionProvider>;
	private readonly policy: ActivationPolicy;
	private readonly instruments: readonly Instrument[];
	private readonly lastMeasurements = new Map<string, JsonValue>();
	private tickLogger: Logger;
	private eventRng: Rng;
	private lastEventId: EventId = ZERO_EVENT_ID;
	private incomplete = false;
	private counts = { activated: 0, ok: 0, failed: 0, parseFailures: 0, droppedEffects: 0 };

	constructor(parts: {
		readonly runId: RunId;
		readonly scenario: Scenario;
		readonly scenarioHash: string;
		readonly registry: Registry;
		readonly world: World;
		readonly log: EventLog;
		readonly gateway: LLMGateway | undefined;
		readonly logger: Logger;
		readonly rootRng: Rng;
		readonly modules: ReadonlyMap<string, Module>;
		readonly executors: readonly ExecutorSlot[];
		readonly providers: ReadonlyMap<string, DecisionProvider>;
		readonly policy: ActivationPolicy;
		readonly instruments: readonly Instrument[];
	}) {
		this.runId = parts.runId;
		this.scenario = parts.scenario;
		this.scenarioHash = parts.scenarioHash;
		this.registry = parts.registry;
		this.world = parts.world;
		this.log = parts.log;
		this.gateway = parts.gateway;
		this.logger = parts.logger;
		this.tickLogger = parts.logger;
		this.rootRng = parts.rootRng;
		this.boundaryRng = parts.rootRng.fork(keyFromLabel("boundary"));
		this.eventRng = this.boundaryRng;
		this.modules = parts.modules;
		this.moduleSlots = [...parts.modules.values()].map((module) => ({
			module,
			consecutiveFailures: 0,
		}));
		this.executorSlots = parts.executors;
		this.providers = parts.providers;
		this.policy = parts.policy;
		this.instruments = parts.instruments;
		this.clock = createClock();
	}

	emit(init: EventInit, fields: EventFields = {}): Event {
		this.clock.nextSeq();
		const event = makeEvent(
			{
				eventId: newEventId(this.eventRng),
				runId: this.runId,
				t: this.clock.now,
				seedPath: this.eventRng.path,
				...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
				...(fields.parent === undefined ? {} : { parent: fields.parent }),
				...(fields.provenance === undefined ? {} : { provenance: fields.provenance }),
			},
			init,
		);
		this.log.append(event);
		this.lastEventId = event.eventId;
		return event;
	}

	integrity(): Integrity {
		const c = this.counts;
		return {
			activated: c.activated,
			ok: c.ok,
			failed: c.failed,
			parseFailures: c.parseFailures,
			llmCalls: this.gateway?.ledger().llmCalls ?? 0,
			llmFailures: this.gateway?.failures() ?? 0,
			droppedEffects: c.droppedEffects,
			complete: !this.incomplete && c.activated === c.ok + c.failed,
		};
	}

	cost(): Cost {
		return this.gateway?.ledger() ?? ZERO_COST;
	}

	measurements(): Readonly<Record<string, JsonValue>> {
		const out: Record<string, JsonValue> = {};
		for (const [k, v] of this.lastMeasurements) out[k] = v;
		return out;
	}

	checkpointInput(): CheckpointInput {
		const executors: Record<string, JsonValue> = {};
		for (const slot of this.executorSlots)
			executors[slot.executor.name] = slot.executor.getState();
		const providers: Record<string, JsonValue> = {};
		for (const [name, provider] of this.providers) providers[name] = provider.getState();
		const modules: Record<string, JsonValue> = {};
		for (const [name, module] of this.modules) modules[name] = module.getState();
		return {
			world: this.world,
			clock: { now: this.clock.now },
			executors,
			providers,
			modules,
			rngPaths: { root: [...this.rootRng.path], tick: this.clock.now.tick },
			scenarioHash: this.scenarioHash,
			digest: this.log.digest(),
			lastEventId: this.lastEventId,
		};
	}

	close(): void {
		this.log.close();
	}

	async step(activationOverride?: Activation): Promise<Result<TickReport, FailureInfo>> {
		const tick = this.clock.now.tick;
		const tickRng = this.rootRng.fork(tick);
		this.eventRng = tickRng.fork(keyFromLabel("events"));
		this.tickLogger = this.logger.child({ tick });
		const before = { ...this.counts };
		let runFailure: FailureInfo | undefined;
		this.log.beginTick();
		try {
			const activation =
				activationOverride ??
				this.policy.select(
					this.world,
					this.clock.now,
					tickRng.fork(keyFromLabel("policy")),
				);
			const activationEvent = this.emit({
				kind: "activation",
				payload: {
					policy: this.policy.name,
					agentIds: Object.keys(activation.agents).map(toEntityId),
					modes: activation.agents,
				},
			});
			await this.runDue();

			const effects: Effect[] = [];
			const afterQueue: {
				readonly executor: Executor;
				readonly decisions: readonly Decision[];
			}[] = [];
			const handled = new Set<EntityId>();
			for (const slot of this.executorSlots) {
				const owned = new Set(this.world.ids(slot.executor.entity));
				const ids = Object.entries(activation.agents)
					.filter(([id, mode]) => mode !== "manual" && owned.has(toEntityId(id)))
					.map(([id]) => toEntityId(id));
				for (const id of ids) handled.add(id);
				const outcome = await this.runExecutor(slot, ids, tickRng, activationEvent.eventId);
				effects.push(...outcome.effects);
				afterQueue.push({ executor: slot.executor, decisions: outcome.decisions });
				if (outcome.batchFailed) {
					slot.consecutiveBatchFailures += 1;
					if (slot.consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES)
						runFailure ??= failureInfo(
							"run",
							FAILURE_TYPES.consecutiveBatchFailures,
							`executor '${slot.executor.name}' failed as a whole batch for ${slot.consecutiveBatchFailures} consecutive ticks`,
							this.clock.now,
						);
				} else if (ids.length > 0) slot.consecutiveBatchFailures = 0;
			}

			this.clock.advanceSubstep();
			const manualCalls = activation.manualCalls ?? {};
			for (const [id, mode] of Object.entries(activation.agents)) {
				const agentId = toEntityId(id);
				if (mode === "manual") {
					handled.add(agentId);
					const call = manualCalls[agentId];
					if (call === undefined) {
						this.recordFailure(
							{
								stage: "manual",
								excType: FAILURE_TYPES.unknownAction,
								message: "manual activation without a call",
								retryable: false,
							},
							{ agentId, parent: activationEvent.eventId },
						);
						this.counts.failed += 1;
						continue;
					}
					effects.push(
						...(await this.dispatchManual(
							{ ...call, agentId },
							activationEvent.eventId,
							tickRng,
						)),
					);
				} else if (!handled.has(agentId)) {
					this.recordFailure(
						{
							stage: "activate",
							excType: FAILURE_TYPES.unknownAction,
							message: `no executor owns agent ${agentId}`,
							retryable: false,
						},
						{ agentId, parent: activationEvent.eventId },
					);
					this.counts.failed += 1;
				}
			}
			this.counts.activated += Object.keys(activation.agents).length;

			const report = applyEffects(this.world, effects, this.clock.now);
			const effectEvent = this.emit(
				{ kind: "effect", payload: { effects, rejected: report.rejected } },
				{ parent: activationEvent.eventId, provenance: "kernel" },
			);
			this.recordRejected(report, effectEvent.eventId);

			this.clock.advanceSubstep();
			for (const { executor, decisions } of afterQueue) {
				try {
					await executor.after(decisions, report, this.log);
				} catch (e) {
					const d = describeError(e);
					this.recordFailure(
						{
							stage: "after",
							excType: d.excType,
							message: `executor '${executor.name}': ${d.message}`,
							stack: d.stack,
							retryable: false,
						},
						{ parent: activationEvent.eventId },
					);
				}
			}

			this.clock.advanceSubstep();
			const moduleFailure = await this.runModules(tickRng, activationEvent.eventId);
			runFailure ??= moduleFailure;

			this.clock.advanceSubstep();
			this.measure(tick, activationEvent.eventId);

			this.assertComplete(tick, activation);
		} catch (e) {
			if (e instanceof IncompleteTick) this.incomplete = true;
			this.log.endTick();
			throw e;
		}
		this.log.endTick();
		this.clock.advanceTick();
		this.eventRng = this.boundaryRng;
		const report: TickReport = {
			tick,
			activated: this.counts.activated - before.activated,
			ok: this.counts.ok - before.ok,
			failed: this.counts.failed - before.failed,
		};
		this.tickLogger.debug("tick complete", { ...report });
		if (runFailure !== undefined) {
			this.tickLogger.error("run failed", {
				excType: runFailure.excType,
				message: runFailure.message,
			});
			return err(runFailure);
		}
		return ok(report);
	}

	private async runDue(): Promise<void> {
		for (const fn of this.clock.due()) {
			try {
				await fn();
			} catch (e) {
				const d = describeError(e);
				this.recordFailure({
					stage: "scheduled",
					excType: d.excType,
					message: d.message,
					stack: d.stack,
					retryable: false,
				});
			}
		}
	}

	private moduleObservations(ids: readonly EntityId[]): ModuleObservations {
		const out = new Map<EntityId, JsonObject>();
		for (const module of this.modules.values()) {
			const observed = module.observe(this.world, ids, this.clock.now);
			for (const [id, value] of Object.entries(observed)) {
				if (!isObject(value)) continue;
				const agentId = toEntityId(id);
				out.set(agentId, { ...(out.get(agentId) ?? {}), ...value });
			}
		}
		return out;
	}

	private async runExecutor(
		slot: ExecutorSlot,
		ids: readonly EntityId[],
		tickRng: Rng,
		activationEvent: EventId,
	): Promise<{
		readonly effects: readonly Effect[];
		readonly decisions: readonly Decision[];
		readonly batchFailed: boolean;
	}> {
		const { executor, provider } = slot;
		const label = `executor:${executor.name}`;
		this.clock.advanceSubstep();
		let requests: readonly DecisionRequest[];
		try {
			requests = await executor.observe(
				this.world,
				ids,
				this.clock.now,
				this.log,
				tickRng.fork(keyFromLabel(`${label}:observe`)),
				this.moduleObservations(ids),
			);
		} catch (e) {
			const d = describeError(e);
			this.recordFailure(
				{
					stage: "observe",
					excType: d.excType,
					message: `executor '${executor.name}': ${d.message}`,
					stack: d.stack,
					retryable: false,
				},
				{ parent: activationEvent },
			);
			const outcomes = await this.fallbackAll(
				ids.map((agentId) => ({ agentId, parent: activationEvent })),
				provider.name,
				tickRng,
				label,
			);
			return {
				effects: outcomes.effects,
				decisions: outcomes.decisions,
				batchFailed: ids.length > 0,
			};
		}
		const requested = new Set(requests.map((r) => r.agentId));
		this.counts.failed += ids.filter((id) => !requested.has(id)).length;

		this.clock.advanceSubstep();
		let results: readonly Result<Decision, ProviderFailure>[] | undefined;
		let batchError:
			| { readonly excType: string; readonly message: string; readonly stack?: string }
			| undefined;
		if (requests.length > 0) {
			const graph = this.graph();
			try {
				results = await provider.decide(requests, {
					t: this.clock.now,
					runId: this.runId,
					seedPath: tickRng.path,
					world: this.world,
					log: this.log,
					...(graph === undefined ? {} : { graph }),
				});
			} catch (e) {
				const d = describeError(e);
				batchError = {
					excType: FAILURE_TYPES.providerThrew,
					message: `${d.excType}: ${d.message}`,
					stack: d.stack,
				};
			}
			if (results !== undefined && results.length !== requests.length)
				batchError = {
					excType: FAILURE_TYPES.providerContractViolation,
					message: `provider '${provider.name}' returned ${results.length} results for ${requests.length} requests`,
				};
		}
		if (batchError !== undefined) {
			this.recordFailure(
				{ stage: "decide", ...batchError, retryable: false },
				{ parent: activationEvent },
			);
			const outcomes = await this.fallbackAll(
				requests.map((r) => ({ agentId: r.agentId, parent: r.observationEvent })),
				provider.name,
				tickRng,
				label,
			);
			return { effects: outcomes.effects, decisions: outcomes.decisions, batchFailed: true };
		}

		const effects: Effect[] = [];
		const decisions: Decision[] = [];
		let anyOk = false;
		for (const [i, request] of requests.entries()) {
			const result = results?.[i];
			let outcome: AgentOutcome | undefined;
			if (result !== undefined && result.ok && result.value.agentId === request.agentId) {
				outcome = this.accept(result.value, request, provider.name);
				if (outcome !== undefined) anyOk = true;
			} else {
				const failure: ProviderFailure =
					result === undefined || result.ok
						? {
								agentId: request.agentId,
								reason: "decision is for a different agent",
								retryable: false,
								excType: FAILURE_TYPES.providerContractViolation,
							}
						: result.error;
				this.recordFailure(
					{
						stage: "decide",
						excType: failure.excType ?? "ProviderFailure",
						message: failure.reason,
						retryable: failure.retryable,
					},
					{ agentId: request.agentId, parent: request.observationEvent },
				);
				if (failure.excType !== undefined && PARSE_FAILURE_TYPES.includes(failure.excType))
					this.counts.parseFailures += 1;
				outcome = this.fallback(request.agentId, request.observationEvent, provider.name);
			}
			if (outcome === undefined) continue;
			decisions.push(outcome.decision);
			effects.push(...(await this.resolve(outcome.call, tickRng, label)));
		}
		const executorEffects = await this.executorAct(
			executor,
			decisions,
			tickRng,
			label,
			activationEvent,
		);
		return {
			effects: [...effects, ...executorEffects],
			decisions,
			batchFailed: requests.length > 0 && !anyOk,
		};
	}

	private async executorAct(
		executor: Executor,
		decisions: readonly Decision[],
		tickRng: Rng,
		label: string,
		activationEvent: EventId,
	): Promise<readonly Effect[]> {
		try {
			return await executor.act(decisions, this.resolveContext(tickRng, `${label}:act`));
		} catch (e) {
			const d = describeError(e);
			this.recordFailure(
				{
					stage: "act",
					excType: d.excType,
					message: `executor '${executor.name}': ${d.message}`,
					stack: d.stack,
					retryable: false,
				},
				{ parent: activationEvent },
			);
			return [];
		}
	}

	private accept(
		decision: Decision,
		request: DecisionRequest,
		providerName: string,
	): AgentOutcome | undefined {
		const validated = this.registry.actions.validate({
			agentId: decision.agentId,
			name: decision.action,
			args: decision.args,
			cause: request.observationEvent,
		});
		if (!validated.ok) {
			const message =
				validated.error.kind === "UnknownAction"
					? `unknown action '${validated.error.name}'`
					: `invalid args for '${validated.error.name}': ${validated.error.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`;
			this.recordFailure(
				{
					stage: "validate",
					excType:
						validated.error.kind === "UnknownAction"
							? FAILURE_TYPES.unknownAction
							: FAILURE_TYPES.invalidArgs,
					message,
					retryable: false,
				},
				{ agentId: decision.agentId, parent: request.observationEvent },
			);
			this.counts.parseFailures += 1;
			return this.fallback(decision.agentId, request.observationEvent, providerName);
		}
		const event = this.decisionEvent(decision, providerName, request.observationEvent);
		this.counts.ok += 1;
		return { decision, call: { ...validated.value, cause: event.eventId } };
	}

	private decisionEvent(decision: Decision, providerName: string, parent: EventId): Event {
		const rationaleSha =
			decision.rationale === undefined ? undefined : this.log.putContent(decision.rationale);
		return this.emit(
			{
				kind: "decision",
				payload: {
					action: decision.action,
					args: decision.args,
					...(decision.soft === undefined ? {} : { soft: decision.soft }),
					...(rationaleSha === undefined ? {} : { rationaleSha }),
					provider: providerName,
					parseOk: decision.parseOk,
				},
			},
			{ agentId: decision.agentId, parent, provenance: decision.provenance },
		);
	}

	private fallback(
		agentId: EntityId,
		parent: EventId,
		providerName: string,
	): AgentOutcome | undefined {
		this.counts.failed += 1;
		const def = this.registry.actions.fallback();
		if (def === undefined) {
			this.recordFailure(
				{
					stage: "fallback",
					excType: FAILURE_TYPES.noFallbackAction,
					message: "no fallback action registered",
					retryable: false,
				},
				{ agentId, parent },
			);
			return undefined;
		}
		const decision: Decision = {
			agentId,
			action: def.name,
			args: {},
			provenance: "rule",
			cost: { llmCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, wallMs: 0 },
			parseOk: false,
		};
		const validated = this.registry.actions.validate({
			agentId,
			name: def.name,
			args: {},
			cause: parent,
		});
		if (!validated.ok) {
			this.recordFailure(
				{
					stage: "fallback",
					excType: FAILURE_TYPES.invalidArgs,
					message: `fallback action '${def.name}' rejects empty args`,
					retryable: false,
				},
				{ agentId, parent },
			);
			return undefined;
		}
		const event = this.decisionEvent(decision, providerName, parent);
		return { decision, call: { ...validated.value, cause: event.eventId } };
	}

	private async fallbackAll(
		targets: readonly { readonly agentId: EntityId; readonly parent: EventId }[],
		providerName: string,
		tickRng: Rng,
		label: string,
	): Promise<{ readonly effects: readonly Effect[]; readonly decisions: readonly Decision[] }> {
		const effects: Effect[] = [];
		const decisions: Decision[] = [];
		for (const { agentId, parent } of targets) {
			const outcome = this.fallback(agentId, parent, providerName);
			if (outcome === undefined) continue;
			decisions.push(outcome.decision);
			effects.push(...(await this.resolve(outcome.call, tickRng, label)));
		}
		return { effects, decisions };
	}

	private async dispatchManual(
		call: ActionCall,
		parent: EventId,
		tickRng: Rng,
	): Promise<readonly Effect[]> {
		const validated = this.registry.actions.validate(call);
		if (!validated.ok) {
			this.recordFailure(
				{
					stage: "validate",
					excType:
						validated.error.kind === "UnknownAction"
							? FAILURE_TYPES.unknownAction
							: FAILURE_TYPES.invalidArgs,
					message: `manual call '${call.name}' rejected`,
					retryable: false,
				},
				{ agentId: call.agentId, parent },
			);
			const outcome = this.fallback(call.agentId, parent, MANUAL);
			return outcome === undefined ? [] : this.resolve(outcome.call, tickRng, MANUAL);
		}
		const event = this.emit(
			{
				kind: "decision",
				payload: { action: call.name, args: call.args, provider: MANUAL, parseOk: true },
			},
			{ agentId: call.agentId, parent, provenance: "manual" },
		);
		this.counts.ok += 1;
		return this.resolve({ ...validated.value, cause: event.eventId }, tickRng, MANUAL);
	}

	private async resolve(
		call: ActionCall,
		tickRng: Rng,
		label: string,
	): Promise<readonly Effect[]> {
		const def = this.registry.actions.get(call.name);
		if (def === undefined) return [];
		try {
			return await def.resolve(call, this.resolveContext(tickRng, `${label}:${call.name}`));
		} catch (e) {
			const d = describeError(e);
			this.recordFailure(
				{
					stage: "resolve",
					excType: d.excType,
					message: `action '${call.name}': ${d.message}`,
					stack: d.stack,
					retryable: false,
				},
				{ agentId: call.agentId, parent: call.cause },
			);
			return [];
		}
	}

	private resolveContext(tickRng: Rng, label: string): ResolveContext {
		const rng = tickRng.fork(keyFromLabel(label));
		return {
			world: this.world,
			t: this.clock.now,
			modules: this.modules,
			rng,
			newEventId: () => newEventId(rng),
			newEntityId: () => newEntityId(rng),
		};
	}

	private graph(): GraphView | undefined {
		for (const module of this.modules.values())
			if (module.graph !== undefined) return module.graph();
		return undefined;
	}

	private async runModules(
		tickRng: Rng,
		activationEvent: EventId,
	): Promise<FailureInfo | undefined> {
		let failure: FailureInfo | undefined;
		const concurrent = this.moduleSlots.filter((s) => s.module.concurrencySafe);
		const serial = this.moduleSlots.filter((s) => !s.module.concurrencySafe);
		const stepped = await Promise.all(
			concurrent.map((slot) => this.stepModule(slot, tickRng, activationEvent)),
		);
		for (const [i, slot] of concurrent.entries()) {
			const effects = stepped[i];
			if (effects !== undefined) this.applyModuleEffects(slot, effects, activationEvent);
			failure ??= this.moduleFailure(slot);
		}
		for (const slot of serial) {
			const effects = await this.stepModule(slot, tickRng, activationEvent);
			if (effects !== undefined) this.applyModuleEffects(slot, effects, activationEvent);
			failure ??= this.moduleFailure(slot);
		}
		return failure;
	}

	private async stepModule(
		slot: ModuleSlot,
		tickRng: Rng,
		activationEvent: EventId,
	): Promise<readonly Effect[] | undefined> {
		try {
			const effects = await slot.module.step(
				this.world,
				this.clock.now,
				tickRng.fork(keyFromLabel(`module:${slot.module.name}`)),
			);
			return effects;
		} catch (e) {
			const d = describeError(e);
			slot.consecutiveFailures += 1;
			this.recordFailure(
				{
					stage: "module",
					excType: FAILURE_TYPES.moduleStepFailed,
					message: `module '${slot.module.name}': ${d.excType}: ${d.message}`,
					stack: d.stack,
					retryable: false,
				},
				{ parent: activationEvent },
			);
			return undefined;
		}
	}

	private applyModuleEffects(
		slot: ModuleSlot,
		effects: readonly Effect[],
		activationEvent: EventId,
	): void {
		slot.consecutiveFailures = 0;
		this.clock.nextSeq();
		const moduleEvent = newEventId(this.eventRng);
		const t = this.clock.now;
		const stamped = effects.map((e) => ({ ...e, cause: moduleEvent }));
		const report = applyEffects(this.world, stamped, t);
		const event = makeEvent(
			{
				eventId: moduleEvent,
				runId: this.runId,
				t,
				seedPath: this.eventRng.path,
				parent: activationEvent,
				provenance: "kernel",
			},
			{
				kind: "module_step",
				payload: {
					module: slot.module.name,
					summary: {
						effects: stamped.length,
						applied: report.applied,
						rejected: report.rejected.length,
					},
				},
			},
		);
		this.log.append(event);
		this.lastEventId = event.eventId;
		this.recordRejected(report, moduleEvent);
	}

	private moduleFailure(slot: ModuleSlot): FailureInfo | undefined {
		if (slot.consecutiveFailures < MAX_CONSECUTIVE_MODULE_FAILURES) return undefined;
		return failureInfo(
			"run",
			FAILURE_TYPES.consecutiveModuleFailures,
			`module '${slot.module.name}' failed ${slot.consecutiveFailures} consecutive ticks`,
			this.clock.now,
		);
	}

	private measure(tick: number, activationEvent: EventId): void {
		for (const instrument of this.instruments) {
			if (tick % instrument.every !== 0) continue;
			try {
				const raw = instrument.metric.compute(this.world, this.log, this.runId);
				const value: JsonValue = typeof raw === "number" ? raw : [...raw];
				this.lastMeasurements.set(instrument.name, value);
				this.emit(
					{
						kind: "measurement",
						payload: { instrument: instrument.kind, name: instrument.name, value },
					},
					{ parent: activationEvent, provenance: "kernel" },
				);
			} catch (e) {
				const d = describeError(e);
				this.recordFailure(
					{
						stage: "measure",
						excType: d.excType,
						message: `instrument '${instrument.name}': ${d.message}`,
						stack: d.stack,
						retryable: false,
					},
					{ parent: activationEvent },
				);
			}
		}
	}

	private assertComplete(tick: number, activation: Activation): void {
		const decisions = new Map<string, number>();
		const failures = new Set<string>();
		for (const e of this.log.query({ tick, kind: ["decision", "failure"] })) {
			if (e.agentId === undefined) continue;
			if (e.kind === "decision")
				decisions.set(e.agentId, (decisions.get(e.agentId) ?? 0) + 1);
			else failures.add(e.agentId);
		}
		for (const id of Object.keys(activation.agents)) {
			const n = decisions.get(id) ?? 0;
			if (n > 1) throw new IncompleteTick(tick, `agent ${id} has ${n} decisions`);
			if (n === 0 && !failures.has(id))
				throw new IncompleteTick(tick, `agent ${id} has neither a decision nor a failure`);
		}
	}

	private recordRejected(report: EffectReport, parent: EventId): void {
		this.counts.droppedEffects += report.rejected.length;
		for (const { effect, reason } of report.rejected)
			this.recordFailure(
				{
					stage: "apply",
					excType: FAILURE_TYPES.effectRejected,
					message: `${effect.op}: ${reason}`,
					retryable: false,
				},
				{ parent, ...("id" in effect ? { agentId: effect.id } : {}) },
			);
	}

	private recordFailure(
		payload: {
			readonly stage: string;
			readonly excType: string;
			readonly message: string;
			readonly stack?: string;
			readonly retryable: boolean;
		},
		fields: EventFields = {},
	): void {
		this.emit({ kind: "failure", payload }, { ...fields, provenance: "kernel" });
		this.tickLogger.error(payload.message, {
			stage: payload.stage,
			excType: payload.excType,
			retryable: payload.retryable,
			...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
		});
	}
}

const instantiateError = (excType: string, message: string): Result<never, FailureInfo> =>
	err(failureInfo("instantiate", excType, message));

const resolvedScenario = (scenario: Scenario, deps: SimulationDeps): Scenario => {
	const baseDir = deps.baseDir ?? process.cwd();
	const source = scenario.population.source;
	const population =
		source.kind === "synthetic"
			? scenario.population
			: {
					...scenario.population,
					source: { ...source, path: resolve(baseDir, source.path) },
				};
	const recordDir = resolve(baseDir, scenario.llm.recordDir ?? join(deps.outDir, RECORDINGS_DIR));
	return { ...scenario, population, llm: { ...scenario.llm, recordDir } };
};

export const createSimulation = (
	scenario: Scenario,
	registry: Registry,
	deps: SimulationDeps,
): Result<Simulation, FailureInfo> => {
	const runId = makeRunId(scenario.scenarioId, scenario.replicationId);
	const logger = deps.logger.child({ runId });
	const effective = resolvedScenario(scenario, deps);
	const world = createWorld();
	const rootRng = rngFromSeed(effective.seed, effective.seedPath);
	let gateway = deps.gateway;
	if (gateway === undefined && deps.createGateway !== undefined) {
		try {
			gateway = deps.createGateway(effective.llm, logger);
		} catch (e) {
			return instantiateError("GatewayConfig", e instanceof Error ? e.message : String(e));
		}
	}
	const ctx: PluginContext = {
		scenario: effective,
		registry,
		logger,
		...(gateway === undefined ? {} : { gateway }),
	};

	const modules = new Map<string, Module>();
	for (const spec of effective.modules) {
		const created = registry.modules.create(spec, ctx);
		if (!created.ok)
			return instantiateError(
				"ModuleCreate",
				`module '${spec.kind}': ${JSON.stringify(created.error)}`,
			);
		const module = created.value;
		if (modules.has(module.name))
			return instantiateError("ModuleCreate", `duplicate module name '${module.name}'`);
		const declared = module.declare(world);
		if (!declared.ok)
			return instantiateError(
				"ModuleDeclare",
				`module '${module.name}': ${JSON.stringify(declared.error)}`,
			);
		for (const action of module.actions()) {
			const registered = registry.actions.register(action);
			if (!registered.ok)
				return instantiateError(
					"ActionRegister",
					`module '${module.name}': ${JSON.stringify(registered.error)}`,
				);
		}
		modules.set(module.name, module);
	}
	for (const name of registry.actions.names()) {
		const def = registry.actions.get(name);
		const missing = (def?.requiresModules ?? []).filter((m) => !modules.has(m));
		if (missing.length > 0)
			return instantiateError(
				"MissingModules",
				`action '${name}' requires modules: ${missing.join(", ")}`,
			);
	}

	const population = buildPopulation(
		effective.population,
		world,
		rootRng.fork(keyFromLabel("population")),
	);
	if (!population.ok) return instantiateError(population.error.kind, population.error.message);

	const providers = new Map<string, DecisionProvider>();
	const executors: ExecutorSlot[] = [];
	for (const spec of effective.executors) {
		const created = registry.executors.create(spec, ctx);
		if (!created.ok)
			return instantiateError(
				"ExecutorCreate",
				`executor '${spec.kind}': ${JSON.stringify(created.error)}`,
			);
		const executor = created.value;
		const declared = executor.declare(world);
		if (!declared.ok)
			return instantiateError(
				"ExecutorDeclare",
				`executor '${executor.name}': ${JSON.stringify(declared.error)}`,
			);
		let provider = providers.get(executor.provider);
		if (provider === undefined) {
			const providerSpec = effective.providers[executor.provider];
			if (providerSpec === undefined)
				return instantiateError(
					"UnknownProvider",
					`executor '${executor.name}' refers to unknown provider '${executor.provider}'`,
				);
			const built = registry.providers.create(
				{ ...providerSpec, name: providerSpec.name ?? executor.provider },
				ctx,
			);
			if (!built.ok)
				return instantiateError(
					"ProviderCreate",
					`provider '${executor.provider}': ${JSON.stringify(built.error)}`,
				);
			provider = built.value;
			provider.reset(effective.seedPath);
			providers.set(executor.provider, provider);
		}
		executors.push({ executor, provider, consecutiveBatchFailures: 0 });
	}

	const policy = registry.policies.create(effective.policy, ctx);
	if (!policy.ok)
		return instantiateError(
			"PolicyCreate",
			`policy '${effective.policy.kind}': ${JSON.stringify(policy.error)}`,
		);

	const instruments: Instrument[] = [];
	for (const spec of effective.instruments) {
		const created = registry.metrics.create(spec, ctx);
		if (!created.ok)
			return instantiateError(
				"InstrumentCreate",
				`instrument '${spec.kind}': ${JSON.stringify(created.error)}`,
			);
		instruments.push({
			name: spec.name ?? spec.kind,
			kind: spec.kind,
			every: spec.every ?? 1,
			metric: created.value,
		});
	}

	logger.info("simulation assembled", {
		agents: world.count(AGENT_ENTITY),
		modules: [...modules.keys()],
		executors: executors.map((s) => s.executor.name),
		providers: [...providers.keys()],
		policy: policy.value.name,
	});
	const log = deps.log ?? openSqliteEventLog(eventLogPath(deps.outDir));
	return ok(
		new KernelSimulation({
			runId,
			scenario: effective,
			scenarioHash: scenarioHash(scenario),
			registry,
			world,
			log,
			gateway,
			logger,
			rootRng,
			modules,
			executors,
			providers,
			policy: policy.value,
			instruments,
		}),
	);
};
