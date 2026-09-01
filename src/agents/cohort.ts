import { z } from "zod";
import { makeEvent } from "../core/events";
import { makeRunId, newEventId, toEntityId } from "../core/ids";
import type {
	DeclareError,
	EventLog,
	Executor,
	GraphView,
	ModuleObservations,
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
});

export type CohortOptions = z.output<typeof CohortOptionsSchema>;

export interface ColumnStats {
	readonly mean: number;
	readonly sd: number;
}

const numberOf = (v: Scalar | undefined): number => (typeof v === "number" ? v : 0);

const scalarJson = (v: Scalar): JsonValue => (Array.isArray(v) ? [...v] : v);

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
// decisions are handed in bulk to a Transition that writes setColumn effects.
class CohortExecutor implements Executor {
	readonly name: string;
	readonly entity: string;
	readonly provider: string;
	readonly resolvesOwnActions = true;
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

	async observe(
		world: WorldView,
		ids: readonly EntityId[],
		t: LogicalTime,
		log: EventLog,
		rng: Rng,
		observations?: ModuleObservations,
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
			const observation: JsonObject = { features, neighborMean };
			const contentSha = log.putContent(JSON.stringify(observation));
			const eventId = newEventId(rng);
			log.append(
				makeEvent(
					{ eventId, runId: this.runId, t, seedPath: rng.path, agentId },
					{
						kind: "observation",
						payload: { contentSha, refs: [], truncated: false },
					},
				),
			);
			requests.push({
				agentId,
				t,
				state: this.stateOf(world, agentId),
				observation,
				observationEvent: eventId,
				features,
				actionSpace: this.options.virtualActions,
			});
		}
		this.logger.trace("cohort observed", { agents: ids.length, features: columns.length });
		return requests;
	}

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
