// Columnar executor for large populations: observes z-scored features for a whole cohort at
// once, hands decisions to a registered Transition that writes setColumn effects, and emits one
// observation_batch per tick instead of per-agent observation events.
// 面向大规模人口的列式执行体：一次性观察整批 agent 的 z 分数特征，把决策交给注册的转移函数写
// setColumn 效果，每 tick 只写一条 observation_batch 而不是逐 agent 的观察事件。

import { z } from "zod";
import { makeEvent } from "../core/events";
import { makeRunId, newEventId, toEntityId } from "../core/ids";
import type {
	DeclareError,
	EventLog,
	Executor,
	GraphView,
	ModuleObservations,
	ObserveContext,
	PluginContext,
	PluginError,
	ReadonlyColumn,
	ResolveContext,
	Rng,
	Transition,
	World,
	WorldView,
} from "../core/protocols";
import { parseOptions } from "../core/registry";
import { err, ok } from "../core/result";
import { PluginSpecSchema } from "../core/schema";
import type {
	Decision,
	DecisionRequest,
	Effect,
	EntityId,
	ExecutorSpec,
	JsonObject,
	JsonValue,
	LogicalTime,
	PluginSpec,
	Result,
	RunId,
	Scalar,
} from "../core/types";
import type { Logger } from "../logging/logger";
import { CONTEXT_KEYS } from "./components/shared";
import { WhereSchema, matchesWhere, type Where } from "./where";

export const COHORT_KIND = "cohort";

export const CohortOptionsSchema = z.object({
	entity: z.string().min(1).default("agent"),
	provider: z.string().min(1),
	features: z.array(z.string().min(1)).min(1),
	neighborMean: z.string().min(1).optional(),
	transition: z.union([z.string().min(1), PluginSpecSchema]),
	virtualActions: z.array(z.string().min(1)).min(1),
	fallbackAction: z.string().min(1).optional(),
	where: WhereSchema.optional(),
	// Store the per-tick feature matrix in the content store and reference it from the
	// observation_batch event; off by default to keep observation free of content writes.
	// 把每 tick 的特征矩阵存进内容库并由 observation_batch 事件引用；默认关闭，让观察阶段不写内容。
	recordFeatures: z.boolean().default(false),
});

export type CohortOptions = z.output<typeof CohortOptionsSchema>;

export interface ColumnStats {
	readonly mean: number;
	readonly sd: number;
}

const numberOf = (v: Scalar | undefined): number => (typeof v === "number" ? v : 0);

const scalarJson = (v: Scalar): JsonValue => (Array.isArray(v) ? [...v] : v);

// Population statistics use the biased (1/n) standard deviation and treat non-numeric cells as
// 0; a constant column yields sd 0 and every z-score collapses to 0 rather than NaN.
// 总体统计用有偏（除以 n）的标准差，非数值单元按 0 计；常量列 sd 为 0，z 分数统一取 0 而不是 NaN。
export const columnStats = (column: ReadonlyColumn<Scalar>): ColumnStats => {
	const n = column.length;
	if (n === 0) return { mean: 0, sd: 0 };
	let sum = 0;
	for (let i = 0; i < n; i += 1) sum += numberOf(column.at(i));
	const mean = sum / n;
	let ss = 0;
	for (let i = 0; i < n; i += 1) {
		const d = numberOf(column.at(i)) - mean;
		ss += d * d;
	}
	return { mean, sd: Math.sqrt(ss / n) };
};

export const zScore = (value: number, stats: ColumnStats): number =>
	stats.sd === 0 ? 0 : (value - stats.mean) / stats.sd;

const neighbourIdsOf = (observation: JsonObject | undefined): readonly EntityId[] => {
	const list = observation?.[CONTEXT_KEYS.neighbors];
	if (!Array.isArray(list)) return [];
	return list.flatMap((v) => (typeof v === "string" ? [toEntityId(v)] : []));
};

const graphOf = (modules: ReadonlyMap<string, { graph?(): GraphView }>): GraphView | undefined => {
	for (const module of modules.values()) if (module.graph !== undefined) return module.graph();
	return undefined;
};

