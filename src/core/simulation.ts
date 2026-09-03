// The tick loop. One tick is: activation event, due callbacks, per executor observe -> decide
// -> validate or fallback -> resolve, manual calls, one applyEffects with its effect event,
// after hooks, module steps, measurements, provider audits, then the completeness assertion.
// Every phase has its own substep, every failure becomes a failure event, and the loop only
// throws IncompleteTick, which marks a kernel bug.
// tick 循环。一个 tick 依次是：activation 事件、到期回调、每个执行体的 observe -> decide -> 校验或
// 回退 -> 解析、手动调用、一次 applyEffects 及其 effect 事件、after 钩子、模块 step、测量、提供者审计，
// 最后是完成断言。每个阶段占一个 substep，每个失败都写成 failure 事件，循环只会抛出标记内核 bug 的
// IncompleteTick。

import { join, resolve } from "node:path";
import type { Logger } from "../logging/logger";
import { z } from "zod";
import { ActionRejected } from "./actions";
import { observableLog, type EventHandler } from "./bus";
import type { CheckpointInput, CheckpointState } from "./checkpoint";
import { createClock } from "./clock";
import { makeEvent, type EventInit } from "./events";
import { FAILURE_TYPES, PARSE_FAILURE_TYPES } from "./failures";
import { ZERO_EVENT_ID, makeRunId, newEntityId, newEventId, toEntityId } from "./ids";
import { eventLogPath, openSqliteEventLog } from "./log";
import { describeParamError, resolveScenarioParams } from "./params";
import { AGENT_ENTITY, buildPopulation } from "./population";
import { bareInterviewRequests, parseAnswers } from "./questionnaire";
import { selectAgents } from "./selector";
import type {
	ActivationPolicy,
	Clock,
	DecisionProvider,
	EventLog,
	Executor,
	GraphView,
	LLMFailure,
	LLMGateway,
	Metric,
	Module,
	ModuleObservations,
	PluginContext,
	PluginError,
	Questionnaire,
	Registry,
	ResolveContext,
	Rng,
	World,
} from "./protocols";
import { applyEffects } from "./resolver";
import { err, ok } from "./result";
import { keyFromLabel, rngFromSeed } from "./rng";
import { overrideScenario, scenarioHash } from "./scenario";
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
	Selector,
} from "./types";
import { createWorld } from "./world";

export const RECORDINGS_DIR = "recordings";
export const PROVIDER_INSTRUMENT_PREFIX = "provider:";
export const PROVIDER_METRIC_PREFIX = "provider.";
export const MAX_CONSECUTIVE_BATCH_FAILURES = 3;
export const MAX_CONSECUTIVE_MODULE_FAILURES = 3;
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

export interface GatewayOptions {
	readonly logger: Logger;
	readonly onFailure: (failure: LLMFailure) => void;
}

// Exactly one gateway per run. The factory is injected so core never imports llm/; failures
// the gateway reports flow back through onFailure as failure events.
// 每个 run 恰好一个网关。工厂由外部注入，core 因此不 import llm/；网关报告的失败经 onFailure
// 回流成 failure 事件。
export type GatewayFactory = (spec: LLMSpec, opts: GatewayOptions) => LLMGateway;

export interface SimulationDeps {
	readonly outDir: string;
	readonly logger: Logger;
	readonly createGateway: GatewayFactory;
	readonly log?: EventLog;
	readonly onEvent?: EventHandler;
	readonly baseDir?: string;
	readonly resumeFrom?: CheckpointState;
}

// boundaryEvents counts ids drawn from the boundary rng before the checkpoint; replaying that
// many draws on resume realigns boundary event ids with the original run.
// boundaryEvents 记录检查点之前从边界 rng 抽取的 id 数量；续跑时重放同样多次抽取，边界事件 id
// 与原始运行对齐。
export interface ResumePoint {
	readonly now: LogicalTime;
	readonly lastEventId: EventId;
	readonly boundaryEvents: number;
}

const RngPathsSchema = z.object({ boundaryEvents: z.number().int().nonnegative().default(0) });

export const resumePointOf = (checkpoint: CheckpointState): ResumePoint => {
	const parsed = RngPathsSchema.safeParse(checkpoint.rngPaths);
	return {
		now: checkpoint.clock.now,
		lastEventId: checkpoint.lastEventId,
		boundaryEvents: parsed.success ? parsed.data.boundaryEvents : 0,
	};
};

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
	// Boundary steps (questionnaires, interventions) record at the tick boundary without
	// consuming a sequence number, so a checkpoint can still follow them.
	// 边界步骤（问卷、干预）记在 tick 边界且不消耗序号，检查点因此仍可紧随其后。
	readonly atBoundary?: boolean;
}

// Paths an intervention may change while a run is in flight
// 干预在运行途中允许修改的路径
const HOT_PREFIXES: readonly string[] = ["params.", "prompt.", "policy.options."];
const INTERVENTION_KEY = "intervention";
const INSTRUCTION_KEY = "instruction";

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
	readonly gateway: LLMGateway;
	readonly logger: Logger;
	initialize(): Promise<Result<void, FailureInfo>>;
	step(activationOverride?: Activation): Promise<Result<TickReport, FailureInfo>>;
	questionnaire(name: string, targets: Selector | undefined, stepIndex: number): Promise<void>;
	intervene(arm: string, instruction: string | undefined, stepIndex: number): Promise<void>;
	emit(init: EventInit, fields?: EventFields): Event;
	integrity(): Integrity;
	cost(): Cost;
	measurements(): Readonly<Record<string, JsonValue>>;
	checkpointInput(): CheckpointInput;
	close(): void;
}

interface AgentOutcome {
	readonly decision: Decision;
	readonly call?: ActionCall;
}

// Decisions of one batch executor in one tick, folded into a single decision_batch event.
// The event id is drawn up front so action calls and act effects can name it as their cause.
// 一个批量执行体在一个 tick 内的决策，折叠成单条 decision_batch 事件。事件 id 预先抽取，动作调用与 act 效果才能以它为 cause。
interface DecisionBatch {
	readonly eventId: EventId;
	readonly executor: string;
	readonly provider: string;
	readonly agentIds: EntityId[];
	readonly actions: string[];
	readonly provenances: Map<Decision["provenance"], number>;
	parseFailures: number;
	cost: Cost;
}

const addCost = (a: Cost, b: Cost): Cost => ({
	llmCalls: a.llmCalls + b.llmCalls,
	promptTokens: a.promptTokens + b.promptTokens,
	completionTokens: a.completionTokens + b.completionTokens,
	cachedTokens: a.cachedTokens + b.cachedTokens,
	wallMs: a.wallMs + b.wallMs,
});

