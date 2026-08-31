import { z } from "zod";
import { ActionRejected, defineAction } from "../core/actions";
import { ZERO_EVENT_ID, newEntityId, toEntityId } from "../core/ids";
import type {
	ActionDef,
	DeclareError,
	GraphView,
	Module,
	PluginContext,
	PluginError,
	Rng,
	World,
	WorldView,
} from "../core/protocols";
import { parseOptions } from "../core/registry";
import { err, ok } from "../core/result";
import { keyFromLabel } from "../core/rng";
import type {
	Effect,
	EntityId,
	JsonValue,
	LogicalTime,
	ModuleSpec,
	Result,
	Scalar,
} from "../core/types";
import type { Logger } from "../logging/logger";

export const SOCIAL_GRAPH_KIND = "socialGraph";
export const EDGE_ENTITY = "edge";
export const FOLLOW_KIND = "follow";
export const EDGE_COLUMNS = {
	src: `${SOCIAL_GRAPH_KIND}.src`,
	dst: `${SOCIAL_GRAPH_KIND}.dst`,
	kind: `${SOCIAL_GRAPH_KIND}.kind`,
} as const;

const HUB_ASSIGNMENTS = ["anti", "pro", "mixed", "random"] as const;
const GENERATORS = ["random", "powerlaw"] as const;
const REWIRE_ITERATIONS_PER_EDGE = 50;
const REWIRE_ITERATIONS_FLOOR = 1000;

export type HubAssignment = (typeof HUB_ASSIGNMENTS)[number];
export type GraphGenerator = (typeof GENERATORS)[number];

export const SocialGraphOptionsSchema = z.object({
	entity: z.string().min(1).default("agent"),
	generator: z.enum(GENERATORS).default("random"),
	meanDegree: z.number().nonnegative().default(4),
	exponent: z.number().gt(1).default(2.4),
	stanceColumn: z.string().min(1).optional(),
	homophilyBand: z.tuple([z.number(), z.number()]).optional(),
	hubAssignment: z.enum(HUB_ASSIGNMENTS).optional(),
	hubCount: z.number().int().nonnegative().default(5),
	maxRewireIterations: z.number().int().positive().optional(),
});

export type SocialGraphOptions = z.output<typeof SocialGraphOptionsSchema>;

export type IndexEdge = readonly [number, number];

// Generators over node indices 0..n-1

export const randomEdges = (n: number, meanDegree: number, rng: Rng): readonly IndexEdge[] => {
	if (n < 2 || meanDegree <= 0) return [];
	const target = Math.min(Math.round(n * meanDegree), n * (n - 1));
	const seen = new Set<number>();
	const edges: IndexEdge[] = [];
	while (edges.length < target) {
		const a = rng.int(n);
		const b = rng.int(n);
		if (a === b) continue;
		const key = a * n + b;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push([a, b]);
	}
	return edges;
};

const paretoDegree = (u: number, xmin: number, alpha: number, cap: number): number =>
	Math.max(1, Math.min(cap, Math.round(xmin * (1 - u) ** (-1 / (alpha - 1)))));

export const powerlawEdges = (
	n: number,
	meanDegree: number,
	exponent: number,
	rng: Rng,
): readonly IndexEdge[] => {
	if (n < 2 || meanDegree <= 0) return [];
	const xmin = exponent > 2 ? (meanDegree * (exponent - 2)) / (exponent - 1) : 1;
	const cap = n - 1;
	const outDegrees = Array.from({ length: n }, () =>
		paretoDegree(rng.next(), xmin, exponent, cap),
	);
	const inDegrees = rng.shuffle(outDegrees);
	const outStubs: number[] = [];
	const inStubs: number[] = [];
	outDegrees.forEach((k, i) => {
		for (let s = 0; s < k; s += 1) outStubs.push(i);
	});
	inDegrees.forEach((k, i) => {
		for (let s = 0; s < k; s += 1) inStubs.push(i);
	});
	const pairedIn = rng.shuffle(inStubs);
	const seen = new Set<number>();
	const edges: IndexEdge[] = [];
	const pairs = Math.min(outStubs.length, pairedIn.length);
	for (let k = 0; k < pairs; k += 1) {
		const a = outStubs[k];
		const b = pairedIn[k];
		if (a === undefined || b === undefined || a === b) continue;
		const key = a * n + b;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push([a, b]);
	}
	return edges;
};

// Homophily h = sum_ij A_ij (x_i - mean)(x_j - mean) / sum_ij A_ij (x_i - mean)^2

