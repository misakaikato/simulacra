import { describe, expect, test } from "bun:test";
import { rngFromSeed } from "../../src/core/rng";
import type { AuditPlan, PerturbationAxis } from "../../src/core/types";
import {
	bootstrapMeanDiffCI,
	cliffDelta,
	cohenD,
	directionFlip,
	evidenceGrade,
	exactMwuPmf,
	holm,
	mannWhitneyU,
	normalCdf,
	rankWithTies,
	simbenchScore,
	tvd,
	tvdToUniform,
	wasserstein1,
} from "../../src/harness/stats";

const EPS = 1e-9;
const close = (actual: number, expected: number) =>
	expect(Math.abs(actual - expected)).toBeLessThan(EPS);

// Brute-force two-sided exact p for untied samples: enumerate every split of the pooled ranks;
// min(U_a, U_b) <= u already covers both tails, so its share is the two-sided p
const bruteForceMwu = (a: readonly number[], b: readonly number[]): { u: number; p: number } => {
	const pooled = [...a, ...b].sort((x, y) => x - y);
	const m = a.length;
	const countU = (sample: readonly number[], other: readonly number[]) =>
		sample.reduce((acc, x) => acc + other.filter((y) => x > y).length, 0);
	const observed = Math.min(countU(a, b), countU(b, a));
	let atMost = 0;
	let total = 0;
	const choose = (start: number, picked: number[]): void => {
		if (picked.length === m) {
			const rest = pooled.filter((_, i) => !picked.includes(i));
			const chosen = picked.map((i) => pooled[i] ?? 0);
			total += 1;
			if (Math.min(countU(chosen, rest), countU(rest, chosen)) <= observed) atMost += 1;
			return;
		}
		for (let i = start; i < pooled.length; i += 1) choose(i + 1, [...picked, i]);
	};
	choose(0, []);
	return { u: observed, p: atMost / total };
};

describe("ranks and the normal CDF", () => {
	test("averages tied ranks and sums t^3 - t", () => {
		const r = rankWithTies([1, 2, 2, 3, 2, 3, 3, 4]);
		expect(r.ranks).toEqual([1, 3, 3, 6, 3, 6, 6, 8]);
		expect(r.tieCorrection).toBe(24 + 24);
		expect(rankWithTies([]).ranks).toEqual([]);
	});

	test("matches tabulated values of the standard normal CDF (CPython math.erfc)", () => {
		close(normalCdf(0), 0.5);
		close(normalCdf(1), 0.8413447460685429);
		close(normalCdf(1.96), 0.9750021048517795);
		close(normalCdf(-2.5), 0.0062096653257761375);
		close(normalCdf(3.742), 0.999908719242324);
		expect(normalCdf(9)).toBe(1);
		expect(normalCdf(-9)).toBe(0);
		expect(Number.isNaN(normalCdf(Number.NaN))).toBe(true);
	});
});

