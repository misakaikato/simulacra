import { describe, expect, test } from "bun:test";
import { rngFromSeed } from "../../src/core/rng";
import { matchesPredicate, selectAgents } from "../../src/core/selector";
import { createWorld } from "../../src/core/world";

const buildWorld = () => {
	const world = createWorld();
	for (const [name, dtype, fallback] of [
		["group", "str", ""],
		["stance", "f64", 0],
	] as const) {
		const r = world.declare({
			entity: "agent",
			name,
			dtype,
			default: fallback,
			owner: "persona",
			merge: "last",
		});
		if (!r.ok) throw new Error(r.error.message);
	}
	const rows = Array.from({ length: 40 }, (_, i) => ({
		"persona.group": i % 4 === 0 ? "a" : i % 4 === 1 ? "b" : "c",
		"persona.stance": (i - 20) / 10,
	}));
	const ids = world.create("agent", rows, rngFromSeed(3, []));
	return { world, ids };
};

describe("selectAgents", () => {
	test("where supports equality, in, gt and lt", () => {
		const { world, ids } = buildWorld();
		const rng = rngFromSeed(1, []);
		expect(selectAgents(world, { where: { "persona.group": "a" } }, rng)).toHaveLength(10);
		expect(
			selectAgents(world, { where: { "persona.group": { in: ["a", "b"] } } }, rng),
		).toHaveLength(20);
		expect(selectAgents(world, { where: { "persona.stance": { gt: 0 } } }, rng)).toHaveLength(
			19,
		);
		expect(
			selectAgents(world, { where: { "persona.stance": { lt: -1.5 } } }, rng),
		).toHaveLength(5);
		expect(
			selectAgents(
				world,
				{ where: { "persona.group": "c", "persona.stance": { gt: 1 } } },
				rng,
			),
		).toHaveLength(5);
		expect(selectAgents(world, { where: {} }, rng)).toEqual(ids);
		expect(selectAgents(world, { where: { "persona.absent": 1 } }, rng)).toEqual([]);
	});

	test("fraction and n sample deterministically from the seed", () => {
		const { world } = buildWorld();
		const half = selectAgents(world, { where: {}, fraction: 0.5 }, rngFromSeed(9, [1]));
		expect(half).toHaveLength(20);
		expect(selectAgents(world, { where: {}, fraction: 0.5 }, rngFromSeed(9, [1]))).toEqual(
			half,
		);
		expect(selectAgents(world, { where: {}, fraction: 0.5 }, rngFromSeed(9, [2]))).not.toEqual(
			half,
		);
		const few = selectAgents(
			world,
			{ where: { "persona.group": "c" }, n: 3 },
			rngFromSeed(9, [1]),
		);
		expect(few).toHaveLength(3);
		expect(
			selectAgents(world, { where: {}, fraction: 0.5, n: 4 }, rngFromSeed(9, [1])),
		).toHaveLength(4);
		expect(selectAgents(world, { where: {}, n: 100 }, rngFromSeed(9, [1]))).toHaveLength(40);
		expect(selectAgents(world, { where: {}, fraction: 0 }, rngFromSeed(9, [1]))).toEqual([]);
	});

	test("predicates compare scalars by value", () => {
		expect(matchesPredicate("a", "a")).toBe(true);
		expect(matchesPredicate(1, "1")).toBe(false);
		expect(matchesPredicate(["x", "y"], ["x", "y"])).toBe(true);
		expect(matchesPredicate(2, { gt: 1 })).toBe(true);
		expect(matchesPredicate("2", { gt: 1 })).toBe(false);
		expect(matchesPredicate(undefined, { in: [1] })).toBe(false);
		expect(matchesPredicate(null, null)).toBe(true);
	});
});
