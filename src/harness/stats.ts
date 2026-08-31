import type { Rng } from "../core/protocols";
import type { AuditPlan, AuditReport, Outcome } from "../core/types";

export type EvidenceGrade = AuditReport["evidenceGrade"];

export const finiteOnly = (xs: readonly number[]): readonly number[] =>
	xs.filter((x) => Number.isFinite(x));

export const sum = (xs: readonly number[]): number => xs.reduce((acc, x) => acc + x, 0);

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);

export const variance = (xs: readonly number[]): number => {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return sum(xs.map((x) => (x - m) * (x - m))) / (xs.length - 1);
};

export const standardDeviation = (xs: readonly number[]): number => Math.sqrt(variance(xs));

const ascending = (xs: readonly number[]): readonly number[] => [...xs].sort((a, b) => a - b);

// Ranks with ties averaged; tieCorrection is the sum of t^3 - t over tie groups

export interface RankInfo {
	readonly ranks: readonly number[];
	readonly tieCorrection: number;
}

export const rankWithTies = (values: readonly number[]): RankInfo => {
	const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
	const ranks = new Array<number>(values.length).fill(0);
	let tieCorrection = 0;
	let start = 0;
	while (start < order.length) {
		let end = start;
		while (end + 1 < order.length && order[end + 1]?.v === order[start]?.v) end += 1;
		const rank = (start + 1 + end + 1) / 2;
		for (let k = start; k <= end; k += 1) {
			const entry = order[k];
			if (entry !== undefined) ranks[entry.i] = rank;
		}
		const t = end - start + 1;
		if (t > 1) tieCorrection += t * t * t - t;
		start = end + 1;
	}
	return { ranks, tieCorrection };
};

// Standard normal CDF by Marsaglia's series (2004), absolute error about 1e-15 for |x| <= 8

const SQRT_2PI = Math.sqrt(2 * Math.PI);

export const normalCdf = (x: number): number => {
	if (Number.isNaN(x)) return Number.NaN;
	if (x <= -8) return 0;
	if (x >= 8) return 1;
	let total = x;
	let term = x;
	let i = 3;
	while (Math.abs(term) > 1e-17 * Math.abs(total)) {
		term *= (x * x) / i;
		total += term;
		i += 2;
	}
	return 0.5 + (total * Math.exp((-x * x) / 2)) / SQRT_2PI;
};

// Exact distribution of U for sample sizes m and n without ties:
// p(u; m, n) = m/(m+n) p(u-n; m-1, n) + n/(m+n) p(u; m, n-1)

export const exactMwuPmf = (m: number, n: number): Float64Array => {
	let previous: Float64Array[] = Array.from({ length: m + 1 }, () => Float64Array.of(1));
	for (let j = 1; j <= n; j += 1) {
		const current: Float64Array[] = [Float64Array.of(1)];
		for (let i = 1; i <= m; i += 1) {
			const smaller = current[i - 1];
			const fewer = previous[i];
			const pmf = new Float64Array(i * j + 1);
			for (let u = 0; u < pmf.length; u += 1) {
				const fromA = u - j >= 0 && smaller !== undefined ? (smaller[u - j] ?? 0) : 0;
				const fromB = fewer !== undefined ? (fewer[u] ?? 0) : 0;
				pmf[u] = (i / (i + j)) * fromA + (j / (i + j)) * fromB;
			}
			current.push(pmf);
		}
		previous = current;
	}
	return previous[m] ?? Float64Array.of(1);
};

export interface MwuResult {
	readonly u: number;
	readonly p: number;
}

export const EXACT_MWU_LIMIT = 8;

export const mannWhitneyU = (a: readonly number[], b: readonly number[]): MwuResult => {
	const x = finiteOnly(a);
	const y = finiteOnly(b);
	const m = x.length;
	const n = y.length;
	if (m === 0 || n === 0) return { u: 0, p: 1 };
	const { ranks, tieCorrection } = rankWithTies([...x, ...y]);
	const rankSumA = sum(ranks.slice(0, m));
	const uA = rankSumA - (m * (m + 1)) / 2;
	const uB = m * n - uA;
	const u = Math.min(uA, uB);
	if (Math.min(m, n) < EXACT_MWU_LIMIT && tieCorrection === 0) {
		const pmf = exactMwuPmf(Math.min(m, n), Math.max(m, n));
		let cdf = 0;
		for (let k = 0; k <= Math.round(u); k += 1) cdf += pmf[k] ?? 0;
		return { u, p: Math.min(1, 2 * cdf) };
	}
	const total = m + n;
	const sigma = Math.sqrt(((m * n) / 12) * (total + 1 - tieCorrection / (total * (total - 1))));
	if (sigma === 0) return { u, p: 1 };
	const z = (Math.abs(u - (m * n) / 2) - 0.5) / sigma;
	return { u, p: z <= 0 ? 1 : Math.min(1, 2 * normalCdf(-z)) };
};

// Cohen's d with the pooled (n - 1) standard deviation; zero spread gives 0 or a signed infinity

export const cohenD = (a: readonly number[], b: readonly number[]): number => {
	const x = finiteOnly(a);
	const y = finiteOnly(b);
	if (x.length === 0 || y.length === 0) return 0;
	const diff = mean(x) - mean(y);
	const dof = x.length + y.length - 2;
	const pooled =
		dof > 0
			? Math.sqrt(((x.length - 1) * variance(x) + (y.length - 1) * variance(y)) / dof)
			: 0;
	if (pooled === 0) return diff === 0 ? 0 : Math.sign(diff) * Number.POSITIVE_INFINITY;
	return diff / pooled;
};

