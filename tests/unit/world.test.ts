import { describe, expect, test } from "bun:test";
import { toEntityId, toEventId } from "../../src/core/ids";
import { applyEffects } from "../../src/core/resolver";
import { rngFromSeed } from "../../src/core/rng";
import { timeAt } from "../../src/core/time";
import type { ColumnDecl, Effect, EntityId, Scalar } from "../../src/core/types";
import { IdCollision, createWorld, qualifiedColumnName, restoreWorld } from "../../src/core/world";

const decl = (partial: Partial<ColumnDecl> & Pick<ColumnDecl, "name" | "dtype">): ColumnDecl => ({
	entity: "agent",
	owner: "kernel",
	default:
		partial.dtype === "str"
			? ""
			: partial.dtype === "strlist"
				? []
				: partial.dtype === "bool"
					? false
					: 0,
	merge: "last",
	...partial,
});

const cause = toEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

const setup = () => {
	const world = createWorld();
	for (const d of [
		decl({ name: "score", dtype: "f64" }),
		decl({ name: "age", dtype: "i32" }),
		decl({ name: "active", dtype: "bool", default: true }),
		decl({ name: "label", dtype: "str", default: "none" }),
		decl({ name: "tags", dtype: "strlist" }),
		decl({ name: "stance", dtype: "f64", owner: "persona" }),
	]) {
		const r = world.declare(d);
		if (!r.ok) throw new Error(r.error.message);
	}
	return world;
};

describe("World declarations", () => {
	test("module columns get the owner prefix and kernel columns do not", () => {
		expect(qualifiedColumnName({ owner: "kernel", name: "x" })).toBe("x");
		expect(qualifiedColumnName({ owner: "feed", name: "x" })).toBe("feed.x");
		const world = setup();
		expect(world.columns("agent").map((c) => c.name)).toEqual([
			"score",
			"age",
			"active",
			"label",
			"tags",
			"persona.stance",
		]);
		expect(world.entities).toEqual(["agent"]);
	});

	test("redeclaring the same column is idempotent; changing dtype is a ColumnConflict", () => {
		const world = setup();
		expect(world.declare(decl({ name: "score", dtype: "f64" })).ok).toBe(true);
		const conflict = world.declare(decl({ name: "score", dtype: "str" }));
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) expect(conflict.error.kind).toBe("ColumnConflict");
		const other = world.declare(decl({ name: "score", dtype: "f64", owner: "feed" }));
		expect(other.ok).toBe(true);
	});

	test("merge rules must fit the dtype and defaults must be coercible", () => {
		const world = createWorld();
		expect(world.declare(decl({ name: "a", dtype: "str", merge: "sum" })).ok).toBe(false);
		expect(world.declare(decl({ name: "b", dtype: "f64", merge: "append" })).ok).toBe(false);
		expect(world.declare(decl({ name: "c", dtype: "i32", default: 1.5 })).ok).toBe(false);
		expect(world.declare(decl({ name: "d", dtype: "bool", merge: "max" })).ok).toBe(true);
	});

	test("declaring a column after rows exist fills the default", () => {
		const world = setup();
		world.create("agent", [{}, {}], rngFromSeed(1, []));
		expect(world.declare(decl({ name: "late", dtype: "str", default: "d" })).ok).toBe(true);
		expect(world.column<string>("agent", "late").toArray()).toEqual(["d", "d"]);
	});
});

describe("World rows and views", () => {
	test("create assigns ULIDs from the rng, applies defaults and validates rows", () => {
		const world = setup();
		const ids = world.create(
			"agent",
			[
				{ score: 1.5, label: "x", tags: ["t"] },
				{ age: 3, active: false },
			],
			rngFromSeed(1, []),
		);
		expect(ids).toHaveLength(2);
		expect(world.count("agent")).toBe(2);
		expect(world.ids("agent")).toEqual(ids);
		expect(world.row("agent", ids[0]!)).toEqual({
			score: 1.5,
			age: 0,
			active: true,
			label: "x",
			tags: ["t"],
			"persona.stance": 0,
		});
		expect(world.row("agent", ids[1]!)).toEqual({
			score: 0,
			age: 3,
			active: false,
			label: "none",
			tags: [],
			"persona.stance": 0,
		});
		const col = world.column<number>("agent", "score");
		expect(col.length).toBe(2);
		expect(col.at(0)).toBe(1.5);
		expect(col.get(ids[1]!)).toBe(0);
		expect(col.get(toEntityId("missing"))).toBeUndefined();
		expect(() => col.at(2)).toThrow(RangeError);
		expect(() => world.column("agent", "nope")).toThrow(RangeError);
		expect(() => world.create("agent", [{ nope: 1 }], rngFromSeed(2, []))).toThrow(TypeError);
		expect(() => world.create("agent", [{ age: 1.5 }], rngFromSeed(2, []))).toThrow(TypeError);
		expect(world.row("agent", toEntityId("missing"))).toBeUndefined();
		expect(world.ids("ghost")).toEqual([]);
		expect(world.count("ghost")).toBe(0);
	});

	test("same rng stream gives the same ids; reusing a stream position throws IdCollision", () => {
		const a = setup();
		const b = setup();
		expect(a.create("agent", [{}, {}], rngFromSeed(9, [1]))).toEqual(
			b.create("agent", [{}, {}], rngFromSeed(9, [1])),
		);
		const world = setup();
		world.create("agent", [{}], rngFromSeed(3, []));
		expect(() => world.create("agent", [{}], rngFromSeed(3, []))).toThrow(IdCollision);
	});

	test("storage grows past the initial capacity", () => {
		const world = setup();
		const rows = Array.from({ length: 1000 }, (_, i) => ({ score: i, age: i, label: `l${i}` }));
		const ids = world.create("agent", rows, rngFromSeed(4, []));
		expect(world.count("agent")).toBe(1000);
		expect(world.column<number>("agent", "score").at(999)).toBe(999);
		expect(world.column<number>("agent", "age").get(ids[500]!)).toBe(500);
		expect(world.column<string>("agent", "label").at(731)).toBe("l731");
	});
});