const meanOf = (xs: readonly number[]): number =>
	xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export const homophilyOf = (edges: readonly IndexEdge[], x: readonly number[]): number => {
	if (edges.length === 0 || x.length === 0) return 0;
	const mean = meanOf(x);
	let numerator = 0;
	let denominator = 0;
	for (const [i, j] of edges) {
		const di = (x[i] ?? mean) - mean;
		const dj = (x[j] ?? mean) - mean;
		numerator += di * dj;
		denominator += di * di;
	}
	return denominator === 0 ? 0 : numerator / denominator;
};

export interface RewireResult {
	readonly edges: readonly IndexEdge[];
	readonly homophily: number;
	readonly reached: boolean;
	readonly iterations: number;
}

export const rewireToBand = (
	edges: readonly IndexEdge[],
	x: readonly number[],
	band: readonly [number, number],
	rng: Rng,
	maxIterations: number,
): RewireResult => {
	const [lo, hi] = band;
	const n = x.length;
	const mean = meanOf(x);
	const dev = (i: number): number => (x[i] ?? mean) - mean;
	const list = edges.map(([a, b]): [number, number] => [a, b]);
	const keyOf = (a: number, b: number): number => a * n + b;
	const present = new Set(list.map(([a, b]) => keyOf(a, b)));
	let numerator = 0;
	let denominator = 0;
	for (const [a, b] of list) {
		numerator += dev(a) * dev(b);
		denominator += dev(a) * dev(a);
	}
	const inBand = (h: number): boolean => h >= lo && h <= hi;
	if (denominator === 0 || list.length < 2)
		return { edges, homophily: 0, reached: inBand(0), iterations: 0 };
	let h = numerator / denominator;
	let iterations = 0;
	while (!inBand(h) && iterations < maxIterations) {
		iterations += 1;
		const p = rng.int(list.length);
		const q = rng.int(list.length);
		const first = list[p];
		const second = list[q];
		if (p === q || first === undefined || second === undefined) continue;
		const [a, b] = first;
		const [c, d] = second;
		if (a === c || b === d || a === d || c === b) continue;
		if (present.has(keyOf(a, d)) || present.has(keyOf(c, b))) continue;
		const delta = dev(a) * dev(d) + dev(c) * dev(b) - dev(a) * dev(b) - dev(c) * dev(d);
		if (h < lo ? delta <= 0 : delta >= 0) continue;
		present.delete(keyOf(a, b));
		present.delete(keyOf(c, d));
		present.add(keyOf(a, d));
		present.add(keyOf(c, b));
		first[1] = d;
		second[1] = b;
		numerator += delta;
		h = numerator / denominator;
	}
	return { edges: list, homophily: h, reached: inBand(h), iterations };
};

export interface HubStance {
	readonly index: number;
	readonly value: number;
}

export const assignHubs = (
	edges: readonly IndexEdge[],
	x: readonly number[],
	mode: HubAssignment,
	hubCount: number,
	rng: Rng,
): readonly HubStance[] => {
	if (hubCount === 0 || x.length === 0) return [];
	const inDegree = new Array<number>(x.length).fill(0);
	for (const [, j] of edges) inDegree[j] = (inDegree[j] ?? 0) + 1;
	const hubs = inDegree
		.map((degree, index) => ({ degree, index }))
		.sort((a, b) => b.degree - a.degree || a.index - b.index)
		.slice(0, hubCount);
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const v of x) {
		if (v < min) min = v;
		if (v > max) max = v;
	}
	return hubs.map(({ index }, k) => {
		switch (mode) {
			case "anti":
				return { index, value: min };
			case "pro":
				return { index, value: max };
			case "mixed":
				return { index, value: k % 2 === 0 ? min : max };
			case "random":
				return { index, value: rng.pick(x) };
		}
	});
};

// Adjacency derived from the edge table

export interface Adjacency {
	readonly out: ReadonlyMap<EntityId, ReadonlyMap<EntityId, EntityId>>;
	readonly edgeCount: number;
}

const EMPTY_ADJACENCY: Adjacency = { out: new Map(), edgeCount: 0 };

const hasEdgeTable = (view: WorldView): boolean =>
	view.entities.includes(EDGE_ENTITY) &&
	view.columns(EDGE_ENTITY).some((c) => c.name === EDGE_COLUMNS.src);

