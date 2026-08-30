import { describe, expect, test } from "bun:test";
import { toEntityId, toEventId } from "../../src/core/ids";
import { applyEffects } from "../../src/core/resolver";
import { rngFromSeed } from "../../src/core/rng";
import { timeAt } from "../../src/core/time";
import type { ColumnDecl, Effect, EntityId, MergeRule, Scalar } from "../../src/core/types";
import { createWorld } from "../../src/core/world";

const cause = toEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

const column = (name: string, dtype: ColumnDecl["dtype"], merge: MergeRule): ColumnDecl => ({
	entity: "agent",
	name,
	dtype,
	default: dtype === "str" ? "" : dtype === "strlist" ? [] : dtype === "bool" ? false : 0,
	owner: "kernel",
	merge,
});

const setup = () => {
	const world = createWorld();
	for (const d of [
		column("last", "f64", "last"),
		column("sum", "f64", "sum"),
		column("max", "i32", "max"),
		column("text", "str", "append"),
		column("list", "strlist", "append"),
		column("flag", "bool", "sum"),
	]) {
		const r = world.declare(d);
		if (!r.ok) throw new Error(r.error.message);
	}
	const [id] = world.create("agent", [{}], rngFromSeed(1, []));
	return { world, id: id as EntityId };
};

const set = (id: EntityId, col: string, value: Scalar): Effect => ({
	op: "set",
	entity: "agent",
	id,
	column: col,
	value,
	cause,
});

describe("applyEffects merge rules within one tick", () => {
	test("last keeps the later write", () => {
		const { world, id } = setup();
		applyEffects(world, [set(id, "last", 1), set(id, "last", 2)], timeAt(1));
		expect(world.row("agent", id)?.last).toBe(2);
	});

	test("sum adds writes", () => {
		const { world, id } = setup();
		applyEffects(world, [set(id, "sum", 1.5), set(id, "sum", 2)], timeAt(1));
		expect(world.row("agent", id)?.sum).toBe(3.5);
	});

	test("max keeps the larger write", () => {
		const { world, id } = setup();
		applyEffects(world, [set(id, "max", 7), set(id, "max", 3)], timeAt(1));
		expect(world.row("agent", id)?.max).toBe(7);
	});

	test("append concatenates strings and lists", () => {
		const { world, id } = setup();
		applyEffects(
			world,
			[
				set(id, "text", "a"),
				set(id, "text", "b"),
				set(id, "list", ["x"]),
				set(id, "list", ["y"]),
			],
			timeAt(1),
		);
		expect(world.row("agent", id)?.text).toBe("ab");
		expect(world.row("agent", id)?.list).toEqual(["x", "y"]);
	});

	test("merging spans separate applyEffects calls in the same tick but not across ticks", () => {
		const { world, id } = setup();
		applyEffects(world, [set(id, "sum", 1)], timeAt(1));
		applyEffects(world, [set(id, "sum", 2)], timeAt(1, 1, 5));
		expect(world.row("agent", id)?.sum).toBe(3);
		applyEffects(world, [set(id, "sum", 10)], timeAt(2));
		expect(world.row("agent", id)?.sum).toBe(10);
	});

	test("bool sum behaves as logical or", () => {
		const { world, id } = setup();
		applyEffects(world, [set(id, "flag", false), set(id, "flag", true)], timeAt(1));
		expect(world.row("agent", id)?.flag).toBe(true);
	});
});