// Most frequent provenance in the batch; ties go to the one seen first
// 批次中最常见的来源；并列时取先出现者
const majorityProvenance = (
	tally: ReadonlyMap<Decision["provenance"], number>,
): Decision["provenance"] => {
	let best: { readonly provenance: Decision["provenance"]; readonly n: number } | undefined;
	for (const [provenance, n] of tally)
		if (best === undefined || n > best.n) best = { provenance, n };
	return best?.provenance ?? "rule";
};

interface ExecutorSlot {
	executor: Executor;
	readonly provider: DecisionProvider;
	consecutiveBatchFailures: number;
}

// Shared with the plugin context so plugins that keep `ctx` see the scenario as intervened.
// 与插件上下文共享，保留 `ctx` 的插件因此能看到干预后的场景。
interface ScenarioHolder {
	scenario: Scenario;
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

export type ModuleStepSummary = {
	readonly effects: readonly Effect[];
	readonly applied: number;
	readonly rejected: readonly { readonly effect: Effect; readonly reason: string }[];
};

export const moduleStepSummary = (
	effects: readonly Effect[],
	report: EffectReport,
): ModuleStepSummary => ({
	effects,
	applied: report.applied,
	rejected: report.rejected.map((r) => ({ effect: r.effect, reason: r.reason })),
});

class KernelSimulation implements Simulation {
	readonly runId: RunId;
	readonly scenarioHash: string;
	readonly world: World;
	readonly clock: Clock;
	readonly log: EventLog;
	readonly gateway: LLMGateway;
	readonly logger: Logger;
	private readonly registry: Registry;
	private readonly ctx: PluginContext;
	private readonly holder: ScenarioHolder;
	private declared: Scenario;
	// Event ids come from a per-tick fork inside a tick and from boundaryRng between ticks, so
	// boundary events keep stable ids across resume however many ticks ran before them.
	// 事件 id 在 tick 内取自按 tick 派生的 fork，tick 之间取自 boundaryRng，边界事件的 id 因此在续跑后
	// 保持稳定，与之前跑了多少 tick 无关。
	private readonly rootRng: Rng;
	private readonly boundaryRng: Rng;
	private readonly modules: ReadonlyMap<string, Module>;
	private readonly moduleSlots: readonly ModuleSlot[];
	private readonly executorSlots: ExecutorSlot[];
	private readonly providers: ReadonlyMap<string, DecisionProvider>;
	private readonly providerNames: ReadonlyMap<DecisionProvider, string>;
	private readonly downstreams: ReadonlyMap<string, ReadonlySet<string>>;
	private readonly decided = new Set<string>();
	private policy: ActivationPolicy;
	private readonly instruments: readonly Instrument[];
	private readonly questionnaires: ReadonlyMap<string, Questionnaire>;
	private readonly lastMeasurements = new Map<string, JsonValue>();
	private readonly pendingInstructions = new Map<EntityId, string>();
	private tickLogger: Logger;
	private eventRng: Rng;
	private lastEventId: EventId = ZERO_EVENT_ID;
	private initialized = false;
	private boundaryEvents = 0;
	private incomplete = false;
	private gatewayFailures = 0;
	private counts = {
		activated: 0,
		ok: 0,
		failed: 0,
		parseFailures: 0,
		droppedEffects: 0,
		rejectedActions: 0,
	};

	constructor(parts: {
		readonly runId: RunId;
		readonly holder: ScenarioHolder;
		readonly declared: Scenario;
		readonly ctx: PluginContext;
		readonly scenarioHash: string;
		readonly registry: Registry;
		readonly world: World;
		readonly log: EventLog;
		readonly gateway: LLMGateway;
		readonly logger: Logger;
		readonly rootRng: Rng;
		readonly modules: ReadonlyMap<string, Module>;
		readonly executors: readonly ExecutorSlot[];
		readonly providers: ReadonlyMap<string, DecisionProvider>;
		readonly downstreams: ReadonlyMap<string, ReadonlySet<string>>;
		readonly policy: ActivationPolicy;
		readonly instruments: readonly Instrument[];
		readonly questionnaires: ReadonlyMap<string, Questionnaire>;
		readonly resume?: ResumePoint;
	}) {
		this.runId = parts.runId;
		this.holder = parts.holder;
		this.declared = parts.declared;
		this.ctx = parts.ctx;
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
		this.executorSlots = [...parts.executors];
		this.providers = parts.providers;
		this.providerNames = new Map(
			[...parts.providers].map(([name, provider]) => [provider, name] as const),
		);
		this.downstreams = parts.downstreams;
		this.policy = parts.policy;
		this.instruments = parts.instruments;
		this.questionnaires = parts.questionnaires;
		this.clock = createClock(parts.resume?.now);
		if (parts.resume !== undefined) {
			this.lastEventId = parts.resume.lastEventId;
			this.initialized = true;
			for (let i = 0; i < parts.resume.boundaryEvents; i += 1) this.nextEventId();
		}
	}

	get scenario(): Scenario {
		return this.holder.scenario;
	}

	emit(init: EventInit, fields: EventFields = {}): Event {
		return this.emitAs(this.nextEventId(), init, fields);
	}

