import { describe, expect, test } from "bun:test";
import { isUlid, makeRunId, newEntityId, newEventId, ulid } from "../../src/core/ids";
import { rngFromSeed } from "../../src/core/rng";

describe("ulid", () => {
	test("is 26 Crockford base32 characters", () => {
		const id = ulid(rngFromSeed(1, []));
		expect(id).toHaveLength(26);
		expect(isUlid(id)).toBe(true);
		expect(isUlid("not-a-ulid")).toBe(false);
	});

	test("is strictly increasing for successive calls on one rng", () => {
		const rng = rngFromSeed(1, [2, 3]);
		const ids = Array.from({ length: 2000 }, () => ulid(rng));
		for (let i = 1; i < ids.length; i += 1) {
			expect(ids[i]! > ids[i - 1]!).toBe(true);
		}
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("is reproducible from the same seed and path", () => {
		const a = rngFromSeed(1, [2, 3]);
		const b = rngFromSeed(1, [2, 3]);
		const idsA = Array.from({ length: 50 }, () => ulid(a));
		const idsB = Array.from({ length: 50 }, () => ulid(b));
		expect(idsA).toEqual(idsB);
	});

	test("differs across forks", () => {
		const root = rngFromSeed(1, []);
		const x = ulid(root.fork(1));
		const y = ulid(root.fork(2));
		expect(x).not.toBe(y);
	});

	test("without an rng it still yields valid, increasing ids", () => {
		const ids = Array.from({ length: 200 }, () => ulid());
		expect(ids.every(isUlid)).toBe(true);
		for (let i = 1; i < ids.length; i += 1) {
			expect(ids[i]! > ids[i - 1]!).toBe(true);
		}
	});
});

describe("branded ids", () => {
	test("entity and event ids come from the rng; run ids join scenario and replication", () => {
		const rng = rngFromSeed(4, []);
		const e = newEntityId(rng);
		const v = newEventId(rng);
		expect(isUlid(e)).toBe(true);
		expect(isUlid(v)).toBe(true);
		expect(e).not.toBe(v);
		expect(String(makeRunId("echo", 3))).toBe("echo:3");
	});
});
