import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZERO_EVENT_ID } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import type { Registry } from "../../src/core/protocols";
import { parseScenario } from "../../src/core/scenario";
import { rngFromSeed } from "../../src/core/rng";
import { createSimulation, type Simulation } from "../../src/core/simulation";
import { timeAt } from "../../src/core/time";
import type { EntityId, JsonObject, JsonValue, Scenario } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { silentLogger } from "../../src/logging/logger";
import {
	EDGE_COLUMNS,
	EDGE_ENTITY,
	POST_COLUMNS,
	POST_ENTITY,
	REC_COLUMNS,
	REC_ENTITY,
	assignHubs,
	createRecommender,
	edgeListOf,
	homophilyOf,
	powerlawEdges,
	randomEdges,
	rewireToBand,
	stanceVectorOf,
	type IndexEdge,
} from "../../src/modules";
import { gatewayFactory } from "../helpers/kernel";
import { builtinRegistry } from "../helpers/registry";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-modules-"));

const scenarioOf = (overrides: JsonObject = {}): Scenario => {
	const parsed = parseScenario({
		scenarioId: "modules",
		seed: 11,
		population: {
			n: 30,
			fields: [
				{ name: "name", dtype: "str", sampling: { kind: "value", value: "Agent" } },
				{ name: "stance", dtype: "f64", sampling: { kind: "range", min: -2, max: 2 } },
			],
		},
		modules: [{ kind: "socialGraph", options: { meanDegree: 3 } }, { kind: "feed" }],
		executors: [
			{
				kind: "focal",
				name: "people",
				options: {
					provider: "main",
					components: [
						{ kind: "persona" },
						{ kind: "feedObservation", options: { size: 5 } },
						{ kind: "neighborhoodObservation" },
					],
				},
			},
		],
		providers: { main: { kind: "mock" } },
		policy: { kind: "explicit", options: { schedule: {} } },
		steps: [{ kind: "run", ticks: 3 }],
		...overrides,
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};

const build = (overrides: JsonObject = {}, registry: Registry = builtinRegistry()): Simulation => {
	const created = createSimulation(scenarioOf(overrides), registry, {
		outDir: tempDir(),
		logger: silentLogger,
		log: createMemoryEventLog(),
		createGateway: gatewayFactory,
	});
	if (!created.ok) throw new Error(`${created.error.excType}: ${created.error.message}`);
	return created.value;
};

const manual = (
	sim: Simulation,
	calls: readonly { id: EntityId; name: string; args: JsonObject }[],
) =>
	sim.step({
		agents: Object.fromEntries(calls.map((c) => [c.id, "manual" as const])),
		manualCalls: Object.fromEntries(
			calls.map((c) => [
				c.id,
				{ agentId: c.id, name: c.name, args: c.args, cause: ZERO_EVENT_ID },
			]),
		),
	});

const failureTypes = (sim: Simulation): readonly string[] =>
	sim.log
		.query({ kind: ["failure"] })
		.map((e) => (e.kind === "failure" ? e.payload.excType : ""));

const uniqueEdges = (edges: readonly IndexEdge[]): number =>
	new Set(edges.map(([a, b]) => `${a}-${b}`)).size;

describe("graph generators", () => {
	test("random draws n * meanDegree distinct directed edges without self loops", () => {
		const edges = randomEdges(100, 4, rngFromSeed(1, [0]));
		expect(edges).toHaveLength(400);
		expect(uniqueEdges(edges)).toBe(400);
		expect(edges.every(([a, b]) => a !== b)).toBe(true);
		expect(randomEdges(100, 4, rngFromSeed(1, [0]))).toEqual(edges);
	});

	test("powerlaw configuration model hits the mean degree with a heavy tail", () => {
		const n = 200;
		const edges = powerlawEdges(n, 8, 2.4, rngFromSeed(3, [0]));
		const mean = edges.length / n;
		expect(mean).toBeGreaterThan(4);
		expect(mean).toBeLessThan(12);
		expect(uniqueEdges(edges)).toBe(edges.length);
		expect(edges.every(([a, b]) => a !== b)).toBe(true);
		const inDegree = new Array<number>(n).fill(0);
		for (const [, b] of edges) inDegree[b] = (inDegree[b] ?? 0) + 1;
		expect(Math.max(...inDegree)).toBeGreaterThan(3 * mean);
	});
});

describe("homophily", () => {
	test("h is computed from edge covariance over source variance", () => {
		const h = homophilyOf(
			[
				[0, 1],
				[2, 3],
			],
			[1, 2, 3, 4],
		);
		expect(h).toBeCloseTo(0.6, 12);
		expect(homophilyOf([], [1, 2])).toBe(0);
	});

	test("double-edge swaps move h into the requested band and keep out-degrees", () => {
		const rng = rngFromSeed(5, [1]);
		const x = Array.from({ length: 100 }, () => -2 + 4 * rng.next());
		const edges = randomEdges(100, 8, rng.fork(1));
		const outDegree = (es: readonly IndexEdge[]) => {
			const d = new Array<number>(100).fill(0);
			for (const [a] of es) d[a] = (d[a] ?? 0) + 1;
			return d;
		};
		for (const band of [
			[0.22, 0.3],
			[0.02, 0.1],
			[-0.3, -0.2],
		] as const) {
			const result = rewireToBand(edges, x, band, rng.fork(2), 100000);
			expect(result.reached).toBe(true);
			expect(result.edges).toHaveLength(edges.length);
			expect(uniqueEdges(result.edges)).toBe(edges.length);
			expect(homophilyOf(result.edges, x)).toBeCloseTo(result.homophily, 9);
			expect(result.homophily).toBeGreaterThanOrEqual(band[0]);
			expect(result.homophily).toBeLessThanOrEqual(band[1]);
			expect(outDegree(result.edges)).toEqual(outDegree(edges));
		}
	});
});

describe("hub assignment", () => {
	const edges: readonly IndexEdge[] = [
		[0, 3],
		[1, 3],
		[2, 3],
		[0, 1],
		[2, 1],
		[5, 4],
	];
	const x = [0.5, -1, 2, 0, 1.5, -2];

	test("anti, pro and mixed set the top in-degree nodes to the extremes", () => {
		const rng = rngFromSeed(1, []);
		expect(assignHubs(edges, x, "anti", 2, rng)).toEqual([
			{ index: 3, value: -2 },
			{ index: 1, value: -2 },
		]);
		expect(assignHubs(edges, x, "pro", 2, rng)).toEqual([
			{ index: 3, value: 2 },
			{ index: 1, value: 2 },
		]);
		expect(assignHubs(edges, x, "mixed", 3, rng)).toEqual([
			{ index: 3, value: -2 },
			{ index: 1, value: 2 },
			{ index: 4, value: -2 },
		]);
	});

	test("random draws hub stances from the population and is seeded", () => {
		const a = assignHubs(edges, x, "random", 2, rngFromSeed(9, []));
		const b = assignHubs(edges, x, "random", 2, rngFromSeed(9, []));
		expect(a).toEqual(b);
		expect(a.map((h) => h.index)).toEqual([3, 1]);
		expect(a.every((h) => x.includes(h.value))).toBe(true);
		expect(assignHubs(edges, x, "pro", 0, rngFromSeed(9, []))).toEqual([]);
	});
});

describe("socialGraph module", () => {
	test("initialize writes the generated edges, graph() matches the edge table, observe lists neighbors", async () => {
		const sim = build();
		const init = await sim.initialize();
		expect(init.ok).toBe(true);
		expect(sim.world.count(EDGE_ENTITY)).toBe(90);
		const graph = sim.log.query({ kind: ["module_step"] });
		expect(graph).toHaveLength(1);
		expect(graph[0]?.t).toEqual(timeAt(0, 0, 0));
		expect(graph[0]?.kind === "module_step" && graph[0].payload.module).toBe("socialGraph");
		const kinds = sim.world.column<string>(EDGE_ENTITY, EDGE_COLUMNS.kind).toArray();
		expect(kinds.every((k) => k === "follow")).toBe(true);
		const [first] = sim.world.ids("agent") as [EntityId];
		await sim.step({ agents: { [first]: "llm" } });
		const observed = sim.log.query({ kind: ["observation"], agentId: first })[0];
		const prompt = sim.log.getContent(
			observed?.kind === "observation" ? observed.payload.contentSha : "",
		);
		const neighbors = sim.world
			.ids(EDGE_ENTITY)
			.filter((edge) => sim.world.row(EDGE_ENTITY, edge)?.[EDGE_COLUMNS.src] === first)
			.map((edge) => String(sim.world.row(EDGE_ENTITY, edge)?.[EDGE_COLUMNS.dst]));
		expect(neighbors.length).toBeGreaterThan(0);
		for (const neighbor of neighbors) expect(prompt).toContain(neighbor);
	});

	test("follow and unfollow change the edge table, bad targets are ActionRejected failures", async () => {
		const sim = build({
			modules: [{ kind: "socialGraph", options: { meanDegree: 0 } }, { kind: "feed" }],
		});
		const [a, b] = sim.world.ids("agent") as [EntityId, EntityId];
		expect((await manual(sim, [{ id: a, name: "follow", args: { target: b } }])).ok).toBe(true);
		expect(sim.world.count(EDGE_ENTITY)).toBe(1);
		expect(sim.world.column<string>(EDGE_ENTITY, EDGE_COLUMNS.src).at(0)).toBe(a);
		expect(sim.world.column<string>(EDGE_ENTITY, EDGE_COLUMNS.dst).at(0)).toBe(b);
		await manual(sim, [{ id: a, name: "follow", args: { target: b } }]);
		expect(sim.world.count(EDGE_ENTITY)).toBe(1);
		await manual(sim, [{ id: b, name: "follow", args: { target: "nobody" } }]);
		await manual(sim, [{ id: b, name: "follow", args: { target: b } }]);
		await manual(sim, [{ id: b, name: "unfollow", args: { target: a } }]);
		expect(failureTypes(sim)).toEqual(["ActionRejected", "ActionRejected", "ActionRejected"]);
		expect((await manual(sim, [{ id: a, name: "unfollow", args: { target: b } }])).ok).toBe(
			true,
		);
		expect(sim.world.count(EDGE_ENTITY)).toBe(0);
		expect(sim.integrity()).toMatchObject({ activated: 6, ok: 6, failed: 0, complete: true });
	});

	test("each tick the observation neighbors and graph() follow the edge table", async () => {
		const sim = build({
			modules: [{ kind: "socialGraph", options: { meanDegree: 0 } }, { kind: "feed" }],
			policy: { kind: "allAgents" },
		});
		const [a, b, c] = sim.world.ids("agent") as [EntityId, EntityId, EntityId];
		await manual(sim, [{ id: a, name: "follow", args: { target: b } }]);
		await manual(sim, [
			{ id: a, name: "follow", args: { target: c } },
			{ id: b, name: "follow", args: { target: a } },
		]);
		await sim.step({ agents: { [a]: "llm" } });
		const observed = sim.log.query({ kind: ["observation"], agentId: a, tick: 2 })[0];
		const prompt = sim.log.getContent(
			observed?.kind === "observation" ? observed.payload.contentSha : "",
		);
		expect(prompt).toContain(b);
		expect(prompt).toContain(c);
		expect(sim.world.count(EDGE_ENTITY)).toBe(3);
		const graph = sim.log.query({ kind: ["module_step"] });
		expect(graph.length).toBeGreaterThan(0);
	});

	test("options select generator, homophily band and hub assignment", async () => {
		const rewired = build({
			population: {
				n: 100,
				fields: [
					{ name: "stance", dtype: "f64", sampling: { kind: "range", min: -2, max: 2 } },
				],
			},
			modules: [
				{
					kind: "socialGraph",
					options: {
						generator: "powerlaw",
						meanDegree: 8,
						exponent: 2.4,
						stanceColumn: "persona.stance",
						homophilyBand: [0.22, 0.3],
						hubAssignment: "anti",
						hubCount: 5,
					},
				},
			],
			executors: [],
			providers: {},
		});
		expect((await rewired.initialize()).ok).toBe(true);
		const edges = edgeListOf(rewired.world, "agent");
		expect(edges).toHaveLength(rewired.world.count(EDGE_ENTITY));
		const stance = stanceVectorOf(rewired.world, "agent", "persona.stance");
		const h = homophilyOf(edges, stance);
		expect(h).toBeGreaterThanOrEqual(0.22);
		expect(h).toBeLessThanOrEqual(0.3);
		const inDegree = new Map<number, number>();
		for (const [, j] of edges) inDegree.set(j, (inDegree.get(j) ?? 0) + 1);
		const hubs = [...inDegree.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 5);
		const min = Math.min(...stance);
		expect(hubs.every(([i]) => stance[i] === min)).toBe(true);
		const sets = rewired.log.query({ kind: ["module_step"] })[0];
		expect(sets?.kind === "module_step" && JSON.stringify(sets.payload.summary)).toContain(
			'"op":"set"',
		);

		for (const [mode, expected] of [
			["pro", (v: number, lo: number, hi: number) => v === hi && lo < hi],
			["mixed", (v: number, lo: number, hi: number) => v === lo || v === hi],
			["random", (v: number, lo: number, hi: number) => v >= lo && v <= hi],
		] as const) {
			const sim = build({
				modules: [
					{
						kind: "socialGraph",
						options: {
							meanDegree: 3,
							stanceColumn: "persona.stance",
							hubAssignment: mode,
							hubCount: 4,
						},
					},
				],
				executors: [],
				providers: {},
			});
			expect((await sim.initialize()).ok).toBe(true);
			const values = stanceVectorOf(sim.world, "agent", "persona.stance");
			const lo = Math.min(...values);
			const hi = Math.max(...values);
			const degrees = new Map<number, number>();
			for (const [, j] of edgeListOf(sim.world, "agent"))
				degrees.set(j, (degrees.get(j) ?? 0) + 1);
			const top = [...degrees.entries()]
				.sort((x, y) => y[1] - x[1] || x[0] - y[0])
				.slice(0, 4)
				.map(([i]) => values[i] ?? Number.NaN);
			expect(top.every((v) => expected(v, lo, hi))).toBe(true);
		}
	});

	test("homophily and hub options require a stance column", () => {
		const registry = builtinRegistry();
		const created = createSimulation(
			scenarioOf({
				modules: [{ kind: "socialGraph", options: { homophilyBand: [0, 0.1] } }],
			}),
			registry,
			{
				outDir: tempDir(),
				logger: silentLogger,
				log: createMemoryEventLog(),
				createGateway: gatewayFactory,
			},
		);
		expect(created.ok).toBe(false);
		if (!created.ok) expect(created.error.message).toContain("stanceColumn");
	});
});

describe("feed module", () => {
	test("silent is the fallback and post/like/repost/reply write the post table", async () => {
		const sim = build();
		const registry = builtinRegistry();
		build({}, registry);
		expect(registry.actions.fallback()?.name).toBe("silent");
		const [a, b] = sim.world.ids("agent") as [EntityId, EntityId];
		expect((await manual(sim, [{ id: a, name: "post", args: { content: "hello" } }])).ok).toBe(
			true,
		);
		const [postId] = sim.world.ids(POST_ENTITY) as [EntityId];
		expect(sim.world.row(POST_ENTITY, postId)).toMatchObject({
			[POST_COLUMNS.author]: a,
			[POST_COLUMNS.content]: "hello",
			[POST_COLUMNS.t]: 0,
			[POST_COLUMNS.likes]: 0,
			[POST_COLUMNS.parent]: "",
		});
		await manual(sim, [
			{ id: b, name: "like", args: { postId } },
			{ id: a, name: "like", args: { postId } },
		]);
		expect(sim.world.row(POST_ENTITY, postId)?.[POST_COLUMNS.likes]).toBe(2);
		await manual(sim, [{ id: b, name: "repost", args: { postId } }]);
		expect(sim.world.count(POST_ENTITY)).toBe(2);
		const repost = sim.world.ids(POST_ENTITY)[1] as EntityId;
		expect(sim.world.row(POST_ENTITY, repost)).toMatchObject({
			[POST_COLUMNS.author]: b,
			[POST_COLUMNS.content]: "hello",
			[POST_COLUMNS.parent]: postId,
			[POST_COLUMNS.t]: 2,
		});
		expect(sim.world.row(POST_ENTITY, postId)?.[POST_COLUMNS.reposts]).toBe(1);
		await manual(sim, [{ id: a, name: "reply", args: { postId: repost, content: "thanks" } }]);
		expect(sim.world.row(POST_ENTITY, sim.world.ids(POST_ENTITY)[2] as EntityId)).toMatchObject(
			{
				[POST_COLUMNS.author]: a,
				[POST_COLUMNS.content]: "thanks",
				[POST_COLUMNS.parent]: repost,
			},
		);
		await manual(sim, [
			{ id: a, name: "like", args: { postId: "missing" } },
			{ id: b, name: "silent", args: {} },
		]);
		expect(failureTypes(sim)).toEqual(["ActionRejected"]);
		expect(sim.world.count(POST_ENTITY)).toBe(3);
		expect(sim.integrity()).toMatchObject({ failed: 0, complete: true });
	});

	test("rec table is rebuilt every tick and observe reads only rec", async () => {
		const sim = build({
			modules: [
				{ kind: "socialGraph", options: { meanDegree: 0 } },
				{ kind: "feed", options: { size: 2, recommender: "recency" } },
			],
		});
		const [a, b, c] = sim.world.ids("agent") as [EntityId, EntityId, EntityId];
		await manual(sim, [{ id: a, name: "post", args: { content: "first" } }]);
		expect(sim.world.count(REC_ENTITY)).toBe(30);
		const recOf = (id: EntityId) => sim.world.row(REC_ENTITY, id)?.[REC_COLUMNS.posts];
		const [first] = sim.world.ids(POST_ENTITY);
		expect(recOf(b)).toEqual([first as string]);
		expect(recOf(a)).toEqual([]);
		await manual(sim, [
			{ id: b, name: "post", args: { content: "second" } },
			{ id: c, name: "post", args: { content: "third" } },
		]);
		const posts = sim.world.ids(POST_ENTITY);
		expect(recOf(a)).toEqual([posts[2] as string, posts[1] as string]);
		expect(recOf(b)).toEqual([posts[2] as string, posts[0] as string]);
		expect(sim.world.count(REC_ENTITY)).toBe(30);
		await sim.step({ agents: { [a]: "llm" } });
		const observed = sim.log.query({ kind: ["observation"], agentId: a })[0];
		const prompt = sim.log.getContent(
			observed?.kind === "observation" ? observed.payload.contentSha : "",
		);
		expect(prompt).toContain("third");
		expect(prompt).toContain("second");
		expect(prompt).not.toContain("first");
	});
});

describe("recommenders", () => {
	const world = createWorld();
	for (const [name, dtype, fallback] of [
		["author", "str", ""],
		["content", "str", ""],
		["t", "i32", 0],
		["likes", "i32", 0],
		["reposts", "i32", 0],
		["parent", "str", ""],
	] as const) {
		const r = world.declare({
			entity: POST_ENTITY,
			name,
			dtype,
			default: fallback,
			owner: "feed",
			merge: "last",
		});
		if (!r.ok) throw new Error(r.error.message);
	}
	for (const name of ["src", "dst", "kind"] as const) {
		const r = world.declare({
			entity: EDGE_ENTITY,
			name,
			dtype: "str",
			default: "",
			owner: "socialGraph",
			merge: "last",
		});
		if (!r.ok) throw new Error(r.error.message);
	}
	const stance = world.declare({
		entity: "agent",
		name: "stance",
		dtype: "f64",
		default: 0,
		owner: "persona",
		merge: "last",
	});
	if (!stance.ok) throw new Error(stance.error.message);
	const rng = rngFromSeed(2, [7]);
	const [u, v, w] = world.create(
		"agent",
		[{ "persona.stance": 0 }, { "persona.stance": 1 }, { "persona.stance": -1.5 }],
		rng,
	) as [EntityId, EntityId, EntityId];
	const posts = world.create(
		POST_ENTITY,
		[
			{ [POST_COLUMNS.author]: v, [POST_COLUMNS.t]: 0 },
			{ [POST_COLUMNS.author]: w, [POST_COLUMNS.t]: 1 },
			{ [POST_COLUMNS.author]: v, [POST_COLUMNS.t]: 2 },
			{ [POST_COLUMNS.author]: u, [POST_COLUMNS.t]: 3 },
		],
		rng,
	) as [EntityId, EntityId, EntityId, EntityId];
	world.create(
		EDGE_ENTITY,
		[{ [EDGE_COLUMNS.src]: u, [EDGE_COLUMNS.dst]: w, [EDGE_COLUMNS.kind]: "follow" }],
		rng,
	);
	const rank = (kind: "random" | "recency" | "followingFirst" | "homophily") =>
		createRecommender(kind, { column: "persona.stance" }).rank(
			world,
			[u],
			timeAt(4),
			rngFromSeed(1, []),
			3,
		)[u];

	test("recency orders newest first and drops the user's own posts", () => {
		expect(rank("recency")).toEqual([posts[2], posts[1], posts[0]]);
	});

	test("followingFirst puts followed authors ahead of the rest", () => {
		expect(rank("followingFirst")).toEqual([posts[1], posts[2], posts[0]]);
	});

	test("homophily sorts by stance distance then recency", () => {
		expect(rank("homophily")).toEqual([posts[2], posts[0], posts[1]]);
	});

	test("random is a seeded permutation of the candidates", () => {
		const a = rank("random");
		expect([...(a ?? [])].sort()).toEqual([posts[0], posts[1], posts[2]].sort());
		expect(rank("random")).toEqual(a);
	});
});

describe("calendar module", () => {
	test("injects the event scheduled for the current tick into env", async () => {
		const sim = build({
			modules: [
				{
					kind: "calendar",
					options: { events: { "0": "launch", "2": { name: "debate" } } },
				},
			],
		});
		const seen: JsonValue[] = [];
		expect((await sim.initialize()).ok).toBe(true);
		for (let i = 0; i < 3; i += 1) {
			seen.push(sim.world.env("calendar.current") ?? null);
			await sim.step();
		}
		expect(seen).toEqual(["launch", null, { name: "debate" }]);
		expect(sim.world.env("calendar.current")).toBeNull();
	});
});

describe("100 agents for 10 ticks under mock", () => {
	test("runs to completion with only ActionRejected failures and consistent tables", async () => {
		const sim = build({
			population: {
				n: 100,
				fields: [
					{ name: "stance", dtype: "f64", sampling: { kind: "range", min: -2, max: 2 } },
				],
			},
			modules: [
				{
					kind: "socialGraph",
					options: {
						generator: "powerlaw",
						meanDegree: 8,
						exponent: 2.4,
						stanceColumn: "persona.stance",
						homophilyBand: [0.12, 0.2],
						hubAssignment: "mixed",
						hubCount: 5,
					},
				},
				{ kind: "feed", options: { size: 5, recommender: "followingFirst" } },
				{ kind: "calendar", options: { events: { "3": "news" } } },
			],
			policy: { kind: "bernoulli", options: { p: 0.5 } },
		});
		for (let i = 0; i < 10; i += 1) {
			const r = await sim.step();
			expect(r.ok).toBe(true);
		}
		const integrity = sim.integrity();
		expect(integrity.complete).toBe(true);
		expect(integrity.failed).toBe(0);
		expect(integrity.parseFailures).toBe(0);
		expect(integrity.activated).toBeGreaterThan(300);
		expect(new Set(failureTypes(sim))).toEqual(new Set(["ActionRejected"]));
		expect(sim.world.count(REC_ENTITY)).toBe(100);
		expect(sim.world.count(POST_ENTITY)).toBeGreaterThan(20);
		const decisions = sim.log.query({ kind: ["decision"] });
		expect(decisions.some((d) => d.kind === "decision" && d.payload.action === "silent")).toBe(
			true,
		);
		const steps = sim.log.query({ kind: ["module_step"] });
		expect(
			steps.filter((e) => e.kind === "module_step" && e.payload.module === "feed"),
		).toHaveLength(10);
		expect(sim.world.count(EDGE_ENTITY)).toBeGreaterThan(500);
		const initialized = sim.log
			.query({ kind: ["module_step"], tick: 0 })
			.filter((e) => e.t.substep === 0)
			.map((e) => (e.kind === "module_step" ? e.payload.module : ""));
		expect(initialized).toEqual(["socialGraph", "calendar"]);
	});
});