describe("applyEffects operations", () => {
	test("inc accumulates regardless of merge and append extends strings and lists", () => {
		const { world, id } = setup();
		const report = applyEffects(
			world,
			[
				{ op: "inc", entity: "agent", id, column: "last", value: 2, cause },
				{ op: "inc", entity: "agent", id, column: "last", value: 3, cause },
				{ op: "append", entity: "agent", id, column: "text", value: "hi", cause },
				{ op: "append", entity: "agent", id, column: "list", value: "one", cause },
				{ op: "append", entity: "agent", id, column: "list", value: "two", cause },
			],
			timeAt(1),
		);
		expect(report).toEqual({ applied: 5, rejected: [] });
		expect(world.row("agent", id)).toMatchObject({ last: 5, text: "hi", list: ["one", "two"] });
	});

	test("create inserts a row with a caller-provided id and setColumn writes in bulk", () => {
		const { world, id } = setup();
		const newId = toEntityId("01ARZ3NDEKTSV4RRFFQ69G5FB0");
		const report = applyEffects(
			world,
			[
				{ op: "create", entity: "agent", id: newId, row: { last: 9, text: "n" }, cause },
				{
					op: "setColumn",
					entity: "agent",
					column: "max",
					ids: [id, newId],
					values: [4, 6],
					cause,
				},
				{ op: "envSet", key: "round", value: 1, cause },
			],
			timeAt(1),
		);
		expect(report).toEqual({ applied: 3, rejected: [] });
		expect(world.ids("agent")).toEqual([id, newId]);
		expect(world.row("agent", newId)).toMatchObject({ last: 9, text: "n", max: 6 });
		expect(world.row("agent", id)?.max).toBe(4);
		expect(world.env("round")).toBe(1);
	});
});

describe("applyEffects rejections never throw", () => {
	test("each invalid effect is reported with a reason and valid ones still apply", () => {
		const { world, id } = setup();
		const ghost = toEntityId("01ARZ3NDEKTSV4RRFFQ69G5FB1");
		const effects: Effect[] = [
			{ op: "set", entity: "post", id, column: "last", value: 1, cause },
			{ op: "set", entity: "agent", id: ghost, column: "last", value: 1, cause },
			{ op: "set", entity: "agent", id, column: "nope", value: 1, cause },
			{ op: "set", entity: "agent", id, column: "last", value: "str", cause },
			{ op: "set", entity: "agent", id, column: "max", value: 1.5, cause },
			{ op: "inc", entity: "agent", id, column: "text", value: 1, cause },
			{ op: "append", entity: "agent", id, column: "last", value: "x", cause },
			{ op: "create", entity: "agent", id, row: {}, cause },
			{ op: "create", entity: "agent", id: ghost, row: { nope: 1 }, cause },
			{ op: "create", entity: "post", id: ghost, row: {}, cause },
			{ op: "delete", entity: "agent", id: ghost, cause },
			{ op: "setColumn", entity: "agent", column: "last", ids: [id], values: [1, 2], cause },
			{
				op: "setColumn",
				entity: "agent",
				column: "last",
				ids: [id, ghost],
				values: [1, 2],
				cause,
			},
			{ op: "set", entity: "agent", id, column: "last", value: 42, cause },
		];
		const report = applyEffects(world, effects, timeAt(3));
		expect(report.applied).toBe(1);
		expect(report.rejected).toHaveLength(13);
		expect(report.rejected.map((r) => r.reason)).toEqual([
			"unknown entity 'post'",
			`unknown id ${ghost} in 'agent'`,
			"undeclared column agent.nope",
			"agent.last: expected f64, got string",
			"agent.max: expected i32, got 1.5",
			"inc on agent.text: dtype str is not numeric",
			"append on agent.last: dtype f64 is not str or strlist",
			`entity 'agent' already has id ${id}`,
			"undeclared column agent.nope",
			"unknown entity 'post'",
			`unknown id ${ghost} in 'agent'`,
			"setColumn agent.last: 1 ids but 2 values",
			`unknown id ${ghost} in 'agent'`,
		]);
		expect(world.row("agent", id)?.last).toBe(42);
		expect(world.count("agent")).toBe(1);
	});

	test("a partially invalid setColumn applies nothing", () => {
		const { world, id } = setup();
		const ghost = toEntityId("01ARZ3NDEKTSV4RRFFQ69G5FB1");
		applyEffects(
			world,
			[
				{
					op: "setColumn",
					entity: "agent",
					column: "last",
					ids: [id, ghost],
					values: [5, 6],
					cause,
				},
			],
			timeAt(1),
		);
		expect(world.row("agent", id)?.last).toBe(0);
	});
});