export const adjacencyOf = (view: WorldView): Adjacency => {
	if (!hasEdgeTable(view)) return EMPTY_ADJACENCY;
	const ids = view.ids(EDGE_ENTITY);
	const src = view.column<string>(EDGE_ENTITY, EDGE_COLUMNS.src);
	const dst = view.column<string>(EDGE_ENTITY, EDGE_COLUMNS.dst);
	const out = new Map<EntityId, Map<EntityId, EntityId>>();
	ids.forEach((edgeId, i) => {
		const s = toEntityId(src.at(i));
		const d = toEntityId(dst.at(i));
		let targets = out.get(s);
		if (targets === undefined) {
			targets = new Map();
			out.set(s, targets);
		}
		targets.set(d, edgeId);
	});
	return { out, edgeCount: ids.length };
};

export const graphViewOf = (adjacency: Adjacency): GraphView => ({
	edgeCount: adjacency.edgeCount,
	neighbors: (id) => [...(adjacency.out.get(id)?.keys() ?? [])],
	degree: (id) => adjacency.out.get(id)?.size ?? 0,
});

export const edgeListOf = (view: WorldView, entity: string): readonly IndexEdge[] => {
	const index = new Map<EntityId, number>();
	view.ids(entity).forEach((id, i) => index.set(id, i));
	const edges: IndexEdge[] = [];
	for (const [src, targets] of adjacencyOf(view).out) {
		const a = index.get(src);
		if (a === undefined) continue;
		for (const dst of targets.keys()) {
			const b = index.get(dst);
			if (b !== undefined) edges.push([a, b]);
		}
	}
	return edges;
};

const numberOf = (v: Scalar): number => (typeof v === "number" ? v : 0);

export const stanceVectorOf = (
	view: WorldView,
	entity: string,
	column: string,
): readonly number[] => {
	const values = view.column<Scalar>(entity, column);
	return view.ids(entity).map((_, i) => numberOf(values.at(i)));
};

const FollowParams = z.object({
	target: z.string().min(1).describe("id of the agent to follow"),
});

const UnfollowParams = z.object({
	target: z.string().min(1).describe("id of the agent to unfollow"),
});

class SocialGraphModule implements Module {
	readonly name: string;
	readonly concurrencySafe = true;
	private readonly options: SocialGraphOptions;
	private readonly logger: Logger;
	private world: WorldView | undefined;
	private adjacency: Adjacency | undefined;

	constructor(name: string, options: SocialGraphOptions, logger: Logger) {
		this.name = name;
		this.options = options;
		this.logger = logger.child({ component: `module:${name}` });
	}

	declare(world: World): Result<void, DeclareError> {
		this.world = world;
		for (const column of ["src", "dst", "kind"] as const) {
			const declared = world.declare({
				entity: EDGE_ENTITY,
				name: column,
				dtype: "str",
				default: "",
				owner: SOCIAL_GRAPH_KIND,
				merge: "last",
			});
			if (!declared.ok) return declared;
		}
		return ok(undefined);
	}

	async initialize(world: WorldView, rng: Rng): Promise<readonly Effect[]> {
		const { entity, stanceColumn } = this.options;
		const ids = world.ids(entity);
		const generate = rng.fork(keyFromLabel("generate"));
		let edges =
			this.options.generator === "random"
				? randomEdges(ids.length, this.options.meanDegree, generate)
				: powerlawEdges(
						ids.length,
						this.options.meanDegree,
						this.options.exponent,
						generate,
					);
		const effects: Effect[] = [];
		const stance =
			stanceColumn === undefined
				? undefined
				: [...stanceVectorOf(world, entity, stanceColumn)];
		if (
			this.options.hubAssignment !== undefined &&
			stanceColumn !== undefined &&
			stance !== undefined
		) {
			const hubs = assignHubs(
				edges,
				stance,
				this.options.hubAssignment,
				this.options.hubCount,
				rng.fork(keyFromLabel("hubs")),
			);
			for (const hub of hubs) {
				const id = ids[hub.index];
				if (id === undefined) continue;
				stance[hub.index] = hub.value;
				effects.push({
					op: "set",
					entity,
					id,
					column: stanceColumn,
					value: hub.value,
					cause: ZERO_EVENT_ID,
				});
			}
		}
		if (this.options.homophilyBand !== undefined && stance !== undefined) {
			const maxIterations =
				this.options.maxRewireIterations ??
				Math.max(REWIRE_ITERATIONS_FLOOR, REWIRE_ITERATIONS_PER_EDGE * edges.length);
			const rewired = rewireToBand(
				edges,
				stance,
				this.options.homophilyBand,
				rng.fork(keyFromLabel("rewire")),
				maxIterations,
			);
			edges = rewired.edges;
			const detail = {
				homophily: rewired.homophily,
				band: [...this.options.homophilyBand],
				iterations: rewired.iterations,
			};
			if (rewired.reached) this.logger.info("homophily band reached", detail);
			else this.logger.warn("homophily band not reached within iteration budget", detail);
		}
		const edgeIds = rng.fork(keyFromLabel("ids"));
		for (const [a, b] of edges) {
			const src = ids[a];
			const dst = ids[b];
			if (src === undefined || dst === undefined) continue;
			effects.push({
				op: "create",
				entity: EDGE_ENTITY,
				id: newEntityId(edgeIds),
				row: {
					[EDGE_COLUMNS.src]: src,
					[EDGE_COLUMNS.dst]: dst,
					[EDGE_COLUMNS.kind]: FOLLOW_KIND,
				},
				cause: ZERO_EVENT_ID,
			});
		}
		this.adjacency = undefined;
		return effects;
	}

