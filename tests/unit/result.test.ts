import { describe, expect, test } from "bun:test";
import {
	andThen,
	collect,
	err,
	isErr,
	isOk,
	map,
	mapErr,
	ok,
	partition,
	unwrapOr,
} from "../../src/core/result";
import type { Result } from "../../src/core/types";

describe("Result", () => {
	test("ok and err construct discriminated values", () => {
		expect(ok(1)).toEqual({ ok: true, value: 1 });
		expect(err("bad")).toEqual({ ok: false, error: "bad" });
		expect(isOk(ok(1))).toBe(true);
		expect(isErr(err("x"))).toBe(true);
	});

	test("map and mapErr touch only their side", () => {
		const good: Result<number, string> = ok(2);
		const bad: Result<number, string> = err("e");
		expect(map(good, (v) => v * 2)).toEqual(ok(4));
		expect(map(bad, (v) => v * 2)).toEqual(bad);
		expect(mapErr(good, (e) => e.toUpperCase())).toEqual(good);
		expect(mapErr(bad, (e) => e.toUpperCase())).toEqual(err("E"));
	});

	test("andThen chains and short-circuits", () => {
		const parse = (s: string): Result<number, string> =>
			Number.isNaN(Number(s)) ? err(`nan:${s}`) : ok(Number(s));
		expect(andThen(ok("3"), parse)).toEqual(ok(3));
		expect(andThen(ok("x"), parse)).toEqual(err("nan:x"));
		expect(andThen(err("first"), parse)).toEqual(err("first"));
	});

	test("unwrapOr returns the value or the fallback", () => {
		expect(unwrapOr(ok(5), 0)).toBe(5);
		expect(unwrapOr(err("e"), 0)).toBe(0);
	});

	test("collect succeeds only when every result succeeds and returns the first error", () => {
		expect(collect([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
		expect(collect([ok(1), err("a"), err("b")])).toEqual(err("a"));
		expect(collect([])).toEqual(ok([]));
	});

	test("partition splits values and errors preserving order", () => {
		expect(partition([ok(1), err("a"), ok(2), err("b")])).toEqual({
			values: [1, 2],
			errors: ["a", "b"],
		});
	});
});
