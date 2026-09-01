import { describe, expect, test } from "bun:test";
import { makeRunId, toEntityId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import type { DecisionProvider, GraphView } from "../../src/core/protocols";
import { ok } from "../../src/core/result";
import { rngFromSeed } from "../../src/core/rng";
import type { DecisionRequest, EntityId, RoundContext } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { silentLogger } from "../../src/logging/logger";
import { ruleDecision } from "../../src/providers/rule";
import {
	buildCells,
	createTopoProvider,
	execDistance,
	exposureHistogram,
	profilesOf,
	type AgentProfile,
	type Epsilon,
} from "../../src/providers/routers/topo";

const EPS: Epsilon = { structural: 2, opinion: 0.5, stubbornness: 1, exposure: 1 };

const buildWorld = (n: number, seed: number) => {
	const world = createWorld();
	for (const name of ["stance", "stubbornness"]) {
		const r = world.declare({
			entity: "agent",
			name,
			dtype: "f64",
			default: 0,
			owner: "persona",
			merge: "last",
		});
		if (!r.ok) throw new Error(r.error.message);
	}
	const rng = rngFromSeed(seed, [0]);
	const rows = Array.from({ length: n }, () => ({
		"persona.stance": -2 + 4 * rng.next(),
		"persona.stubbornness": rng.next(),
	}));
	const ids = world.create("agent", rows, rng.fork(1));
	const edges = new Map<EntityId, EntityId[]>();
	const link = rng.fork(2);
	for (const id of ids) {
		const targets = new Set<EntityId>();
		const degree = 1 + link.int(4);
		while (targets.size < degree) {
			const t = ids[link.int(ids.length)];
			if (t !== undefined && t !== id) targets.add(t);
		}
		edges.set(id, [...targets]);
	}
	const graph: GraphView = {
		edgeCount: [...edges.values()].reduce((a, e) => a + e.length, 0),
		neighbors: (id) => edges.get(id) ?? [],
		degree: (id) => edges.get(id)?.length ?? 0,
	};
	return { world, ids, graph };
};

const request = (agentId: EntityId): DecisionRequest => ({
	agentId,
	t: { tick: 0, substep: 0, seq: 0 },
	state: {},
	observation: {},
	observationEvent: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FC0"),
	actionSpace: ["post", "silent"],
});

const counting = () => {
	const handle = {
		calls: 0,
		seen: [] as EntityId[],
		provider: {
			name: "down",
			decide: async (requests: readonly DecisionRequest[]) => {
				handle.calls += requests.length;
				handle.seen.push(...requests.map((r) => r.agentId));
				return requests.map((req) => ok(ruleDecision(req, "post")));
			},
			reset: () => {},
			getState: () => null,
			setState: () => {},
		} satisfies DecisionProvider,
	};
	return handle;
};

describe("topo cells", () => {
	test("every cell has execution diameter at most one and its representative inside", () => {
		const { world, graph } = buildWorld(60, 3);
		const profiles = profilesOf(world, graph, {
			entity: "agent",
			opinionColumn: "persona.stance",
			stubbornnessColumn: "persona.stubbornness",
			buckets: 5,
		});
		const byId = new Map(profiles.map((p) => [p.id, p] as const));
		const cells = buildCells(profiles, EPS);
		expect(cells.reduce((a, c) => a + c.members.length, 0)).toBe(60);
		expect(cells.length).toBeGreaterThan(1);
		expect(cells.length).toBeLessThan(60);
		for (const cell of cells) {
			expect(cell.members).toContain(cell.representative);
			for (const a of cell.members)
				for (const b of cell.members) {
					const pa = byId.get(a);
					const pb = byId.get(b);
					if (pa === undefined || pb === undefined) throw new Error("missing profile");
					expect(execDistance(pa, pb, EPS)).toBeLessThanOrEqual(1);
				}
		}
		expect(buildCells(profiles, EPS)).toEqual(cells);
	});

	test("execution distance is the max over the four normalised components", () => {
		const a: AgentProfile = {
			id: toEntityId("a"),
			position: [3, 4],
			opinion: 0,
			stubbornness: 0,
			exposure: [1, 0],
		};
		const b: AgentProfile = {
			id: toEntityId("b"),
			position: [0, 0],
			opinion: 0.25,
			stubbornness: 0.5,
			exposure: [0, 1],
		};
		expect(
			execDistance(a, b, { structural: 10, opinion: 1, stubbornness: 1, exposure: 1 }),
		).toBe(2);
		expect(
			execDistance(a, b, { structural: 1, opinion: 1, stubbornness: 1, exposure: 1 }),
		).toBe(5);
		expect(exposureHistogram([-2, -1, 0, 1, 2], [-2, 2], 5)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
		expect(exposureHistogram([], [-2, 2], 3)).toEqual([0, 0, 0]);
	});
});

describe("topo provider", () => {
	const context = (
		world: ReturnType<typeof buildWorld>["world"],
		graph: GraphView | undefined,
		tick: number,
	): RoundContext => ({
		t: { tick, substep: 0, seq: 0 },
		runId: makeRunId("t", 0),
		seedPath: [tick],
		world,
		log: createMemoryEventLog(),
		...(graph === undefined ? {} : { graph }),
	});

	test("calls downstream once per cell, reuses across the interval and rebuilds after it", async () => {
		const { world, ids, graph } = buildWorld(60, 3);
		const down = counting();
		const topo = createTopoProvider(
			{
				name: "topo",
				entity: "agent",
				epsilon: EPS,
				updateInterval: 2,
				opinionColumn: "persona.stance",
				stubbornnessColumn: "persona.stubbornness",
				buckets: 5,
			},
			down.provider,
			silentLogger,
		);
		const requests = ids.map(request);
		const first = await topo.decide(requests, context(world, graph, 0));
		const cells = topo.currentCells();
		expect(first).toHaveLength(60);
		expect(down.calls).toBe(cells.length);
		expect(first.every((r) => r.ok)).toBe(true);
		const representatives = new Set(cells.map((c) => c.representative));
		for (const r of first) {
			if (!r.ok) continue;
			expect(r.value.provenance).toBe(
				representatives.has(r.value.agentId) ? "rule" : "prototype",
			);
			expect(r.value.action).toBe("post");
		}
		expect(new Set(down.seen)).toEqual(representatives);
		await topo.decide(requests, context(world, graph, 1));
		expect(topo.currentCells()).toBe(cells);
		expect(topo.audit?.(context(world, graph, 1))).toEqual({
			cells: cells.length,
			meanCellSize: 60 / cells.length,
			calls: 2 * cells.length,
		});
		await topo.decide(requests, context(world, graph, 2));
		expect(topo.currentCells()).not.toBe(cells);
		expect(topo.currentCells()).toEqual(cells);
		const half = requests.filter((_, i) => i % 2 === 0);
		down.calls = 0;
		const partial = await topo.decide(half, context(world, graph, 3));
		expect(partial).toHaveLength(half.length);
		expect(down.calls).toBeLessThanOrEqual(cells.length);
		expect(down.calls).toBeLessThanOrEqual(half.length);
	});

	test("without a graph every request goes downstream and state round-trips", async () => {
		const { world, ids, graph } = buildWorld(20, 5);
		const down = counting();
		const options = {
			name: "topo",
			entity: "agent",
			epsilon: EPS,
			updateInterval: 4,
			opinionColumn: "persona.stance",
			buckets: 5,
		};
		const topo = createTopoProvider(options, down.provider, silentLogger);
		const requests = ids.map(request);
		const direct = await topo.decide(requests, context(world, undefined, 0));
		expect(down.calls).toBe(20);
		expect(direct.every((r) => r.ok && r.value.provenance === "rule")).toBe(true);
		await topo.decide(requests, context(world, graph, 1));
		const restored = createTopoProvider(options, down.provider, silentLogger);
		restored.setState(topo.getState());
		expect(restored.getState()).toEqual(topo.getState());
		expect(restored.currentCells()).toEqual(topo.currentCells());
	});
});