	actions(): readonly ActionDef[] {
		const entity = this.options.entity;
		const follow = defineAction({
			name: "follow",
			description: "Follow another agent so that their posts reach your feed",
			params: FollowParams,
			requiresModules: [this.name],
			fallback: false,
			resolve: async (call, ctx) => {
				const target = toEntityId(call.args.target);
				if (target === call.agentId)
					throw new ActionRejected(`agent ${call.agentId} cannot follow itself`);
				if (ctx.world.row(entity, target) === undefined)
					throw new ActionRejected(`unknown agent ${target}`);
				if (this.current(ctx.world).out.get(call.agentId)?.has(target)) return [];
				return [
					{
						op: "create",
						entity: EDGE_ENTITY,
						id: ctx.newEntityId(),
						row: {
							[EDGE_COLUMNS.src]: call.agentId,
							[EDGE_COLUMNS.dst]: target,
							[EDGE_COLUMNS.kind]: FOLLOW_KIND,
						},
						cause: call.cause,
					},
				];
			},
		});
		const unfollow = defineAction({
			name: "unfollow",
			description: "Stop following an agent you currently follow",
			params: UnfollowParams,
			requiresModules: [this.name],
			fallback: false,
			resolve: async (call, ctx) => {
				const target = toEntityId(call.args.target);
				const edgeId = this.current(ctx.world).out.get(call.agentId)?.get(target);
				if (edgeId === undefined)
					throw new ActionRejected(`agent ${call.agentId} does not follow ${target}`);
				return [{ op: "delete", entity: EDGE_ENTITY, id: edgeId, cause: call.cause }];
			},
		});
		return [follow, unfollow];
	}

	observe(
		view: WorldView,
		ids: readonly EntityId[],
		_t: LogicalTime,
	): Readonly<Record<EntityId, JsonValue>> {
		const graph = graphViewOf(this.current(view));
		const out: Record<EntityId, JsonValue> = {};
		for (const id of ids) out[id] = { neighbors: [...graph.neighbors(id)] };
		return out;
	}

	async step(view: WorldView, _t: LogicalTime, _rng: Rng): Promise<readonly Effect[]> {
		this.adjacency = adjacencyOf(view);
		return [];
	}

	graph(): GraphView {
		return graphViewOf(this.current(this.world));
	}

	getState(): JsonValue {
		return null;
	}

	setState(_s: JsonValue): void {
		this.adjacency = undefined;
	}

	private current(view: WorldView | undefined): Adjacency {
		if (this.adjacency === undefined)
			this.adjacency = view === undefined ? EMPTY_ADJACENCY : adjacencyOf(view);
		return this.adjacency;
	}
}

export const createSocialGraphModule = (
	spec: ModuleSpec,
	ctx: PluginContext,
): Result<Module, PluginError> => {
	const options = parseOptions(ctx.registry.modules.slot, spec, SocialGraphOptionsSchema);
	if (!options.ok) return options;
	const o = options.value;
	if (
		(o.homophilyBand !== undefined || o.hubAssignment !== undefined) &&
		o.stanceColumn === undefined
	)
		return err({
			reason: "invalid_options",
			slot: ctx.registry.modules.slot,
			kind: spec.kind,
			issues: ["stanceColumn: required when homophilyBand or hubAssignment is set"],
		});
	return ok(new SocialGraphModule(spec.name ?? spec.kind, o, ctx.logger));
};