	// Boundary events do not consume a seq: they sit at (tick, 0, n) beside the checkpoint, and
	// assertComplete ignores substep 0.
	// 边界事件不消耗 seq：它们与检查点一起位于 (tick, 0, n)，assertComplete 忽略 substep 0。
	private emitAs(eventId: EventId, init: EventInit, fields: EventFields = {}): Event {
		if (fields.atBoundary !== true) this.clock.nextSeq();
		const event = makeEvent(
			{
				eventId,
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

	// complete needs both: no tick threw IncompleteTick, and every activation was settled as ok
	// or failed.
	// complete 需要两个条件同时成立：没有 tick 抛出 IncompleteTick，且每次激活都以 ok 或 failed 结清。
	integrity(): Integrity {
		const c = this.counts;
		return {
			activated: c.activated,
			ok: c.ok,
			failed: c.failed,
			parseFailures: c.parseFailures,
			llmCalls: this.gateway.ledger().llmCalls,
			llmFailures: this.gatewayFailures,
			droppedEffects: c.droppedEffects,
			rejectedActions: c.rejectedActions,
			complete: !this.incomplete && c.activated === c.ok + c.failed,
		};
	}

	cost(): Cost {
		return this.gateway.ledger();
	}

	recordGatewayFailure(failure: LLMFailure): void {
		this.gatewayFailures += 1;
		this.recordFailure(
			{
				stage: "llm",
				excType: failure.excType,
				message: failure.message,
				retryable: failure.retryable,
			},
			{ provenance: "llm" },
		);
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
			rngPaths: {
				root: [...this.rootRng.path],
				tick: this.clock.now.tick,
				boundaryEvents: this.boundaryEvents,
			},
			scenarioHash: this.scenarioHash,
			digest: this.log.digest(),
			lastEventId: this.lastEventId,
		};
	}

	close(): void {
		this.log.close();
	}

	// Module initialisation runs once before tick 0; its module_step events sit at (0,0,0)
	// without consuming seq, so the tick 0 checkpoint captures the initialised world and replay
	// skips them through lastEventId.
	// 模块初始化在 tick 0 之前执行一次；其 module_step 事件位于 (0,0,0) 且不消耗 seq，tick 0 检查点
	// 因此捕获已初始化的世界，回放靠 lastEventId 跳过它们。
	async initialize(): Promise<Result<void, FailureInfo>> {
		if (this.initialized) return ok(undefined);
		this.initialized = true;
		for (const slot of this.moduleSlots) {
			const { module } = slot;
			if (module.initialize === undefined) continue;
			let effects: readonly Effect[];
			try {
				effects = await module.initialize(
					this.world,
					this.rootRng.fork(keyFromLabel(`module:${module.name}:initialize`)),
				);
			} catch (e) {
				const d = describeError(e);
				const message = `module '${module.name}': ${d.excType}: ${d.message}`;
				this.recordFailure({
					stage: "initialize",
					excType: FAILURE_TYPES.moduleInitializeFailed,
					message,
					stack: d.stack,
					retryable: false,
				});
				return err(
					failureInfo(
						"instantiate",
						FAILURE_TYPES.moduleInitializeFailed,
						message,
						this.clock.now,
					),
				);
			}
			this.applyModuleEffects(slot, effects, undefined, false);
		}
		return ok(undefined);
	}

	// All randomness of a tick derives from rootRng.fork(tick): policy, executors, modules and
	// event ids each take a labelled fork, so a tick is reproducible in isolation and resume
	// needs no rng state.
	// 一个 tick 的全部随机性都派生自 rootRng.fork(tick)：策略、执行体、模块与事件 id 各取一个带标签的
	// fork，单个 tick 可独立复现，续跑不需要保存 rng 状态。
	async step(activationOverride?: Activation): Promise<Result<TickReport, FailureInfo>> {
		const initialized = await this.initialize();
		if (!initialized.ok) return initialized;
		const tick = this.clock.now.tick;
		const tickRng = this.rootRng.fork(tick);
		this.eventRng = tickRng.fork(keyFromLabel("events"));
		this.tickLogger = this.logger.child({ tick });
		const before = { ...this.counts };
		let runFailure: FailureInfo | undefined;
		this.decided.clear();
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
			// Each executor takes the activated agents of its entity that it owns and that are
			// not manual. An agent no executor owns becomes a failure rather than a silent skip,
			// which keeps the completeness assertion honest. Three consecutive whole-batch
			// failures fail the run; a tick with nothing to decide neither counts nor resets.
			// 每个执行体取其实体中由它拥有且非 manual 的激活 agent。没有执行体拥有的 agent 记为失败而不是
			// 静默跳过，完成断言因此可信。连续三次整批失败使 run 失败；无事可决的 tick 既不计数也不清零。
			const afterQueue: {
				readonly executor: Executor;
				readonly decisions: readonly Decision[];
			}[] = [];
			const handled = new Set<EntityId>();
			for (const slot of this.executorSlots) {
				const { executor } = slot;
				const owned = new Set(
					this.world
						.ids(executor.entity)
						.filter((id) => executor.owns?.(this.world, id) ?? true),
				);
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

			// All executor and action effects of the tick land in one applyEffects call, so
			// same-tick conflicts are settled by merge rules rather than by executor order.
			// 本 tick 全部执行体与动作的效果在一次 applyEffects 中落地，同 tick 冲突由 merge 规则裁决，
			// 而不是由执行体顺序决定。
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
			this.auditProviders(activationEvent.eventId, tickRng);

			// The tick batch is committed even when the assertion throws, so the log shows what
			// happened; IncompleteTick additionally marks integrity incomplete.
			// 断言抛出时 tick 事务照样提交，日志里能看到发生了什么；IncompleteTick 另外把 integrity 标为不完整。
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

	// Module observations merge per agent by key. A pending intervention instruction rides
	// along under observation.intervention.instruction and is consumed once.
	// 模块观察按 agent 逐键合并。待投递的干预指令附在 observation.intervention.instruction 下，
	// 投递一次即消耗。
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
		if (this.pendingInstructions.size > 0)
			for (const id of ids) {
				const instruction = this.pendingInstructions.get(id);
				if (instruction === undefined) continue;
				this.pendingInstructions.delete(id);
				out.set(id, {
					...(out.get(id) ?? {}),
					[INTERVENTION_KEY]: { [INSTRUCTION_KEY]: instruction },
				});
			}
		return out;
	}

	// Boundary steps

	// Questionnaires run at the tick boundary: events carry atBoundary so no seq is consumed,
	// and agents are routed to the executor that owns them so persona-aware interviews use
	// the executor's own components.
	// 问卷在 tick 边界执行：事件带 atBoundary、不消耗 seq；agent 被路由到拥有它的执行体，
	// 感知 persona 的访谈因此使用执行体自己的组件。
	async questionnaire(
		name: string,
		targets: Selector | undefined,
		stepIndex: number,
	): Promise<void> {
		const boundary = { atBoundary: true, provenance: "kernel" as const };
		const q = this.questionnaires.get(name);
		if (q === undefined) {
			this.recordFailure(
				{
					stage: "questionnaire",
					excType: FAILURE_TYPES.unknownQuestionnaire,
					message: `questionnaire '${name}' is not declared in instruments`,
					retryable: false,
				},
				boundary,
			);
			return;
		}
		const rng = this.rootRng.fork(keyFromLabel(`questionnaire:${stepIndex}`));
		const ids =
			targets === undefined
				? this.world.ids(AGENT_ENTITY)
				: selectAgents(this.world, targets, rng.fork(keyFromLabel("select")));
		if (ids.length === 0)
			this.recordFailure(
				{
					stage: "questionnaire",
					excType: FAILURE_TYPES.emptySelection,
					message: `questionnaire '${name}' selected no agents`,
					retryable: false,
				},
				boundary,
			);
		const handled = new Set<EntityId>();
		for (const slot of this.executorSlots) {
			const { executor } = slot;
			const owned = ids.filter(
				(id) =>
					!handled.has(id) &&
					this.world.row(executor.entity, id) !== undefined &&
					(executor.owns?.(this.world, id) ?? true),
			);
			if (owned.length === 0) continue;
			for (const id of owned) handled.add(id);
			await this.interview(
				q,
				slot,
				owned,
				rng.fork(keyFromLabel(`executor:${executor.name}`)),
			);
		}
		for (const id of ids)
			if (!handled.has(id))
				this.recordFailure(
					{
						stage: "questionnaire",
						excType: FAILURE_TYPES.noOwner,
						message: `no executor owns agent ${id}`,
						retryable: false,
					},
					{ ...boundary, agentId: id },
				);
		this.logger.info("questionnaire complete", {
			name,
			targets: ids.length,
			questions: q.questions.length,
		});
	}

	// Interview decisions carry provenance interview. With entersMemory false the observation
	// and decision events drop agentId so memory components cannot see them, and after() is
	// skipped; answers still become measurement events with agentId and parent.
	// 访谈决策的来源为 interview。entersMemory 为 false 时 observation 与 decision 事件不带 agentId，
	// 记忆组件看不到它们，且跳过 after()；答案仍写成带 agentId 与 parent 的 measurement 事件。
	private async interview(
		q: Questionnaire,
		slot: ExecutorSlot,
		ids: readonly EntityId[],
		rng: Rng,
	): Promise<void> {
		const { executor, provider } = slot;
		const t = this.clock.now;
		const boundary = { atBoundary: true };
		const requests =
			executor.interview === undefined
				? bareInterviewRequests(
						this.world,
						executor.entity,
						ids,
						t,
						this.log,
						rng.fork(keyFromLabel("observe")),
						this.runId,
						q,
					)
				: await executor.interview(
						this.world,
						ids,
						t,
						this.log,
						rng.fork(keyFromLabel("observe")),
						q,
					);
		let results: readonly Result<Decision, ProviderFailure>[] = [];
		const graph = this.graph();
		try {
			results = await provider.decide(requests, {
				t,
				runId: this.runId,
				seedPath: rng.path,
				world: this.world,
				log: this.log,
				...(graph === undefined ? {} : { graph }),
			});
		} catch (e) {
			const d = describeError(e);
			this.recordFailure(
				{
					stage: "interview",
					excType: FAILURE_TYPES.providerThrew,
					message: `${d.excType}: ${d.message}`,
					stack: d.stack,
					retryable: false,
				},
				boundary,
			);
		}
		const decisions: Decision[] = [];
		for (const [i, request] of requests.entries()) {
			const result = results[i];
			const attribution = q.entersMemory ? { agentId: request.agentId } : {};
			if (result === undefined || !result.ok || result.value.agentId !== request.agentId) {
				const failure: ProviderFailure =
					result === undefined || result.ok
						? {
								agentId: request.agentId,
								reason:
									result === undefined
										? "provider returned no result"
										: "decision is for a different agent",
								retryable: false,
								excType: FAILURE_TYPES.providerContractViolation,
							}
						: result.error;
				this.recordFailure(
					{
						stage: "interview",
						excType: failure.excType ?? "ProviderFailure",
						message: failure.reason,
						retryable: failure.retryable,
					},
					{ ...boundary, agentId: request.agentId, parent: request.observationEvent },
				);
				continue;
			}
			const decision = result.value;
			const rationaleSha =
				decision.rationale === undefined
					? undefined
					: this.log.putContent(decision.rationale);
			const event = this.emit(
				{
					kind: "decision",
					payload: {
						action: decision.action,
						args: decision.args,
						...(decision.soft === undefined ? {} : { soft: decision.soft }),
						...(rationaleSha === undefined ? {} : { rationaleSha }),
						provider: provider.name,
						parseOk: decision.parseOk,
					},
				},
				{
					...boundary,
					...attribution,
					parent: request.observationEvent,
					provenance: "interview",
				},
			);
			const parsed = parseAnswers(q, decision.args);
			for (const [questionId, value] of Object.entries(parsed.answers))
				this.emit(
					{
						kind: "measurement",
						payload: { instrument: q.name, name: questionId, value },
					},
					{
						...boundary,
						agentId: request.agentId,
						parent: event.eventId,
						provenance: "interview",
					},
				);
			for (const issue of parsed.issues)
				this.recordFailure(
					{
						stage: "interview",
						excType: FAILURE_TYPES.invalidAnswer,
						message: `question '${issue.questionId}': ${issue.reason}`,
						retryable: false,
					},
					{ ...boundary, agentId: request.agentId, parent: event.eventId },
				);
			decisions.push({ ...decision, provenance: "interview" });
		}
		if (!q.entersMemory || decisions.length === 0) return;
		try {
			await executor.after(decisions, { applied: 0, rejected: [] }, this.log);
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
				boundary,
			);
		}
	}

	async intervene(
		arm: string,
		instruction: string | undefined,
		stepIndex: number,
	): Promise<void> {
		const boundary = { atBoundary: true, provenance: "kernel" as const };
		const found = this.scenario.hypothesis?.arms.find((a) => a.name === arm);
		if (found === undefined) {
			this.emit({ kind: "intervention", payload: { stepIndex, arm, targets: [] } }, boundary);
			this.recordFailure(
				{
					stage: "intervene",
					excType: FAILURE_TYPES.unknownArm,
					message: `arm '${arm}' is not declared in the hypothesis`,
					retryable: false,
				},
				boundary,
			);
			return;
		}
		for (const [path, value] of Object.entries(found.overrides))
			this.applyHotOverride(path, value, boundary);
		const targets =
			found.selection === undefined
				? this.world.ids(AGENT_ENTITY)
				: selectAgents(
						this.world,
						found.selection,
						this.rootRng.fork(keyFromLabel(`intervene:${stepIndex}`)),
					);
		this.emit({ kind: "intervention", payload: { stepIndex, arm, targets } }, boundary);
		if (targets.length === 0)
			this.recordFailure(
				{
					stage: "intervene",
					excType: FAILURE_TYPES.emptySelection,
					message: `arm '${arm}' selected no agents`,
					retryable: false,
				},
				boundary,
			);
		if (instruction !== undefined)
			for (const id of targets) this.pendingInstructions.set(id, instruction);
		this.logger.info("intervention applied", {
			arm,
			targets: targets.length,
			overrides: Object.keys(found.overrides),
		});
	}

	// Hot overrides re-derive the scenario, re-create the policy and any executor whose
	// options changed, and refuse anything that would alter modules or providers mid-run.
	// 热覆盖重新派生场景、重建策略与选项发生变化的执行体，拒绝任何会在运行途中改变模块或提供者的覆盖。
	// The override is applied to the declared (pre-param-resolution) scenario and re-resolved so
	// $param-driven options follow; the holder is swapped back on any failure so a rejected
	// override leaves no partial state behind.
	// 覆盖作用于已声明（参数解析前）的场景并重新解析，$param 驱动的选项随之变化；任何失败都把 holder
	// 换回原值，被拒绝的覆盖不留下半成品状态。
	private applyHotOverride(path: string, value: JsonValue, fields: EventFields): void {
		const reject = (excType: string, message: string): void =>
			this.recordFailure(
				{
					stage: "intervene",
					excType,
					message: `override '${path}': ${message}`,
					retryable: false,
				},
				fields,
			);
		if (!HOT_PREFIXES.some((p) => path.startsWith(p)))
			return reject(
				FAILURE_TYPES.overrideNotHot,
				`only ${HOT_PREFIXES.map((p) => `${p}*`).join(", ")} can change during a run`,
			);
		const declared = overrideScenario(this.declared, path, value);
		if (!declared.ok) return reject(FAILURE_TYPES.overrideFailed, declared.error.kind);
		const resolved = resolveScenarioParams(declared.value);
		if (!resolved.ok)
			return reject(FAILURE_TYPES.overrideFailed, describeParamError(resolved.error));
		const next = resolved.value;
		const current = this.scenario;
		const changed = (a: unknown, b: unknown): boolean =>
			JSON.stringify(a) !== JSON.stringify(b);
		if (changed(next.modules, current.modules) || changed(next.providers, current.providers))
			return reject(
				FAILURE_TYPES.overrideNotHot,
				"it changes module or provider options, which are fixed for the run",
			);
		const previous = this.holder.scenario;
		this.holder.scenario = next;
		const replacements: { readonly slot: ExecutorSlot; readonly executor: Executor }[] = [];
		for (const [i, spec] of next.executors.entries()) {
			const slot = this.executorSlots[i];
			if (slot === undefined || !changed(spec, current.executors[i])) continue;
			const created = this.registry.executors.create(spec, this.ctx);
			const problem = created.ok
				? (() => {
						const declaredOk = created.value.declare(this.world);
						return declaredOk.ok ? undefined : declaredOk.error;
					})()
				: created.error;
			if (!created.ok || problem !== undefined) {
				this.holder.scenario = previous;
				return reject(
					FAILURE_TYPES.overrideFailed,
					`executor '${spec.name ?? spec.kind}' cannot be rebuilt: ${JSON.stringify(problem)}`,
				);
			}
			if (created.value.provider !== slot.executor.provider) {
				this.holder.scenario = previous;
				return reject(
					FAILURE_TYPES.overrideNotHot,
					`executor '${created.value.name}' would switch provider`,
				);
			}
			created.value.setState(slot.executor.getState());
			replacements.push({ slot, executor: created.value });
		}
		const policy = this.registry.policies.create(next.policy, this.ctx);
		if (!policy.ok) {
			this.holder.scenario = previous;
			return reject(
				FAILURE_TYPES.overrideFailed,
				`policy cannot be rebuilt: ${JSON.stringify(policy.error)}`,
			);
		}
		for (const { slot, executor } of replacements) slot.executor = executor;
		this.policy = policy.value;
		this.declared = declared.value;
		this.logger.info("hot override applied", { path, value });
	}

	// Whole-batch failure is the union of: observe threw, the provider threw, a wrong result
	// count, or a non-empty batch with no ok result. Every path still yields exactly one
	// decision or failure per agent through fallbackAll.
	// 整批失败是以下情况的并集：observe 抛出、提供者抛出、结果数不符、非空批次全部失败。
	// 每条路径仍通过 fallbackAll 为每个 agent 恰好产出一条决策或失败。
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
		const batch = this.openBatch(executor, provider);
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
				{ activationEvent },
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
				executor,
				batch,
			);
			this.closeBatch(batch, activationEvent);
			return {
				effects: outcomes.effects,
				decisions: outcomes.decisions,
				batchFailed: ids.length > 0,
			};
		}
		const observationEvent = requests[0]?.observationEvent ?? activationEvent;
		// Agents observe returned no request for (no available actions, say) count as failed here;
		// observe already recorded their failure event.
		// observe 没有为之生成请求的 agent（例如没有可用动作）在此计为 failed；observe 已经写过它们的 failure 事件。
		const requested = new Set(requests.map((r) => r.agentId));
		this.counts.failed += ids.filter((id) => !requested.has(id)).length;

