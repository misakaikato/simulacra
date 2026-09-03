// Topology router: builds bounded-diameter cells over the social graph from each agent's
// structural position, opinion, stubbornness and exposure histogram, sends one caller per cell
// to the downstream and copies its decision to the cell's other members. Cells are rebuilt every
// `updateInterval` ticks; without a graph every request goes downstream unchanged.
// 拓扑路由：按每个 agent 的结构位置、观点、固执度与暴露直方图在社交图上构造有界直径单元，
// 每个单元只派一个调用者去下游，决策复制给单元内其它成员。单元每 `updateInterval` tick 重建；
// 没有图时所有请求原样下发。

import { z } from "zod";
import type { DecisionProvider, GraphView, WorldView } from "../../core/protocols";
import { err, ok } from "../../core/result";
import type {
	Cost,
	Decision,
	DecisionRequest,
	EntityId,
	JsonValue,
	ProviderFailure,
	Result,
	RoundContext,
	Scalar,
} from "../../core/types";
import type { Logger } from "../../logging/logger";

export const TOPO_KIND = "topo";

const positive = z.number().positive();

export const TopoOptionsSchema = z.object({
	downstream: z.string().min(1),
	entity: z.string().min(1).default("agent"),
	// Each epsilon is the tolerance of one distance component; execution distance 1 is the cell
	// diameter bound, so smaller epsilons mean smaller cells and more downstream calls.
	// 每个 epsilon 是一个距离分量的容差；执行距离 1 是单元直径上限，
	// epsilon 越小单元越小、下游调用越多。
	epsilon: z
		.object({
			structural: positive.default(1),
			opinion: positive.default(1),
			stubbornness: positive.default(1),
			exposure: positive.default(1),
		})
		.prefault({}),
	updateInterval: z.number().int().positive().default(4),
	opinionColumn: z.string().min(1).default("persona.stance"),
	stubbornnessColumn: z.string().min(1).optional(),
	buckets: z.number().int().positive().default(5),
});

export type TopoOptions = z.output<typeof TopoOptionsSchema>;
export type Epsilon = TopoOptions["epsilon"];

export interface TopoProviderOptions {
	readonly name: string;
	readonly entity: string;
	readonly epsilon: Epsilon;
	readonly updateInterval: number;
	readonly opinionColumn: string;
	readonly stubbornnessColumn?: string;
	readonly buckets: number;
}

export interface AgentProfile {
	readonly id: EntityId;
	readonly position: readonly [number, number];
	readonly opinion: number;
	readonly stubbornness: number;
	readonly exposure: readonly number[];
}

export interface Cell {
	readonly members: readonly EntityId[];
	readonly representative: EntityId;
}

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const StateSchema = z.object({
	seedPath: z.array(z.number()),
	builtTick: z.number().int().nonnegative().nullable(),
	cells: z.array(z.object({ members: z.array(z.string()), representative: z.string() })),
	calls: z.number().int().nonnegative(),
});

const numberOf = (v: Scalar | undefined): number => (typeof v === "number" ? v : 0);

// d_exec = max(structural / eps, |opinion delta| / eps, |stubbornness delta| / eps, exposure L1 / eps)
// d_exec = max(结构距离 / eps, |观点差| / eps, |固执度差| / eps, 暴露直方图 L1 / eps)
export const execDistance = (a: AgentProfile, b: AgentProfile, eps: Epsilon): number => {
	const dx = a.position[0] - b.position[0];
	const dy = a.position[1] - b.position[1];
	const structural = Math.sqrt(dx * dx + dy * dy) / eps.structural;
	const opinion = Math.abs(a.opinion - b.opinion) / eps.opinion;
	const stubbornness = Math.abs(a.stubbornness - b.stubbornness) / eps.stubbornness;
	let l1 = 0;
	for (let i = 0; i < Math.max(a.exposure.length, b.exposure.length); i += 1)
		l1 += Math.abs((a.exposure[i] ?? 0) - (b.exposure[i] ?? 0));
	return Math.max(structural, opinion, stubbornness, l1 / eps.exposure);
};

// Exposure is the normalised histogram of neighbours' opinions over the population's range;
// comparing histograms by L1 captures "who they hear" independently of degree.
// 暴露是邻居观点在全体人口取值范围上的归一化直方图；用 L1 比较直方图，
// 刻画"听到了谁"而与度数无关。
export const exposureHistogram = (
	opinions: readonly number[],
	range: readonly [number, number],
	buckets: number,
): readonly number[] => {
	const counts = new Array<number>(buckets).fill(0);
	if (opinions.length === 0) return counts;
	const [lo, hi] = range;
	const width = hi - lo;
	for (const v of opinions) {
		const raw = width > 0 ? Math.floor(((v - lo) / width) * buckets) : 0;
		const i = Math.max(0, Math.min(buckets - 1, raw));
		counts[i] = (counts[i] ?? 0) + 1;
	}
	return counts.map((c) => c / opinions.length);
};

