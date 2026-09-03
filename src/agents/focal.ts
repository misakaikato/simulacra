// Component-based executor for LLM-driven agents: components contribute context in declaration
// order, the merged context is rendered into one prompt per agent, and the observation event is
// logged before its DecisionRequest leaves. Actions are resolved by the kernel, never here.
// 组件式执行体，面向 LLM 驱动的 agent：各组件按声明顺序贡献上下文，合并后为每个 agent 渲染一份
// prompt，观察事件先落日志再交出 DecisionRequest。动作由内核解析，本文件从不产生效果。

import { z } from "zod";
import { zodToJsonSchema } from "../core/actions";
import { makeEvent } from "../core/events";
import { FAILURE_TYPES } from "../core/failures";
import { makeRunId, newEventId, toEventId } from "../core/ids";
import { renderPrompt, type ActionSummary, type PromptInput } from "../core/prompt";
import type {
	Component,
	DeclareError,
	EventLog,
	Executor,
	ModuleObservations,
	PluginContext,
	PluginError,
	Questionnaire,
	ResolveContext,
	Rng,
	World,
	WorldView,
} from "../core/protocols";
import {
	ANSWER_ACTION,
	QUESTIONNAIRE_KEY,
	answerActionSummary,
	questionnaireInstruction,
	questionnaireObservation,
} from "../core/questionnaire";
import { parseOptions } from "../core/registry";
import { JsonValueSchema } from "../core/schema";
import { err, ok } from "../core/result";
import { keyFromLabel } from "../core/rng";
import type {
	Decision,
	DecisionRequest,
	Effect,
	EffectReport,
	EntityId,
	ExecutorSpec,
	JsonObject,
	JsonValue,
	LogicalTime,
	Result,
	RunId,
	Scalar,
} from "../core/types";
import type { Logger } from "../logging/logger";
import { CONTEXT_KEYS } from "./components";
import { memoryEntriesOf } from "./components/shared";
import { WhereSchema, matchesWhere, type Where } from "./where";

export const FocalOptionsSchema = z.object({
	entity: z.string().min(1).default("agent"),
	provider: z.string().min(1),
	actions: z.array(z.string().min(1)).optional(),
	where: WhereSchema.optional(),
});

// Context keys consumed by the prompt renderer itself (or carrying a pending intervention);
// every other context key is passed through verbatim as part of `observation`.
// 这些上下文键由 prompt 渲染器直接消费（或承载待生效的干预）；其余键原样并入 `observation`。
const RESERVED_KEYS: readonly string[] = [
	CONTEXT_KEYS.persona,
	CONTEXT_KEYS.name,
	CONTEXT_KEYS.instructions,
	CONTEXT_KEYS.memory,
	CONTEXT_KEYS.intervention,
];

const StateSchema = z.object({ components: z.array(JsonValueSchema) });

interface TickStash {
	readonly t: LogicalTime;
	readonly rng: Rng;
}

// Extra prompt material for a questionnaire round; `attribute` false keeps the interview
// events off the agent's own timeline so memory components do not pick them up.
interface InterviewExtra {
	readonly observation: JsonObject;
	readonly instructions: string;
	readonly attribute: boolean;
}

const matchesPattern = (pattern: string, key: string): boolean =>
	pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern;

const isSatisfied = (pattern: string, available: ReadonlySet<string>): boolean =>
	pattern.endsWith("*") || available.has(pattern);

const isScalar = (v: JsonValue): v is Scalar =>
	v === null ||
	typeof v === "string" ||
	typeof v === "number" ||
	typeof v === "boolean" ||
	(Array.isArray(v) && v.every((x) => typeof x === "string"));

const scalarJson = (v: Scalar): JsonValue => (Array.isArray(v) ? [...v] : v);

const personaOf = (value: JsonValue | undefined): Readonly<Record<string, Scalar>> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const out: Record<string, Scalar> = {};
	for (const [k, v] of Object.entries(value)) if (isScalar(v)) out[k] = v;
	return out;
};

const promptText = (input: PromptInput, rendered: ReturnType<typeof renderPrompt>): string =>
	JSON.stringify({ agentId: input.agentId, messages: rendered.messages }, null, 2);

class FocalExecutor implements Executor {
	readonly name: string;
	readonly entity: string;
	readonly provider: string;
	private readonly ctx: PluginContext;
	private readonly components: readonly Component[];
	private readonly actionFilter: readonly string[] | undefined;
	private readonly where: Where | undefined;
	private readonly runId: RunId;
	private readonly logger: Logger;
	private stash: TickStash | undefined;

	constructor(
		name: string,
		options: z.output<typeof FocalOptionsSchema>,
		ctx: PluginContext,
		components: readonly Component[],
	) {
		this.name = name;
		this.entity = options.entity;
		this.provider = options.provider;
		this.actionFilter = options.actions;
		this.where = options.where;
		this.ctx = ctx;
		this.components = components;
		this.runId = makeRunId(ctx.scenario.scenarioId, ctx.scenario.replicationId);
		this.logger = ctx.logger.child({ component: `executor:${name}` });
	}