// A columnar executor: observation is a feature matrix computed straight from world columns,
// decisions are handed in bulk to a Transition that writes setColumn effects. Events are
// batched per tick: one observation_batch here, one decision_batch from the kernel.
// 列式执行体：观察是直接由世界列算出的特征矩阵，决策整批交给写 setColumn 效果的转移函数。
// 事件按 tick 聚合：这里写一条 observation_batch，内核写一条 decision_batch。
class CohortExecutor implements Executor {
	readonly name: string;
	readonly entity: string;
	readonly provider: string;
	// Both flags change the kernel path: resolvesOwnActions skips registry validation and resolve
	// for virtual actions, batchEvents switches the kernel to decision_batch events.
	// 两个标志都改变内核路径：resolvesOwnActions 让虚拟动作跳过注册表校验与解析，
	// batchEvents 让内核改写 decision_batch 事件。
	readonly resolvesOwnActions = true;
	readonly batchEvents = true;
	readonly fallbackAction: string;
	private readonly options: CohortOptions;
	private readonly transition: Transition;
	private readonly where: Where | undefined;
	private readonly runId: RunId;
	private readonly logger: Logger;

	constructor(
		name: string,
		options: CohortOptions,
		ctx: PluginContext,
		transition: Transition,
		fallbackAction: string,
	) {
		this.name = name;
		this.entity = options.entity;
		this.provider = options.provider;
		this.options = options;
		this.transition = transition;
		this.fallbackAction = fallbackAction;
		this.where = options.where;
		this.runId = makeRunId(ctx.scenario.scenarioId, ctx.scenario.replicationId);
		this.logger = ctx.logger.child({ component: `executor:${name}` });
	}

	// Features, the neighbour-mean column and the transition's reads/writes must all be declared
	// columns of the entity; unlike focal components nothing here is produced by another plugin.
	// 特征列、邻居均值列与转移函数的读写列都必须是该实体已声明的列；与 focal 组件不同，
	// 这里没有任何键由其它插件产出。
	declare(world: World): Result<void, DeclareError> {
		const available = new Set(world.columns(this.entity).map((c) => c.name));
		const needed = [
			...this.options.features,
			...(this.options.neighborMean === undefined ? [] : [this.options.neighborMean]),
			...this.transition.reads,
			...this.transition.writes,
		];
		const missing = [...new Set(needed)].filter((c) => !available.has(c));
		if (missing.length > 0)
			return err({ kind: "ComponentDependencyError", component: this.name, missing });
		return ok(undefined);
	}

	owns(world: WorldView, id: EntityId): boolean {
		if (this.where === undefined) return true;
		return matchesWhere(world.row(this.entity, id), this.where);
	}