// Percentile bootstrap of the mean difference, driven entirely by the given rng

export const bootstrapMeanDiffCI = (
	a: readonly number[],
	b: readonly number[],
	rng: Rng,
	iters = 2000,
	alpha = 0.05,
): readonly [number, number] => {
	const x = finiteOnly(a);
	const y = finiteOnly(b);
	if (x.length === 0 || y.length === 0 || iters < 1) return [0, 0];
	const diffs = new Float64Array(iters);
	for (let k = 0; k < iters; k += 1) {
		let sa = 0;
		for (let i = 0; i < x.length; i += 1) sa += x[rng.int(x.length)] ?? 0;
		let sb = 0;
		for (let i = 0; i < y.length; i += 1) sb += y[rng.int(y.length)] ?? 0;
		diffs[k] = sa / x.length - sb / y.length;
	}
	diffs.sort();
	const lo = diffs[Math.min(iters - 1, Math.floor((alpha / 2) * iters))] ?? 0;
	const hi = diffs[Math.max(0, Math.ceil((1 - alpha / 2) * iters) - 1)] ?? 0;
	return [lo, hi];
};

// Holm step-down adjustment; non-finite p-values count as 1

export const holm = (pValues: readonly number[]): readonly number[] => {
	const m = pValues.length;
	const clean = pValues.map((p) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1));
	const order = clean.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
	const adjusted = new Array<number>(m).fill(1);
	let running = 0;
	order.forEach(({ p, i }, rank) => {
		running = Math.max(running, Math.min(1, (m - rank) * p));
		adjusted[i] = running;
	});
	return adjusted;
};

// Distribution distances

const normalize = (p: readonly number[]): readonly number[] => {
	const total = sum(p);
	return total > 0 ? p.map((x) => x / total) : p;
};

export const tvd = (p: readonly number[], q: readonly number[]): number => {
	const np = normalize(p);
	const nq = normalize(q);
	const length = Math.max(np.length, nq.length);
	let total = 0;
	for (let i = 0; i < length; i += 1) total += Math.abs((np[i] ?? 0) - (nq[i] ?? 0));
	return total / 2;
};

export const uniform = (k: number): readonly number[] =>
	k <= 0 ? [] : new Array<number>(k).fill(1 / k);

export const tvdToUniform = (p: readonly number[]): number =>
	p.length === 0 ? 0 : tvd(p, uniform(p.length));

export const simbenchScore = (p: readonly number[], q: readonly number[]): number => {
	const distance = tvd(p, q);
	const denominator = tvdToUniform(p);
	if (denominator === 0) return distance === 0 ? 100 : 0;
	return 100 * (1 - distance / denominator);
};

// W1 as the integral of |F_a - F_b| between consecutive breakpoints of the merged samples

export const wasserstein1 = (a: readonly number[], b: readonly number[]): number => {
	const x = ascending(finiteOnly(a));
	const y = ascending(finiteOnly(b));
	if (x.length === 0 || y.length === 0) return 0;
	const points = ascending([...new Set([...x, ...y])]);
	let total = 0;
	let ia = 0;
	let ib = 0;
	for (let k = 0; k + 1 < points.length; k += 1) {
		const v = points[k] ?? 0;
		const next = points[k + 1] ?? v;
		while (ia < x.length && (x[ia] ?? Number.POSITIVE_INFINITY) <= v) ia += 1;
		while (ib < y.length && (y[ib] ?? Number.POSITIVE_INFINITY) <= v) ib += 1;
		total += Math.abs(ia / x.length - ib / y.length) * (next - v);
	}
	return total;
};

const lowerBound = (sorted: readonly number[], v: number): number => {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((sorted[mid] ?? Number.POSITIVE_INFINITY) < v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

const upperBound = (sorted: readonly number[], v: number): number => {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((sorted[mid] ?? Number.POSITIVE_INFINITY) <= v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

export const cliffDelta = (a: readonly number[], b: readonly number[]): number => {
	const x = finiteOnly(a);
	const y = ascending(finiteOnly(b));
	if (x.length === 0 || y.length === 0) return 0;
	let greater = 0;
	let less = 0;
	for (const v of x) {
		greater += lowerBound(y, v);
		less += y.length - upperBound(y, v);
	}
	return (greater - less) / (x.length * y.length);
};

// Direction and evidence

export const directionFlip = (
	meanBase: number,
	meanCond: number,
	direction: Outcome["direction"],
): boolean => {
	switch (direction) {
		case "increase":
			return meanCond < meanBase;
		case "decrease":
			return meanCond > meanBase;
		case "any":
			return false;
	}
};

const AXIS_LEVELS = ["micro", "meso", "macro"] as const;

export const evidenceGrade = (
	plan: Pick<AuditPlan, "replications" | "axes" | "models" | "claimType">,
): EvidenceGrade => {
	const levels = plan.axes.map((axis) => axis.levels.length);
	if (plan.axes.length === 0 || plan.replications < 10 || levels.some((l) => l < 2))
		return "weak";
	const coversAllLevels = AXIS_LEVELS.every((level) =>
		plan.axes.some((axis) => axis.level === level),
	);
	const strong =
		plan.replications >= 30 &&
		levels.every((l) => l >= 3) &&
		plan.models.length >= 2 &&
		(plan.claimType !== "policy" || coversAllLevels);
	return strong ? "strong" : "moderate";
};