// Structural position is (degree, size of the two-hop ring minus self and direct neighbours), a
// cheap proxy for graph placement that needs no embedding.
// 结构位置是（度数，去掉自身与直接邻居后的二跳环大小），无需嵌入的廉价图位置代理。
export const profilesOf = (
	world: WorldView,
	graph: GraphView,
	options: Pick<
		TopoProviderOptions,
		"entity" | "opinionColumn" | "stubbornnessColumn" | "buckets"
	>,
): readonly AgentProfile[] => {
	const ids = world.ids(options.entity);
	const opinion = world.column<Scalar>(options.entity, options.opinionColumn);
	const stubbornness =
		options.stubbornnessColumn === undefined
			? undefined
			: world.column<Scalar>(options.entity, options.stubbornnessColumn);
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < opinion.length; i += 1) {
		const v = numberOf(opinion.at(i));
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	const range: readonly [number, number] = ids.length === 0 ? [0, 0] : [lo, hi];
	return ids.map((id) => {
		const neighbours = graph.neighbors(id);
		const second = new Set<EntityId>();
		for (const n of neighbours) for (const m of graph.neighbors(n)) second.add(m);
		second.delete(id);
		for (const n of neighbours) second.delete(n);
		return {
			id,
			position: [neighbours.length, second.size],
			opinion: numberOf(opinion.get(id)),
			stubbornness: numberOf(stubbornness?.get(id)),
			exposure: exposureHistogram(
				neighbours.map((n) => numberOf(opinion.get(n))),
				range,
				options.buckets,
			),
		};
	});
};