	// Dependency check walks components in scenario order: a read is satisfied by a declared
	// column or by a write of an earlier component, so component order is part of the contract.
	// 依赖校验按场景里的组件顺序进行：读键必须是已声明列或更早组件的写键，
	// 因此组件顺序也是契约的一部分。
	declare(world: World): Result<void, DeclareError> {
		const available = new Set(world.columns(this.entity).map((c) => c.name));
		for (const component of this.components) {
			const missing = component.reads.filter((r) => !isSatisfied(r, available));
			if (missing.length > 0)
				return err({
					kind: "ComponentDependencyError",
					component: component.name,
					missing,
				});
			for (const w of component.writes) available.add(w);
		}
		return ok(undefined);
	}

	owns(world: WorldView, id: EntityId): boolean {
		if (this.where === undefined) return true;
		return matchesWhere(world.row(this.entity, id), this.where);
	}

	async observe(
		world: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
		log: EventLog,
		rng: Rng,
		observations?: ModuleObservations,
	): Promise<readonly DecisionRequest[]> {
		this.stash = { t, rng };
		const actionSpace = this.actionSpace();
		if (actionSpace.length === 0) {
			for (const agentId of ids) this.noActions(agentId, t, log, rng);
			return [];
		}
		return this.requestsFor(
			world,
			ids,
			t,
			log,
			rng,
			observations,
			actionSpace,
			this.actionSummaries(actionSpace),
		);
	}

	async interview(
		world: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
		log: EventLog,
		rng: Rng,
		questionnaire: Questionnaire,
	): Promise<readonly DecisionRequest[]> {
		this.stash = { t, rng };
		return this.requestsFor(
			world,
			ids,
			t,
			log,
			rng,
			undefined,
			[ANSWER_ACTION],
			[answerActionSummary(questionnaire)],
			{
				observation: { [QUESTIONNAIRE_KEY]: questionnaireObservation(questionnaire) },
				instructions: questionnaireInstruction(questionnaire),
				attribute: questionnaire.entersMemory,
			},
		);
	}

	// One observation event per agent is appended before the request exists so the kernel can
	// name it as the decision event's parent. Interview rounds with `attribute` false omit
	// `agentId`, so memory components never query them back.
	// 每个 agent 先落一条观察事件再构造请求，内核据此把它记为决策事件的 parent。
	// `attribute` 为 false 的访谈轮不带 `agentId`，记忆组件因此永远查不回它们。
	private requestsFor(
		world: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
		log: EventLog,
		rng: Rng,
		observations: ModuleObservations | undefined,
		actionSpace: readonly string[],
		summaries: readonly ActionSummary[],
		interview?: InterviewExtra,
	): readonly DecisionRequest[] {
		const requests: DecisionRequest[] = [];
		const attributed = interview === undefined || interview.attribute;
		for (const agentId of ids) {
			const context = this.buildContext(agentId, world, t, log, observations?.get(agentId));
			const input = this.promptInput(agentId, context, summaries, interview);
			const rendered = renderPrompt(input, this.ctx.scenario.prompt);
			const contentSha = log.putContent(promptText(input, rendered));
			const eventId = newEventId(rng);
			log.append(
				makeEvent(
					{
						eventId,
						runId: this.runId,
						t,
						seedPath: rng.path,
						...(attributed ? { agentId } : {}),
						...(interview === undefined ? {} : { provenance: "interview" }),
					},
					{
						kind: "observation",
						payload: {
							contentSha,
							refs: [],
							truncated: rendered.meta.truncated,
							promptHash: rendered.hash,
						},
					},
				),
			);
			this.logger.trace("observation", { agentId, promptHash: rendered.hash, contentSha });
			requests.push({
				agentId,
				t,
				state: this.stateOf(world, agentId),
				observation: input.observation,
				observationEvent: eventId,
				actionSpace,
				prompt: {
					system: rendered.system,
					messages: rendered.messages,
					...(rendered.schema === undefined ? {} : { schema: rendered.schema }),
					hash: rendered.hash,
				},
			});
		}
		return requests;
	}

	async act(_decisions: readonly Decision[], _ctx: ResolveContext): Promise<readonly Effect[]> {
		return [];
	}

	// postAct is synchronous per decision; consolidate (which may call the LLM) runs afterwards
	// with an rng forked per component so event ids stay deterministic whatever the gateway does.
	// postAct 按决策同步执行；consolidate（可能调 LLM）随后进行，rng 按组件派生，
	// 事件 id 因此不受网关时序影响。
	async after(
		decisions: readonly Decision[],
		report: EffectReport,
		log: EventLog,
	): Promise<void> {
		for (const decision of decisions)
			for (const component of this.components)
				component.postAct(decision.agentId, decision, report, log);
		const stash = this.stash;
		if (stash === undefined) return;
		for (const component of this.components) {
			if (component.consolidate === undefined) continue;
			const rng = stash.rng.fork(keyFromLabel(`component:${component.name}`));
			for (const decision of decisions)
				await component.consolidate(decision.agentId, log, {
					t: stash.t,
					runId: this.runId,
					seedPath: rng.path,
					rng,
				});
		}
	}