		this.clock.advanceSubstep();
		let results: readonly Result<Decision, ProviderFailure>[] | undefined;
		let batchError:
			| { readonly excType: string; readonly message: string; readonly stack?: string }
			| undefined;
		if (requests.length > 0) {
			const graph = this.graph();
			this.decided.add(this.providerNames.get(provider) ?? provider.name);
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
				executor,
				batch,
			);
			this.closeBatch(batch, observationEvent);
			return { effects: outcomes.effects, decisions: outcomes.decisions, batchFailed: true };
		}

		const effects: Effect[] = [];
		const decisions: Decision[] = [];
		let anyOk = false;
		for (const [i, request] of requests.entries()) {
			const result = results?.[i];
			let outcome: AgentOutcome | undefined;
			if (result !== undefined && result.ok && result.value.agentId === request.agentId) {
				outcome = this.accept(result.value, request, provider.name, executor, batch);
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
					this.parseFailure(batch);
				outcome = this.fallback(
					request.agentId,
					request.observationEvent,
					provider.name,
					executor,
					batch,
				);
			}
			if (outcome === undefined) continue;
			decisions.push(outcome.decision);
			if (outcome.call !== undefined)
				effects.push(...(await this.resolve(outcome.call, tickRng, label)));
		}
		this.closeBatch(batch, observationEvent);
		// Effects from a batch executor's act are stamped with the decision_batch id so inspect can
		// find the ones that touch a given agent.
		// 批量执行体 act 产出的效果盖上 decision_batch 的 id，inspect 才能找到触及某个 agent 的效果。
		const executorEffects = await this.executorAct(
			executor,
			decisions,
			tickRng,
			label,
			activationEvent,
		);
		return {
			effects: [
				...effects,
				...(batch === undefined
					? executorEffects
					: executorEffects.map((e) => ({ ...e, cause: batch.eventId }))),
			],
			decisions,
			batchFailed: requests.length > 0 && !anyOk,
		};
	}

	// The batch event id is drawn when the batch opens so causes can name it, but the event is
	// written only once every member is known; an empty batch writes nothing.
	// 批量事件的 id 在开批时抽取，效果才能以它为 cause，但事件要等全部成员确定后才写；空批不写。
	private openBatch(executor: Executor, provider: DecisionProvider): DecisionBatch | undefined {
		if (executor.batchEvents !== true) return undefined;
		return {
			eventId: this.nextEventId(),
			executor: executor.name,
			provider: provider.name,
			agentIds: [],
			actions: [],
			provenances: new Map(),
			parseFailures: 0,
			cost: ZERO_COST,
		};
	}

	private closeBatch(batch: DecisionBatch | undefined, parent: EventId): void {
		if (batch === undefined || batch.agentIds.length === 0) return;
		const provenance = majorityProvenance(batch.provenances);
		this.emitAs(
			batch.eventId,
			{
				kind: "decision_batch",
				payload: {
					executor: batch.executor,
					provider: batch.provider,
					agentIds: batch.agentIds,
					actions: batch.actions,
					provenance,
					parseFailures: batch.parseFailures,
					cost: batch.cost,
				},
			},
			{ parent, provenance },
		);
	}

	private parseFailure(batch: DecisionBatch | undefined): void {
		this.counts.parseFailures += 1;
		if (batch !== undefined) batch.parseFailures += 1;
	}

	// Per-agent decision event, or an entry in the executor's decision_batch; returns the
	// event id an action call names as its cause.
	// 逐 agent 的 decision 事件，或执行体 decision_batch 里的一条记录；返回动作调用作为 cause 的事件 id。
	private recordDecision(
		decision: Decision,
		providerName: string,
		parent: EventId,
		batch: DecisionBatch | undefined,
	): EventId {
		if (batch === undefined) return this.decisionEvent(decision, providerName, parent).eventId;
		batch.agentIds.push(decision.agentId);
		batch.actions.push(decision.action);
		batch.provenances.set(
			decision.provenance,
			(batch.provenances.get(decision.provenance) ?? 0) + 1,
		);
		batch.cost = addCost(batch.cost, decision.cost);
		return batch.eventId;
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

	// A validation failure counts as a parse failure: the provider produced something the action
	// space cannot honour, and the agent is given the fallback action.
	// 校验失败计为解析失败：提供者产出了动作空间无法执行的东西，该 agent 改用 fallback 动作。
	private accept(
		decision: Decision,
		request: DecisionRequest,
		providerName: string,
		executor: Executor,
		batch: DecisionBatch | undefined,
	): AgentOutcome | undefined {
		if (executor.resolvesOwnActions === true)
			return this.acceptOwn(decision, request, providerName, executor, batch);
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
			this.parseFailure(batch);
			return this.fallback(
				decision.agentId,
				request.observationEvent,
				providerName,
				executor,
				batch,
			);
		}
		const cause = this.recordDecision(decision, providerName, request.observationEvent, batch);
		this.counts.ok += 1;
		return { decision, call: { ...validated.value, cause } };
	}

	// Executors that resolve their own actions (batch transitions) bypass the action registry:
	// the decision only has to name an action from the request's action space.
	// 自行解析动作的执行体（批量转移）绕过动作注册表：决策只需指名请求动作空间内的一个动作。
	private acceptOwn(
		decision: Decision,
		request: DecisionRequest,
		providerName: string,
		executor: Executor,
		batch: DecisionBatch | undefined,
	): AgentOutcome | undefined {
		if (!request.actionSpace.includes(decision.action)) {
			this.recordFailure(
				{
					stage: "validate",
					excType: FAILURE_TYPES.invalidAction,
					message: `action '${decision.action}' is not in the action space of executor '${executor.name}'`,
					retryable: false,
				},
				{ agentId: decision.agentId, parent: request.observationEvent },
			);
			this.parseFailure(batch);
			return this.fallback(
				decision.agentId,
				request.observationEvent,
				providerName,
				executor,
				batch,
			);
		}
		this.recordDecision(decision, providerName, request.observationEvent, batch);
		this.counts.ok += 1;
		return { decision };
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

	// The fallback decision has provenance rule and parseOk false and is counted failed even
	// though it produces a decision event; that is what keeps activated === ok + failed.
	// 回退决策的来源为 rule、parseOk 为 false，即使产生了 decision 事件也计为 failed；
	// activated === ok + failed 靠这一点成立。
	private fallback(
		agentId: EntityId,
		parent: EventId,
		providerName: string,
		executor?: Executor,
		batch?: DecisionBatch,
	): AgentOutcome | undefined {
		this.counts.failed += 1;
		if (executor?.resolvesOwnActions === true)
			return this.fallbackOwn(agentId, parent, providerName, executor, batch);
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
			cost: ZERO_COST,
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
		const cause = this.recordDecision(decision, providerName, parent, batch);
		return { decision, call: { ...validated.value, cause } };
	}

	private fallbackOwn(
		agentId: EntityId,
		parent: EventId,
		providerName: string,
		executor: Executor,
		batch: DecisionBatch | undefined,
	): AgentOutcome | undefined {
		const action = executor.fallbackAction;
		if (action === undefined) {
			this.recordFailure(
				{
					stage: "fallback",
					excType: FAILURE_TYPES.noFallbackAction,
					message: `executor '${executor.name}' declares no fallback action`,
					retryable: false,
				},
				{ agentId, parent },
			);
			return undefined;
		}
		const decision: Decision = {
			agentId,
			action,
			args: {},
			provenance: "rule",
			cost: ZERO_COST,
			parseOk: false,
		};
		this.recordDecision(decision, providerName, parent, batch);
		return { decision };
	}

	private async fallbackAll(
		targets: readonly { readonly agentId: EntityId; readonly parent: EventId }[],
		providerName: string,
		tickRng: Rng,
		label: string,
		executor: Executor,
		batch: DecisionBatch | undefined,
	): Promise<{ readonly effects: readonly Effect[]; readonly decisions: readonly Decision[] }> {
		const effects: Effect[] = [];
		const decisions: Decision[] = [];
		for (const { agentId, parent } of targets) {
			const outcome = this.fallback(agentId, parent, providerName, executor, batch);
			if (outcome === undefined) continue;
			decisions.push(outcome.decision);
			if (outcome.call !== undefined)
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
			return outcome?.call === undefined ? [] : this.resolve(outcome.call, tickRng, MANUAL);
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

	// Each call gets an rng forked from executor, action and cause event id, so two agents
	// resolving the same action in one tick never draw the same entity ids.
	// 每次调用的 rng 由执行体、动作与 cause 事件 id 派生，同 tick 内解析同一动作的两个 agent
	// 永远不会抽到相同的实体 id。
	private async resolve(
		call: ActionCall,
		tickRng: Rng,
		label: string,
	): Promise<readonly Effect[]> {
		const def = this.registry.actions.get(call.name);
		if (def === undefined) return [];
		try {
			return await def.resolve(
				call,
				this.resolveContext(tickRng, `${label}:${call.name}:${call.cause}`),
			);
		} catch (e) {
			const d = describeError(e);
			if (e instanceof ActionRejected) this.counts.rejectedActions += 1;
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

	private nextEventId(): EventId {
		if (this.eventRng === this.boundaryRng) this.boundaryEvents += 1;
		return newEventId(this.eventRng);
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

	// concurrencySafe modules step under Promise.all, but their effects are applied in
	// declaration order afterwards, so the resulting world equals a serial run.
	// concurrencySafe 的模块在 Promise.all 下 step，但效果随后按声明顺序应用，得到的世界与串行运行相同。
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

	// The module_step event is assembled by hand rather than through emit() because its id must
	// exist before the effects are stamped and applied; advanceSeq is false only for initialize.
	// module_step 事件手工组装而不经 emit()，因为其 id 必须先于效果盖戳与应用而存在；
	// advanceSeq 只在 initialize 时为 false。
	private applyModuleEffects(
		slot: ModuleSlot,
		effects: readonly Effect[],
		parent: EventId | undefined,
		advanceSeq = true,
	): void {
		slot.consecutiveFailures = 0;
		if (advanceSeq) this.clock.nextSeq();
		const moduleEvent = this.nextEventId();
		const t = this.clock.now;
		const stamped = effects.map((e) => ({ ...e, cause: moduleEvent }));
		const report = applyEffects(this.world, stamped, t);
		const event = makeEvent(
			{
				eventId: moduleEvent,
				runId: this.runId,
				t,
				seedPath: this.eventRng.path,
				...(parent === undefined ? {} : { parent }),
				provenance: "kernel",
			},
			{
				kind: "module_step",
				payload: {
					module: slot.module.name,
					summary: moduleStepSummary(stamped, report),
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

	// An instrument fires when tick % every === 0; the last value of each is what
	// RunResult.metrics reports.
	// 仪器在 tick % every === 0 时采集；每个仪器的最后一个值就是 RunResult.metrics 报告的值。
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

	// Providers that decided this tick, followed by the downstream chains they were assembled from
	// 本 tick 参与决策的提供者，以及装配它们时用到的下游链
	private participants(): readonly string[] {
		const out: string[] = [];
		const visit = (name: string): void => {
			if (out.includes(name)) return;
			out.push(name);
			for (const next of this.downstreams.get(name) ?? []) visit(next);
		};
		for (const name of this.decided) visit(name);
		return out;
	}

	// Provider audit numbers become measurement events under instrument provider:<name> and
	// metrics provider.<name>.<key>; only finite numbers are kept.
	// 提供者审计的数值写成 instrument 为 provider:<name> 的 measurement 事件，并以
	// provider.<name>.<key> 进入指标；只保留有限数值。
	private auditProviders(activationEvent: EventId, tickRng: Rng): void {
		const graph = this.graph();
		const ctx = {
			t: this.clock.now,
			runId: this.runId,
			seedPath: tickRng.path,
			world: this.world,
			log: this.log,
			...(graph === undefined ? {} : { graph }),
		};
		for (const name of this.participants()) {
			const provider = this.providers.get(name);
			if (provider === undefined) continue;
			try {
				const report = provider.audit?.(ctx);
				if (report === undefined) continue;
				for (const [key, value] of Object.entries(report)) {
					if (!Number.isFinite(value)) continue;
					this.lastMeasurements.set(`${PROVIDER_METRIC_PREFIX}${name}.${key}`, value);
					this.emit(
						{
							kind: "measurement",
							payload: {
								instrument: `${PROVIDER_INSTRUMENT_PREFIX}${name}`,
								name: key,
								value,
							},
						},
						{ parent: activationEvent, provenance: "kernel" },
					);
				}
			} catch (e) {
				const d = describeError(e);
				this.recordFailure(
					{
						stage: "measure",
						excType: d.excType,
						message: `provider '${name}' audit: ${d.message}`,
						stack: d.stack,
						retryable: false,
					},
					{ parent: activationEvent },
				);
			}
		}
	}

	// Boundary steps record at substep 0 before the tick starts; only in-tick events count.
	// A decision is a per-agent decision event or one entry in a decision_batch.
	// 边界步骤记在 tick 开始前的 substep 0，只统计 tick 内的事件。一条决策指逐 agent 的 decision 事件或 decision_batch 里的一条记录。
	private assertComplete(tick: number, activation: Activation): void {
		const decisions = new Map<string, number>();
		const failures = new Set<string>();
		const decided = (id: string): void => {
			decisions.set(id, (decisions.get(id) ?? 0) + 1);
		};
		for (const e of this.log.query({ tick, kind: ["decision", "decision_batch", "failure"] })) {
			if (e.t.substep === 0) continue;
			if (e.kind === "decision_batch") {
				for (const id of e.payload.agentIds) decided(id);
				continue;
			}
			if (e.agentId === undefined) continue;
			if (e.kind === "decision") decided(e.agentId);
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

	// Every failure event is mirrored as an error log line; provenance defaults to kernel.
	// 每个 failure 事件同时写一条 error 日志；来源默认为 kernel。
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
		this.emit(
			{ kind: "failure", payload },
			{ ...fields, provenance: fields.provenance ?? "kernel" },
		);
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

type ProviderResolveError =
	| { readonly kind: "unknown"; readonly name: string }
	| { readonly kind: "cycle"; readonly chain: readonly string[] }
	| { readonly kind: "create"; readonly name: string; readonly error: PluginError };

const describeProviderCycle = (chain: readonly string[]): string =>
	`provider cycle: ${chain.join(" -> ")}`;

const providerPluginError = (slot: string, e: ProviderResolveError): PluginError => {
	switch (e.kind) {
		case "unknown":
			return {
				reason: "construct_failed",
				slot,
				kind: e.name,
				message: `unknown provider '${e.name}'`,
			};
		case "cycle":
			return {
				reason: "construct_failed",
				slot,
				kind: e.chain[e.chain.length - 1] ?? "",
				message: describeProviderCycle(e.chain),
			};
		case "create":
			return e.error;
	}
};

// Relative population sources resolve against baseDir; the recording directory defaults
// into the run directory so a record-mode run is self-contained.
// 相对的人口数据源按 baseDir 解析；录制目录默认落在 run 目录内，record 模式的 run 自成一体。
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
	const declared = resolvedScenario(scenario, deps);
	const resolved = resolveScenarioParams(declared);
	if (!resolved.ok) return instantiateError("ParamResolve", describeParamError(resolved.error));
	const effective = resolved.value;
	const holder: ScenarioHolder = { scenario: effective };
	const resumeFrom = deps.resumeFrom;
	const world = resumeFrom?.world ?? createWorld();
	const rootRng = rngFromSeed(effective.seed, effective.seedPath);
	// The gateway is built before the simulation exists; the sink is rebound after construction
	// so gateway failures always land as failure events once the run is live.
	// 网关先于模拟对象创建；构造完成后再重新绑定 sink，run 开始后网关失败总能落成 failure 事件。
	const failureSink: { handle: (failure: LLMFailure) => void } = { handle: () => {} };
	let gateway: LLMGateway;
	try {
		gateway = deps.createGateway(effective.llm, {
			logger,
			onFailure: (failure) => failureSink.handle(failure),
		});
	} catch (e) {
		return instantiateError("GatewayConfig", e instanceof Error ? e.message : String(e));
	}
	const providers = new Map<string, DecisionProvider>();
	const constructing: string[] = [];
	// Composite providers resolve their downstreams while being constructed; the edges feed audit()
	// 组合提供者在构造过程中解析下游；这些边供 audit() 使用
	const downstreams = new Map<string, Set<string>>();
	// Providers are memoised by name and built on demand; a name already on the constructing
	// stack is a cycle.
	// 提供者按名字记忆化并按需构造；名字已在构造栈上即为循环引用。
	const resolveProvider = (name: string): Result<DecisionProvider, ProviderResolveError> => {
		const requester = constructing[constructing.length - 1];
		if (requester !== undefined) {
			const edges = downstreams.get(requester) ?? new Set<string>();
			edges.add(name);
			downstreams.set(requester, edges);
		}
		const existing = providers.get(name);
		if (existing !== undefined) return ok(existing);
		const spec = effective.providers[name];
		if (spec === undefined) return err({ kind: "unknown", name });
		if (constructing.includes(name))
			return err({ kind: "cycle", chain: [...constructing, name] });
		constructing.push(name);
		const built = registry.providers.create({ ...spec, name: spec.name ?? name }, ctx);
		constructing.pop();
		if (!built.ok) return err({ kind: "create", name, error: built.error });
		built.value.reset(effective.seedPath);
		providers.set(name, built.value);
		return ok(built.value);
	};
	const ctx: PluginContext = {
		get scenario() {
			return holder.scenario;
		},
		registry,
		logger,
		gateway,
		provider: (name) => {
			const r = resolveProvider(name);
			return r.ok ? r : err(providerPluginError(registry.providers.slot, r.error));
		},
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
	// requiresModules is checked after every module has loaded so the error lists all missing
	// modules at once.
	// requiresModules 在全部模块装载后才检查，错误信息一次列出所有缺失的模块。
	for (const name of registry.actions.names()) {
		const def = registry.actions.get(name);
		const missing = (def?.requiresModules ?? []).filter((m) => !modules.has(m));
		if (missing.length > 0)
			return instantiateError(
				"MissingModules",
				`action '${name}' requires modules: ${missing.join(", ")}`,
			);
	}

	if (resumeFrom === undefined) {
		const population = buildPopulation(
			effective.population,
			world,
			rootRng.fork(keyFromLabel("population")),
		);
		if (!population.ok)
			return instantiateError(population.error.kind, population.error.message);
	}

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
		const provider = resolveProvider(executor.provider);
		if (!provider.ok) {
			const e = provider.error;
			switch (e.kind) {
				case "unknown":
					return instantiateError(
						"UnknownProvider",
						`executor '${executor.name}' refers to unknown provider '${e.name}'`,
					);
				case "cycle":
					return instantiateError("ProviderCycle", describeProviderCycle(e.chain));
				case "create":
					return instantiateError(
						"ProviderCreate",
						`provider '${e.name}': ${JSON.stringify(e.error)}`,
					);
			}
		}
		executors.push({ executor, provider: provider.value, consecutiveBatchFailures: 0 });
	}

	const policy = registry.policies.create(effective.policy, ctx);
	if (!policy.ok)
		return instantiateError(
			"PolicyCreate",
			`policy '${effective.policy.kind}': ${JSON.stringify(policy.error)}`,
		);

	const instruments: Instrument[] = [];
	const questionnaires = new Map<string, Questionnaire>();
	for (const spec of effective.instruments) {
		const name = spec.name ?? spec.kind;
		if (registry.instruments.has(spec.kind)) {
			const created = registry.instruments.create(spec, ctx);
			if (!created.ok)
				return instantiateError(
					"InstrumentCreate",
					`instrument '${spec.kind}': ${JSON.stringify(created.error)}`,
				);
			if (questionnaires.has(name))
				return instantiateError("InstrumentCreate", `duplicate questionnaire '${name}'`);
			questionnaires.set(name, { ...created.value, name });
			continue;
		}
		const created = registry.metrics.create(spec, ctx);
		if (!created.ok)
			return instantiateError(
				"InstrumentCreate",
				`instrument '${spec.kind}': ${JSON.stringify(created.error)}`,
			);
		instruments.push({ name, kind: spec.kind, every: spec.every ?? 1, metric: created.value });
	}

	// On resume the world came from the checkpoint and the population was not rebuilt; plugin
	// state is restored only after every plugin exists so composites see their downstreams.
	// 续跑时世界来自检查点、人口不重建；插件状态等全部插件都存在后才恢复，组合提供者能看到它们的下游。
	if (resumeFrom !== undefined) {
		for (const [name, module] of modules) {
			const state = resumeFrom.modules[name];
			if (state !== undefined) module.setState(state);
		}
		for (const slot of executors) {
			const state = resumeFrom.executors[slot.executor.name];
			if (state !== undefined) slot.executor.setState(state);
		}
		for (const [name, provider] of providers) {
			const state = resumeFrom.providers[name];
			if (state !== undefined) provider.setState(state);
		}
	}

	logger.info("simulation assembled", {
		agents: world.count(AGENT_ENTITY),
		modules: [...modules.keys()],
		executors: executors.map((s) => s.executor.name),
		providers: [...providers.keys()],
		policy: policy.value.name,
	});
	const stored = deps.log ?? openSqliteEventLog(eventLogPath(deps.outDir));
	const log = deps.onEvent === undefined ? stored : observableLog(stored, deps.onEvent);
	const simulation = new KernelSimulation({
		runId,
		holder,
		declared,
		ctx,
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
		downstreams,
		policy: policy.value,
		instruments,
		questionnaires,
		...(resumeFrom === undefined ? {} : { resume: resumePointOf(resumeFrom) }),
	});
	failureSink.handle = (failure) => simulation.recordGatewayFailure(failure);
	return ok(simulation);
};
