import { describe, expect, test } from "bun:test";
import { makeEvent } from "../../src/core/events";
import { makeRunId, newEventId, toEntityId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import type { PluginContext } from "../../src/core/protocols";
import { rngFromSeed } from "../../src/core/rng";
import { parseScenario } from "../../src/core/scenario";
import { timeAt } from "../../src/core/time";
import type { EntityId, JsonObject } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { silentLogger } from "../../src/logging/logger";
import {
	actionShareMetric,
	assortativityOf,
	groupLookup,
	groupedEdges,
	histogramOf,
	interactionEdges,
	ratioMetric,
	sameGroupRatioOf,
	stanceGroup,
	tvdOf,
	tvdToTargetMetric,
} from "../../src/metrics";
import { POST_COLUMNS, POST_ENTITY } from "../../src/modules";
import { builtinRegistry } from "../helpers/registry";

const runId = makeRunId("metrics", 0);
const rng = rngFromSeed(4, [1]);

const declareColumn = (
	world: ReturnType<typeof createWorld>,
	entity: string,
	owner: string,
	name: string,
	dtype: "f64" | "i32" | "str",
) => {
	const r = world.declare({
		entity,
		name,
		dtype,
		default: dtype === "str" ? "" : 0,
		owner,
		merge: "last",
	});
	if (!r.ok) throw new Error(r.error.message);
};

const pdWorld = () => {
	const world = createWorld();
	declareColumn(world, "agent", "pd", "cooperations", "i32");
	declareColumn(world, "agent", "pd", "rounds", "i32");
	declareColumn(world, "agent", "pd", "payoff", "f64");
	world.create(
		"agent",
		[
			{ "pd.cooperations": 2, "pd.rounds": 3, "pd.payoff": 9 },
			{ "pd.cooperations": 1, "pd.rounds": 3, "pd.payoff": 6 },
		],
		rng,
	);
	return world;
};

const decision = (agentId: EntityId, action: string, args: JsonObject, tick = 0) =>
	makeEvent(
		{ eventId: newEventId(rng), runId, t: timeAt(tick, 1, 1), seedPath: [], agentId },
		{ kind: "decision", payload: { action, args, provider: "test", parseOk: true } },
	);

describe("cooperationRate and averagePayoff", () => {
	test("divide column sums and return 0 without rounds", () => {
		const world = pdWorld();
		const log = createMemoryEventLog();
		expect(
			ratioMetric("c", "agent", "pd.cooperations", "pd.rounds").compute(world, log, runId),
		).toBe(0.5);
		expect(ratioMetric("p", "agent", "pd.payoff", "pd.rounds").compute(world, log, runId)).toBe(
			2.5,
		);
		expect(
			ratioMetric("c", "agent", "pd.cooperations", "pd.missing").compute(world, log, runId),
		).toBe(0);
	});
});

describe("stanceAssortativity and sameGroupRatio", () => {
	test("r follows the group mixing formula on a hand-computed sample", () => {
		const edges = [
			["a", "a"],
			["a", "a"],
			["b", "b"],
			["a", "b"],
		] as const;
		expect(assortativityOf(edges)).toBeCloseTo(0.5, 12);
		expect(sameGroupRatioOf(edges)).toBeCloseTo(0.75, 12);
		expect(assortativityOf([])).toBe(0);
		expect(assortativityOf([["a", "a"]])).toBe(0);
	});

	test("stance thresholds and interaction edges from decisions and the post table", () => {
		expect([-2, -0.5, 0.5, 1.2].map(stanceGroup)).toEqual([
			"anti",
			"neutral",
			"neutral",
			"pro",
		]);
		const world = createWorld();
		declareColumn(world, "agent", "persona", "stance", "f64");
		declareColumn(world, "agent", "persona", "camp", "str");
		declareColumn(world, POST_ENTITY, "feed", "author", "str");
		const [a, b, c] = world.create(
			"agent",
			[
				{ "persona.stance": -1.5, "persona.camp": "x" },
				{ "persona.stance": -1, "persona.camp": "y" },
				{ "persona.stance": 1.5, "persona.camp": "y" },
			],
			rng,
		) as [EntityId, EntityId, EntityId];
		const [p1, p2] = world.create(
			POST_ENTITY,
			[{ [POST_COLUMNS.author]: b }, { [POST_COLUMNS.author]: c }],
			rng,
		) as [EntityId, EntityId];
		const log = createMemoryEventLog();
		log.append(decision(a, "repost", { postId: p1 }));
		log.append(decision(a, "reply", { postId: p2, content: "no" }));
		log.append(decision(b, "like", { postId: p2 }));
		log.append(decision(c, "reply", { postId: "missing", content: "?" }));
		log.append(decision(c, "post", { content: "hi" }));
		const options = {
			postEntity: POST_ENTITY,
			authorColumn: POST_COLUMNS.author,
			actions: ["repost", "reply"],
		};
		const edges = interactionEdges(world, log, options);
		expect(edges).toEqual([
			[a, b],
			[a, c],
		]);
		const byStance = groupedEdges(
			edges,
			groupLookup(world, { entity: "agent", stanceColumn: "persona.stance" }),
		);
		expect(byStance).toEqual([
			["anti", "anti"],
			["anti", "pro"],
		]);
		expect(sameGroupRatioOf(byStance)).toBe(0.5);
		const byCamp = groupedEdges(
			edges,
			groupLookup(world, { entity: "agent", groupColumn: "persona.camp" }),
		);
		expect(byCamp).toEqual([
			["x", "y"],
			["x", "y"],
		]);
		expect(assortativityOf(byCamp)).toBe(0);
	});
});

describe("actionShare", () => {
	test("is the share of decision events choosing the action", () => {
		const log = createMemoryEventLog();
		const world = createWorld();
		const metric = actionShareMetric("postShare", "post");
		expect(metric.compute(world, log, runId)).toBe(0);
		const id = toEntityId("agent-1");
		log.append(decision(id, "post", { content: "a" }, 0));
		log.append(decision(id, "post", { content: "b" }, 1));
		log.append(decision(id, "like", { postId: "x" }, 2));
		expect(metric.compute(world, log, runId)).toBeCloseTo(2 / 3, 12);
	});
});

describe("tvdToTarget", () => {
	test("bins numeric columns over a range and categories by name", () => {
		expect(
			histogramOf([0, 1, 2, 3, 4], {
				entity: "agent",
				column: "x",
				target: [1, 1, 1, 1],
				range: [0, 4],
			}),
		).toEqual([1, 1, 1, 2]);
		expect(
			histogramOf(["a", "b", "b", "z"], {
				entity: "agent",
				column: "x",
				target: [1, 1],
				categories: ["a", "b"],
			}),
		).toEqual([1, 2]);
		expect(tvdOf([0.5, 0.5, 0], [1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(1 / 3, 12);
		const world = createWorld();
		declareColumn(world, "agent", "persona", "stance", "f64");
		world.create(
			"agent",
			[
				{ "persona.stance": -2 },
				{ "persona.stance": -1.9 },
				{ "persona.stance": 0 },
				{ "persona.stance": 1.9 },
			],
			rng,
		);
		const metric = tvdToTargetMetric("tvd", {
			entity: "agent",
			column: "persona.stance",
			target: [1, 1, 1],
			range: [-2, 2],
		});
		expect(metric.compute(world, createMemoryEventLog(), runId)).toBeCloseTo(1 / 6, 12);
	});
});

describe("registerBuiltinMetrics", () => {
	test("creates all six metrics from instrument specs", () => {
		const registry = builtinRegistry();
		const scenario = parseScenario({ scenarioId: "m", seed: 1, population: { n: 1 } });
		if (!scenario.ok) throw new Error("scenario");
		const ctx: PluginContext = { scenario: scenario.value, registry, logger: silentLogger };
		const specs = [
			{ kind: "cooperationRate" },
			{ kind: "averagePayoff" },
			{ kind: "stanceAssortativity", options: { stanceColumn: "persona.stance" } },
			{ kind: "sameGroupRatio", options: { groupColumn: "persona.group" } },
			{ kind: "actionShare", name: "postShare", options: { action: "post" } },
			{ kind: "tvdToTarget", options: { column: "persona.stance", target: [1, 2] } },
		];
		for (const spec of specs) {
			const created = registry.metrics.create(spec, ctx);
			expect(created.ok).toBe(true);
			if (created.ok) expect(created.value.name).toBe(spec.name ?? spec.kind);
		}
		expect(registry.metrics.create({ kind: "stanceAssortativity" }, ctx).ok).toBe(false);
		expect(registry.metrics.create({ kind: "actionShare" }, ctx).ok).toBe(false);
		const world = pdWorld();
		const rate = registry.metrics.create({ kind: "cooperationRate" }, ctx);
		if (rate.ok) expect(rate.value.compute(world, createMemoryEventLog(), runId)).toBe(0.5);
	});
});
