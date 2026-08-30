import { describe, expect, test } from "bun:test";
import { rngFromSeed, xoshiro128StarStar } from "../../src/core/rng";

describe("xoshiro128**", () => {
	test("matches the reference output sequence for state [1, 2, 3, 4]", () => {
		const state = new Uint32Array([1, 2, 3, 4]);
		const out = Array.from({ length: 10 }, () => xoshiro128StarStar(state));
		expect(out).toEqual([
			11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597,
			4258142804,
		]);
	});
});

describe("rngFromSeed", () => {
	test("rngFromSeed(1, [2, 3]) produces the fixed vector", () => {
		const rng = rngFromSeed(1, [2, 3]);
		const out = Array.from({ length: 5 }, () => rng.next());
		expect(out).toEqual([
			0.6274799921084195, 0.9384850636124611, 0.5561213819310069, 0.6933289307635278,
			0.7816363538149744,
		]);
	});

	test("same seed and path give the same stream; different path differs", () => {
		const a = rngFromSeed(42, [1, 2]);
		const b = rngFromSeed(42, [1, 2]);
		const c = rngFromSeed(42, [1, 3]);
		const d = rngFromSeed(43, [1, 2]);
		const take = (r: { next(): number }) => Array.from({ length: 8 }, () => r.next());
		const sa = take(a);
		expect(take(b)).toEqual(sa);
		expect(take(c)).not.toEqual(sa);
		expect(take(d)).not.toEqual(sa);
	});

	test("fork appends the key to the path and equals rngFromSeed with that path", () => {
		const root = rngFromSeed(7, [0]);
		const forked = root.fork(5);
		expect(forked.path).toEqual([0, 5]);
		const direct = rngFromSeed(7, [0, 5]);
		expect(forked.next()).toBe(direct.next());
		expect(root.path).toEqual([0]);
	});

	test("next is in [0, 1) and int(n) is in [0, n)", () => {
		const rng = rngFromSeed(3, []);
		for (let i = 0; i < 10000; i += 1) {
			const x = rng.next();
			expect(x >= 0 && x < 1).toBe(true);
			const k = rng.int(7);
			expect(Number.isInteger(k) && k >= 0 && k < 7).toBe(true);
		}
		expect(rng.int(0)).toBe(0);
		expect(rng.int(1)).toBe(0);
	});

	test("bernoulli respects p at the extremes and is roughly calibrated", () => {
		const rng = rngFromSeed(11, []);
		expect(rng.bernoulli(0)).toBe(false);
		expect(rng.bernoulli(1)).toBe(true);
		let hits = 0;
		for (let i = 0; i < 20000; i += 1) if (rng.bernoulli(0.3)) hits += 1;
		expect(Math.abs(hits / 20000 - 0.3)).toBeLessThan(0.02);
	});

	test("shuffle is a permutation and does not mutate the input", () => {
		const rng = rngFromSeed(5, []);
		const xs = [1, 2, 3, 4, 5, 6, 7, 8];
		const ys = rng.shuffle(xs);
		expect(xs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect([...ys].sort((a, b) => a - b)).toEqual(xs);
	});

	test("pick selects an element and throws on an empty array", () => {
		const rng = rngFromSeed(5, []);
		expect(["a", "b", "c"]).toContain(rng.pick(["a", "b", "c"]));
		expect(() => rng.pick([])).toThrow(RangeError);
	});

	test("normal has approximately the requested mean and standard deviation", () => {
		const rng = rngFromSeed(9, []);
		const n = 50000;
		let sum = 0;
		let sq = 0;
		for (let i = 0; i < n; i += 1) {
			const x = rng.normal(2, 3);
			sum += x;
			sq += x * x;
		}
		const mean = sum / n;
		const variance = sq / n - mean * mean;
		expect(Math.abs(mean - 2)).toBeLessThan(0.05);
		expect(Math.abs(Math.sqrt(variance) - 3)).toBeLessThan(0.05);
	});
});