	// One event id serves the whole batch and is the observationEvent of every request, so the
	// kernel's decision_batch parents onto it. The neighbour mean falls back to the agent's own
	// value when no neighbour has a numeric reading, keeping the feature vector fixed-length.
	// 整批共用一个事件 id，也是每条请求的 observationEvent，内核的 decision_batch 以它为 parent。
	// 没有邻居给出数值时邻居均值回退为 agent 自身的值，保证特征向量定长。
	async observe(
		world: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
		log: EventLog,
		rng: Rng,
		observations?: ModuleObservations,
		ctx?: ObserveContext,
	): Promise<readonly DecisionRequest[]> {
		if (ids.length === 0) return [];
		const columns = this.options.features.map((name) => {
			const column = world.column<Scalar>(this.entity, name);
			return { column, stats: columnStats(column) };
		});
		const neighbourColumn =
			this.options.neighborMean === undefined
				? undefined
				: world.column<Scalar>(this.entity, this.options.neighborMean);
		const neighbourStats =
			neighbourColumn === undefined ? undefined : columnStats(neighbourColumn);
		const eventId = newEventId(rng);
		const matrix: (readonly number[])[] = [];
		const requests: DecisionRequest[] = [];
		for (const agentId of ids) {
			const features = columns.map(({ column, stats }) =>
				zScore(numberOf(column.get(agentId)), stats),
			);
			let neighborMean: number | null = null;
			if (neighbourColumn !== undefined && neighbourStats !== undefined) {
				const neighbours = neighbourIdsOf(observations?.get(agentId));
				let sum = 0;
				let count = 0;
				for (const neighbour of neighbours) {
					const v = neighbourColumn.get(neighbour);
					if (typeof v !== "number") continue;
					sum += v;
					count += 1;
				}
				neighborMean = count === 0 ? numberOf(neighbourColumn.get(agentId)) : sum / count;
				features.push(zScore(neighborMean, neighbourStats));
			}
			if (this.options.recordFeatures) matrix.push(features);
			requests.push({
				agentId,
				t,
				state: this.stateOf(world, agentId),
				observation: { features, neighborMean },
				observationEvent: eventId,
				features,
				actionSpace: this.options.virtualActions,
			});
		}
		const featuresSha = this.options.recordFeatures
			? log.putContent(JSON.stringify(matrix))
			: undefined;
		log.append(
			makeEvent(
				{
					eventId,
					runId: this.runId,
					t,
					seedPath: rng.path,
					...(ctx === undefined ? {} : { parent: ctx.activationEvent }),
				},
				{
					kind: "observation_batch",
					payload: {
						executor: this.name,
						agentIds: ids,
						count: ids.length,
						...(featuresSha === undefined ? {} : { featuresSha }),
					},
				},
			),
		);
		this.logger.trace("cohort observed", { agents: ids.length, features: columns.length });
		return requests;
	}

	// The kernel stamps `cause = decision_batch.eventId` on these effects; the first module with
	// a graph (the social graph) is passed so transitions can read neighbourhoods.
	// 内核会给这些效果盖上 `cause = decision_batch.eventId`；第一个提供图的模块（社交图）
	// 传给转移函数以便读取邻域。
	async act(decisions: readonly Decision[], ctx: ResolveContext): Promise<readonly Effect[]> {
		const ids = decisions.map((d) => d.agentId);
		const graph = graphOf(ctx.modules);
		return this.transition.apply(ctx.world, ids, decisions, ctx.rng, graph);
	}

	async after(): Promise<void> {}

	getState(): JsonValue {
		return null;
	}

	setState(_s: JsonValue): void {}

	private stateOf(world: WorldView, agentId: EntityId): JsonObject {
		const row = world.row(this.entity, agentId);
		const out: Record<string, JsonValue> = {};
		if (row !== undefined) for (const [k, v] of Object.entries(row)) out[k] = scalarJson(v);
		return out;
	}
}

const transitionSpecOf = (transition: CohortOptions["transition"]): PluginSpec =>
	typeof transition === "string" ? { kind: transition } : transition;

// fallbackAction defaults to the last virtual action and must be one of them: the kernel uses it
// for agents whose provider call failed, so the transition must know how to treat it.
// fallbackAction 默认取虚拟动作末项且必须属于该列表：内核用它兜底提供者失败的 agent，
// 转移函数必须认得它。
export const createCohortExecutor = (
	spec: ExecutorSpec,
	ctx: PluginContext,
): Result<Executor, PluginError> => {
	const slot = ctx.registry.executors.slot;
	const options = parseOptions(slot, spec, CohortOptionsSchema);
	if (!options.ok) return options;
	const o = options.value;
	const fallbackAction = o.fallbackAction ?? o.virtualActions[o.virtualActions.length - 1];
	if (fallbackAction === undefined || !o.virtualActions.includes(fallbackAction))
		return err({
			reason: "invalid_options",
			slot,
			kind: spec.kind,
			issues: [`fallbackAction: '${String(fallbackAction)}' is not one of virtualActions`],
		});
	const transition = ctx.registry.transitions.create(transitionSpecOf(o.transition), ctx);
	if (!transition.ok) return transition;
	return ok(new CohortExecutor(spec.name ?? spec.kind, o, ctx, transition.value, fallbackAction));
};