describe("World snapshots", () => {
	const randomEffects = (world: ReturnType<typeof setup>, n: number): readonly Effect[] => {
		const rng = rngFromSeed(77, [n]);
		const ids = world.create(
			"agent",
			Array.from({ length: 20 }, () => ({})),
			rng.fork(1),
		);
		const effects: Effect[] = [];
		for (let i = 0; i < n; i += 1) {
			const id = rng.pick(ids);
			switch (rng.int(7)) {
				case 0:
					effects.push({
						op: "set",
						entity: "agent",
						id,
						column: "score",
						value: rng.normal(),
						cause,
					});
					break;
				case 1:
					effects.push({
						op: "inc",
						entity: "agent",
						id,
						column: "age",
						value: rng.int(5),
						cause,
					});
					break;
				case 2:
					effects.push({
						op: "append",
						entity: "agent",
						id,
						column: "tags",
						value: `t${rng.int(9)}`,
						cause,
					});
					break;
				case 3:
					effects.push({
						op: "set",
						entity: "agent",
						id,
						column: "active",
						value: rng.bernoulli(0.5),
						cause,
					});
					break;
				case 4:
					effects.push({
						op: "envSet",
						key: `k${rng.int(3)}`,
						value: { v: rng.int(100) },
						cause,
					});
					break;
				case 5:
					effects.push({
						op: "setColumn",
						entity: "agent",
						column: "label",
						ids: [id, rng.pick(ids)],
						values: [`a${rng.int(9)}`, `b${rng.int(9)}`],
						cause,
					});
					break;
				default:
					effects.push({
						op: "set",
						entity: "agent",
						id,
						column: "persona.stance",
						value: rng.next(),
						cause,
					});
			}
		}
		return effects;
	};

	test("hash after a random effect sequence equals snapshot -> restore -> hash", () => {
		const world = setup();
		const effects = randomEffects(world, 300);
		const before = world.hash();
		const report = applyEffects(world, effects, timeAt(1));
		expect(report.rejected).toEqual([]);
		expect(report.applied).toBe(300);
		const after = world.hash();
		expect(after).not.toBe(before);
		const snap = world.snapshot();
		const restored = restoreWorld(JSON.parse(JSON.stringify(snap)));
		expect(restored.hash()).toBe(after);
		for (const id of world.ids("agent")) {
			expect(restored.row("agent", id)).toEqual(world.row("agent", id));
		}
		expect(restored.env("k0")).toEqual(world.env("k0"));
		expect(restored.ids("agent")).toEqual(world.ids("agent"));
	});

	test("a restored world keeps accepting effects identically to the original", () => {
		const world = setup();
		const effects = randomEffects(world, 50);
		applyEffects(world, effects.slice(0, 25), timeAt(1));
		const restored = restoreWorld(world.snapshot());
		applyEffects(world, effects.slice(25), timeAt(2));
		applyEffects(restored, effects.slice(25), timeAt(2));
		expect(restored.hash()).toBe(world.hash());
	});

	test("delete swaps the last row in and the snapshot stays consistent", () => {
		const world = setup();
		const ids = world.create("agent", [{ age: 1 }, { age: 2 }, { age: 3 }], rngFromSeed(5, []));
		const report = applyEffects(
			world,
			[{ op: "delete", entity: "agent", id: ids[0]!, cause }],
			timeAt(1),
		);
		expect(report.applied).toBe(1);
		expect(world.ids("agent")).toEqual([ids[2]!, ids[1]!]);
		expect(world.column<number>("agent", "age").toArray()).toEqual([3, 2]);
		expect(world.row("agent", ids[0]!)).toBeUndefined();
		expect(restoreWorld(world.snapshot()).hash()).toBe(world.hash());
	});

	test("env values are read back typed and survive snapshots", () => {
		const world = setup();
		applyEffects(
			world,
			[{ op: "envSet", key: "calendar.current", value: { day: 2 }, cause }],
			timeAt(0),
		);
		expect(world.env<{ day: number }>("calendar.current")?.day).toBe(2);
		expect(world.env("missing")).toBeUndefined();
		expect(restoreWorld(world.snapshot()).env("calendar.current")).toEqual({ day: 2 });
	});
});

describe("column value coercion", () => {
	test("null resets a cell to the column default", () => {
		const world = setup();
		const [id] = world.create("agent", [{ label: "x", score: 4 }], rngFromSeed(6, []));
		const effects: Effect[] = [
			{ op: "set", entity: "agent", id: id!, column: "label", value: null, cause },
			{ op: "set", entity: "agent", id: id!, column: "score", value: null, cause },
		];
		expect(applyEffects(world, effects, timeAt(1)).rejected).toEqual([]);
		expect(world.row("agent", id!)?.label).toBe("none");
		expect(world.row("agent", id!)?.score).toBe(0);
	});

	test("strlist values are copied and frozen", () => {
		const world = setup();
		const tags = ["a"];
		const [id] = world.create("agent", [{ tags }], rngFromSeed(6, []));
		tags.push("b");
		const stored = world
			.column<readonly string[]>("agent", "tags")
			.get(id as EntityId) as Scalar;
		expect(stored).toEqual(["a"]);
		expect(Object.isFrozen(stored)).toBe(true);
	});
});