	getState(): JsonValue {
		return { components: this.components.map((c) => c.getState()) };
	}

	setState(s: JsonValue): void {
		const parsed = StateSchema.safeParse(s);
		if (!parsed.success) return;
		this.components.forEach((c, i) => {
			const state = parsed.data.components[i];
			if (state !== undefined) c.setState(state);
		});
	}

	private actionSpace(): readonly string[] {
		const registered = this.ctx.registry.actions.names();
		if (this.actionFilter === undefined) return registered;
		const known = new Set(registered);
		return this.actionFilter.filter((a) => known.has(a));
	}

	private actionSummaries(names: readonly string[]): readonly ActionSummary[] {
		return names.flatMap((name) => {
			const def = this.ctx.registry.actions.get(name);
			return def === undefined
				? []
				: [{ name, description: def.description, schema: zodToJsonSchema(def.params) }];
		});
	}

	private noActions(agentId: EntityId, t: LogicalTime, log: EventLog, rng: Rng): void {
		const message = `executor '${this.name}' has no available actions`;
		log.append(
			makeEvent(
				{ eventId: newEventId(rng), runId: this.runId, t, seedPath: rng.path, agentId },
				{
					kind: "failure",
					payload: {
						stage: "observe",
						excType: FAILURE_TYPES.noAvailableActions,
						message,
						retryable: false,
					},
				},
			),
		);
		this.logger.error(message, { agentId, excType: FAILURE_TYPES.noAvailableActions });
	}

	// Module observations are visible to every component; a component's own output is visible only
	// to later components whose `reads` match it, which makes reads/writes an enforced contract.
	// 模块观察对所有组件可见；组件输出只对 `reads` 匹配的后续组件可见，
	// reads/writes 由此成为强制契约而不只是文档。
	private buildContext(
		agentId: EntityId,
		world: WorldView,
		t: LogicalTime,
		log: EventLog,
		moduleObservation: JsonObject | undefined,
	): ReadonlyMap<string, JsonValue> {
		const context = new Map<string, JsonValue>(Object.entries(moduleObservation ?? {}));
		const moduleKeys = new Set(context.keys());
		for (const component of this.components) {
			const visible = new Map<string, JsonValue>();
			for (const [k, v] of context)
				if (moduleKeys.has(k) || component.reads.some((r) => matchesPattern(r, k)))
					visible.set(k, v);
			const out = component.preAct(agentId, world, t, visible, log);
			for (const [k, v] of Object.entries(out)) context.set(k, v);
		}
		return context;
	}

	// Questionnaire instructions are appended after the agent's usual instructions so the
	// interview reads as an extra request rather than a replacement of the persona brief.
	// 问卷指令追加在 agent 常规指令之后，访谈读起来是额外请求，而不是替换掉人设说明。
	private promptInput(
		agentId: EntityId,
		context: ReadonlyMap<string, JsonValue>,
		actions: readonly ActionSummary[],
		interview?: InterviewExtra,
	): PromptInput {
		const name = context.get(CONTEXT_KEYS.name);
		const instructions = context.get(CONTEXT_KEYS.instructions);
		const observation: Record<string, JsonValue> = {};
		for (const [k, v] of context) if (!RESERVED_KEYS.includes(k)) observation[k] = v;
		for (const [k, v] of Object.entries(interview?.observation ?? {})) observation[k] = v;
		return {
			agentId,
			...(typeof name === "string" ? { name } : {}),
			persona: personaOf(context.get(CONTEXT_KEYS.persona)),
			instructions: [
				typeof instructions === "string" ? instructions : "",
				interview?.instructions ?? "",
			]
				.filter((s) => s.length > 0)
				.join("\n\n"),
			memory: memoryEntriesOf(context.get(CONTEXT_KEYS.memory)).map((m) => ({
				...m,
				eventId: toEventId(m.eventId),
			})),
			observation,
			actions,
		};
	}

	private stateOf(world: WorldView, agentId: EntityId): JsonObject {
		const row = world.row(this.entity, agentId);
		const out: Record<string, JsonValue> = {};
		if (row !== undefined) for (const [k, v] of Object.entries(row)) out[k] = scalarJson(v);
		return out;
	}
}

export const createFocalExecutor = (
	spec: ExecutorSpec,
	ctx: PluginContext,
	components: readonly Component[],
): Result<Executor, PluginError> => {
	const options = parseOptions("executors", spec, FocalOptionsSchema);
	if (!options.ok) return options;
	return ok(new FocalExecutor(spec.name ?? spec.kind, options.value, ctx, components));
};