// Greedy bounded-diameter cells: scanning agents in id order, each joins the first cell whose
// members all lie within execution distance 1, otherwise it opens a new cell.
// 贪心有界直径单元：按 id 顺序扫描 agent，加入第一个所有成员都在执行距离 1 内的单元，
// 否则新开一个单元。
export const buildCells = (profiles: readonly AgentProfile[], eps: Epsilon): readonly Cell[] => {
	const ordered = [...profiles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const cells: AgentProfile[][] = [];
	for (const profile of ordered) {
		const cell = cells.find((members) =>
			members.every((m) => execDistance(m, profile, eps) <= 1),
		);
		if (cell === undefined) cells.push([profile]);
		else cell.push(profile);
	}
	// The representative is the member with the smallest eccentricity inside its cell, so copied
	// decisions come from the most central agent rather than the first one scanned.
	// 代表是单元内离心率最小的成员，复制出去的决策来自最居中的 agent，而不是最先扫到的那个。
	return cells.map((members) => {
		let representative = members[0];
		let best = Number.POSITIVE_INFINITY;
		for (const candidate of members) {
			const radius = Math.max(
				0,
				...members.map((m) => (m === candidate ? 0 : execDistance(candidate, m, eps))),
			);
			if (radius < best) {
				best = radius;
				representative = candidate;
			}
		}
		if (representative === undefined) throw new RangeError("empty cell");
		return { members: members.map((m) => m.id), representative: representative.id };
	});
};

class TopoDecisionProvider implements DecisionProvider {
	readonly name: string;
	private readonly options: TopoProviderOptions;
	private readonly downstream: DecisionProvider;
	private readonly logger: Logger;
	private seedPath: readonly number[] = [];
	private cells: readonly Cell[] = [];
	private profiles = new Map<EntityId, AgentProfile>();
	private cellOf = new Map<EntityId, number>();
	private builtTick: number | undefined;
	private calls = 0;

	constructor(options: TopoProviderOptions, downstream: DecisionProvider, logger: Logger) {
		this.name = options.name;
		this.options = options;
		this.downstream = downstream;
		this.logger = logger.child({ component: `provider:${options.name}` });
	}

	async decide(
		requests: readonly DecisionRequest[],
		ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]> {
		const graph = ctx.graph;
		if (graph === undefined) {
			this.logger.warn("no graph in round context; routing every request downstream", {
				tick: ctx.t.tick,
			});
			this.calls += requests.length;
			return this.downstream.decide(requests, ctx);
		}
		if (
			this.builtTick === undefined ||
			ctx.t.tick - this.builtTick >= this.options.updateInterval
		)
			this.rebuild(ctx.world, graph, ctx.t.tick);
		const byCell = new Map<number, number[]>();
		const singles: number[] = [];
		requests.forEach((req, index) => {
			const cell = this.cellOf.get(req.agentId);
			if (cell === undefined) {
				singles.push(index);
				return;
			}
			const members = byCell.get(cell);
			if (members === undefined) byCell.set(cell, [index]);
			else members.push(index);
		});
		const callerOf = new Map<number, number>();
		const callers: number[] = [...singles];
		for (const [cellIndex, indices] of byCell) {
			const caller = this.callerFor(cellIndex, indices, requests);
			callers.push(caller);
			for (const i of indices) callerOf.set(i, caller);
		}
		callers.sort((a, b) => a - b);
		const subRequests = callers.flatMap((i) => {
			const req = requests[i];
			return req === undefined ? [] : [req];
		});
		const fetched = await this.downstream.decide(subRequests, ctx);
		this.calls += subRequests.length;
		const resultAt = new Map<number, Result<Decision, ProviderFailure>>();
		callers.forEach((i, k) => {
			const r = fetched[k];
			if (r !== undefined) resultAt.set(i, r);
		});
		// Copied decisions carry provenance `prototype` and zero cost; the caller keeps its own
		// downstream result untouched, and a caller failure is reported for every cell member.
		// 复制的决策标 provenance `prototype`、零成本；调用者保留自己的下游结果，
		// 调用者失败则单元内每个成员都记失败。
		return requests.map((req, index) => {
			const caller = callerOf.get(index) ?? index;
			const result = resultAt.get(caller);
			if (result === undefined)
				return err({
					agentId: req.agentId,
					reason: "downstream returned no result",
					retryable: false,
				});
			if (!result.ok) return err({ ...result.error, agentId: req.agentId });
			if (caller === index) return result;
			return ok({
				agentId: req.agentId,
				action: result.value.action,
				args: result.value.args,
				...(result.value.soft === undefined ? {} : { soft: result.value.soft }),
				...(result.value.rationale === undefined
					? {}
					: { rationale: result.value.rationale }),
				provenance: "prototype",
				cost: ZERO_COST,
				parseOk: true,
			});
		});
	}

	audit(): Readonly<Record<string, number>> {
		const sizes = this.cells.map((c) => c.members.length);
		return {
			cells: this.cells.length,
			meanCellSize: sizes.length === 0 ? 0 : sizes.reduce((a, b) => a + b, 0) / sizes.length,
			calls: this.calls,
		};
	}

	currentCells(): readonly Cell[] {
		return this.cells;
	}

	reset(seedPath: readonly number[]): void {
		this.seedPath = [...seedPath];
	}

	getState(): JsonValue {
		return {
			seedPath: [...this.seedPath],
			builtTick: this.builtTick ?? null,
			cells: this.cells.map((c) => ({
				members: [...c.members],
				representative: c.representative,
			})),
			calls: this.calls,
		};
	}

	setState(s: JsonValue): void {
		const parsed = StateSchema.safeParse(s);
		if (!parsed.success) return;
		this.seedPath = parsed.data.seedPath;
		this.builtTick = parsed.data.builtTick ?? undefined;
		this.calls = parsed.data.calls;
		this.cells = parsed.data.cells.map((c) => ({
			members: c.members.map((m) => m as EntityId),
			representative: c.representative as EntityId,
		}));
		this.indexCells();
		this.profiles = new Map();
	}

	private rebuild(world: WorldView, graph: GraphView, tick: number): void {
		const profiles = profilesOf(world, graph, this.options);
		this.profiles = new Map(profiles.map((p) => [p.id, p] as const));
		this.cells = buildCells(profiles, this.options.epsilon);
		this.builtTick = tick;
		this.indexCells();
		this.logger.debug("cells rebuilt", {
			tick,
			cells: this.cells.length,
			agents: profiles.length,
		});
	}

	private indexCells(): void {
		this.cellOf = new Map();
		this.cells.forEach((cell, index) => {
			for (const id of cell.members) this.cellOf.set(id, index);
		});
	}

	// The representative answers for the cell when it is in the batch; otherwise the batch
	// member closest to it does.
	// 代表在本批中时由它作答；否则由本批中离它最近的成员作答。
	private callerFor(
		cellIndex: number,
		indices: readonly number[],
		requests: readonly DecisionRequest[],
	): number {
		const cell = this.cells[cellIndex];
		const first = indices[0];
		if (cell === undefined || first === undefined) return first ?? 0;
		const representative = this.profiles.get(cell.representative);
		let best = first;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const i of indices) {
			const id = requests[i]?.agentId;
			if (id === undefined) continue;
			if (id === cell.representative) return i;
			const profile = this.profiles.get(id);
			const distance =
				representative === undefined || profile === undefined
					? Number.POSITIVE_INFINITY
					: execDistance(representative, profile, this.options.epsilon);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = i;
			}
		}
		return best;
	}
}

export interface TopoProvider extends DecisionProvider {
	currentCells(): readonly Cell[];
}

export const createTopoProvider = (
	options: TopoProviderOptions,
	downstream: DecisionProvider,
	logger: Logger,
): TopoProvider => new TopoDecisionProvider(options, downstream, logger);