describe("mannWhitneyU", () => {
	test("exact enumeration for small untied samples (hand-counted)", () => {
		// a below b entirely: U = 0, one arrangement of C(6,3) = 20, two-sided p = 2/20
		const separated = mannWhitneyU([1, 2, 3], [4, 5, 6]);
		expect(separated.u).toBe(0);
		close(separated.p, 0.1);
		// interleaved: U = 3; P(U <= 3) = (1+1+2+3)/20 = 0.35, two-sided p = 0.7
		const interleaved = mannWhitneyU([1, 3, 5], [2, 4, 6]);
		expect(interleaved.u).toBe(3);
		close(interleaved.p, 0.7);
		// unequal sizes: C(7,2) = 21 arrangements, U = 0 is one of them, p = 2/21
		close(mannWhitneyU([1, 2], [3, 4, 5, 6, 7]).p, 2 / 21);
		expect(mannWhitneyU([1, 2], [3, 4, 5, 6, 7]).u).toBe(0);
		expect(mannWhitneyU([3, 4, 5, 6, 7], [1, 2]).u).toBe(0);
	});

	test("exact pmf sums to one and agrees with brute-force enumeration", () => {
		const pmf = exactMwuPmf(4, 5);
		close(
			pmf.reduce((acc, p) => acc + p, 0),
			1,
		);
		expect(pmf).toHaveLength(21);
		const a = [0.3, 1.7, 2.2, 5.1];
		const b = [0.9, 1.1, 2.8, 3.3, 4.4];
		const expected = bruteForceMwu(a, b);
		const actual = mannWhitneyU(a, b);
		expect(actual.u).toBe(expected.u);
		close(actual.p, expected.p);
	});

	test("normal approximation with continuity correction once min(n) >= 8 (math.erfc)", () => {
		// a = 1..10, b = 11..20: U = 0, sigma = sqrt(100 * 21 / 12), z = 49.5 / sigma
		const r = mannWhitneyU(
			[1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
			[11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
		);
		expect(r.u).toBe(0);
		close(r.p, 0.00018267179110955043);
	});

	test("ties force the tie-corrected normal approximation (math.erfc)", () => {
		// ranks 1,3,3,6 | 3,6,6,8: U = 3, sigma^2 = (16/12) (9 - 48/56)
		const small = mannWhitneyU([1, 2, 2, 3], [2, 3, 3, 4]);
		expect(small.u).toBe(3);
		close(small.p, 0.172033708921823);
		const larger = mannWhitneyU([1, 1, 2, 2, 3, 3, 4, 4, 5], [3, 3, 4, 4, 5, 5, 6, 6, 7]);
		expect(larger.u).toBe(13);
		close(larger.p, 0.015602443282568523);
	});

	test("degenerate inputs give p = 1 without throwing", () => {
		expect(mannWhitneyU([], [1, 2])).toEqual({ u: 0, p: 1 });
		expect(mannWhitneyU([2, 2, 2], [2, 2, 2])).toEqual({ u: 4.5, p: 1 });
		expect(mannWhitneyU([1, 2, 3], [1, 2, 3]).p).toBe(1);
		expect(mannWhitneyU([Number.NaN, 1], [2, Number.NaN]).p).toBe(1);
		expect(mannWhitneyU([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8]).p).toBe(1);
	});
});

describe("effect sizes", () => {
	test("cohenD uses the pooled n-1 standard deviation (hand-computed)", () => {
		// means 4 and 2, variances 4 and 1, pooled sd = sqrt(10/4)
		close(cohenD([2, 4, 6], [1, 2, 3]), 1.2649110640673518);
		close(cohenD([1, 2, 3], [2, 4, 6]), -1.2649110640673518);
		expect(cohenD([3, 3, 3], [3, 3, 3])).toBe(0);
		expect(cohenD([], [1])).toBe(0);
		expect(cohenD([1, 1], [2, 2])).toBe(Number.NEGATIVE_INFINITY);
		expect(cohenD([2, 2], [1, 1])).toBe(Number.POSITIVE_INFINITY);
		close(cohenD([2, 4, 6, Number.NaN], [1, 2, 3]), 1.2649110640673518);
	});

	test("cliffDelta counts dominance pairs (hand-counted)", () => {
		expect(cliffDelta([1, 2, 3], [4, 5, 6])).toBe(-1);
		expect(cliffDelta([4, 5, 6], [1, 2, 3])).toBe(1);
		close(cliffDelta([1, 3, 5], [2, 4, 6]), -1 / 3);
		close(cliffDelta([1, 2], [2, 3]), -3 / 4);
		expect(cliffDelta([2, 2], [2, 2])).toBe(0);
		expect(cliffDelta([], [1])).toBe(0);
	});
});

describe("bootstrapMeanDiffCI", () => {
	test("is deterministic in the rng and collapses on constant samples", () => {
		const a = [1, 2, 3, 4, 5, 6];
		const b = [4, 5, 6, 7, 8, 9];
		const first = bootstrapMeanDiffCI(a, b, rngFromSeed(3, [1]));
		const second = bootstrapMeanDiffCI(a, b, rngFromSeed(3, [1]));
		expect(first).toEqual(second);
		expect(first[0]).toBeLessThan(-3);
		expect(first[1]).toBeGreaterThan(-3);
		expect(first[1]).toBeLessThan(0);
		const other = bootstrapMeanDiffCI(a, b, rngFromSeed(3, [2]));
		expect(other).not.toEqual(first);
		expect(bootstrapMeanDiffCI([3, 3, 3], [3, 3, 3], rngFromSeed(1, []))).toEqual([0, 0]);
		expect(bootstrapMeanDiffCI([10, 10, 10, 10], [0, 0, 0, 0], rngFromSeed(1, []))).toEqual([
			10, 10,
		]);
		expect(bootstrapMeanDiffCI([], [1], rngFromSeed(1, []))).toEqual([0, 0]);
		const narrow = bootstrapMeanDiffCI(a, b, rngFromSeed(3, [1]), 500, 0.5);
		expect(narrow[1] - narrow[0]).toBeLessThan(first[1] - first[0]);
	});
});

describe("holm", () => {
	test("step-down adjustment (hand-computed on four p-values)", () => {
		// sorted 0.005, 0.01, 0.03, 0.04 -> 0.02, 0.03, 0.06, 0.06 in original order
		const adjusted = holm([0.01, 0.04, 0.03, 0.005]);
		expect(adjusted).toHaveLength(4);
		close(adjusted[0] ?? -1, 0.03);
		close(adjusted[1] ?? -1, 0.06);
		close(adjusted[2] ?? -1, 0.06);
		close(adjusted[3] ?? -1, 0.02);
		expect(holm([])).toEqual([]);
		expect(holm([0.5])).toEqual([0.5]);
		expect(holm([0.7, 0.8])).toEqual([1, 1]);
		expect(holm([Number.NaN, 0.01])).toEqual([1, 0.02]);
	});
});

describe("distribution distances", () => {
	test("tvd, tvdToUniform and the SimBench score (hand-computed)", () => {
		close(tvd([0.5, 0.5], [1, 0]), 0.5);
		close(tvd([0.2, 0.8], [0.4, 0.6]), 0.2);
		close(tvd([2, 8], [4, 6]), 0.2);
		close(tvd([0.5, 0.5], [0.5, 0.5]), 0);
		close(tvd([1], [0, 1]), 1);
		close(tvdToUniform([1, 0]), 0.5);
		close(tvdToUniform([0.2, 0.8]), 0.3);
		expect(tvdToUniform([])).toBe(0);
		close(simbenchScore([1, 0], [0.5, 0.5]), 0);
		close(simbenchScore([0.2, 0.8], [0.4, 0.6]), 33.33333333333333);
		expect(simbenchScore([0.5, 0.5], [0.5, 0.5])).toBe(100);
		expect(simbenchScore([0.5, 0.5], [1, 0])).toBe(0);
		close(simbenchScore([0.2, 0.8], [0.2, 0.8]), 100);
	});

	test("wasserstein1 integrates the CDF gap (hand-computed)", () => {
		close(wasserstein1([0, 1], [1, 2]), 1);
		close(wasserstein1([0, 0, 0, 0], [0, 0, 0, 4]), 1);
		close(wasserstein1([1, 2, 3], [4, 5, 6]), 3);
		close(wasserstein1([0, 1], [0.5, 1.5]), 0.5);
		expect(wasserstein1([2, 2], [2, 2])).toBe(0);
		expect(wasserstein1([], [1])).toBe(0);
		close(wasserstein1([1, 2, 3], [3, 2, 1]), 0);
	});
});

describe("direction and evidence grade", () => {
	test("directionFlip compares means against the expected direction", () => {
		expect(directionFlip(0.5, 0.4, "increase")).toBe(true);
		expect(directionFlip(0.5, 0.6, "increase")).toBe(false);
		expect(directionFlip(0.5, 0.6, "decrease")).toBe(true);
		expect(directionFlip(0.5, 0.5, "decrease")).toBe(false);
		expect(directionFlip(0.5, 0.1, "any")).toBe(false);
		expect(directionFlip(Number.NaN, 0.1, "increase")).toBe(false);
	});

	const axis = (level: PerturbationAxis["level"], n: number): PerturbationAxis => ({
		id: `${level}${n}`,
		level,
		kind: "design",
		dimension: "d",
		target: "population.n",
		levels: Array.from({ length: n }, (_, i) => i),
	});
	const plan = (
		overrides: Partial<Pick<AuditPlan, "replications" | "axes" | "models" | "claimType">>,
	) => ({
		replications: 30,
		axes: [axis("micro", 3), axis("meso", 3), axis("macro", 3)],
		models: ["a", "b"],
		claimType: "mechanism" as const,
		...overrides,
	});

	test("evidenceGrade follows the replication, level and model thresholds", () => {
		expect(evidenceGrade(plan({}))).toBe("strong");
		expect(evidenceGrade(plan({ replications: 5 }))).toBe("weak");
		expect(evidenceGrade(plan({ replications: 1 }))).toBe("weak");
		expect(evidenceGrade(plan({ axes: [] }))).toBe("weak");
		expect(evidenceGrade(plan({ axes: [axis("micro", 1), axis("meso", 3)] }))).toBe("weak");
		expect(evidenceGrade(plan({ replications: 10 }))).toBe("moderate");
		expect(evidenceGrade(plan({ models: [] }))).toBe("moderate");
		expect(evidenceGrade(plan({ axes: [axis("micro", 2), axis("meso", 3)] }))).toBe("moderate");
		expect(evidenceGrade(plan({ axes: [axis("micro", 3), axis("meso", 3)] }))).toBe("strong");
		expect(
			evidenceGrade(plan({ axes: [axis("micro", 3), axis("meso", 3)], claimType: "policy" })),
		).toBe("moderate");
		expect(evidenceGrade(plan({ claimType: "policy" }))).toBe("strong");
	});
});
