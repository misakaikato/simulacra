// Statistics for the audit: pure, dependency-free implementations of the tests the report
// needs (Mann-Whitney U with an exact small-sample tail, Holm, Cohen d, a seeded bootstrap, TVD,
// W1, Cliff's delta) plus the evidence grade. Every sample is filtered to finite values first.
// 审计用的统计：报告所需检验的纯函数、无依赖实现（含小样本精确尾部的 Mann-Whitney U、Holm、
// Cohen d、带种子的 bootstrap、TVD、W1、Cliff delta）以及证据等级。所有样本先滤掉非有限值。

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
// 并列取平均秩；tieCorrection 是各并列组 t^3 - t 之和

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
// 标准正态 CDF，用 Marsaglia（2004）级数，|x| <= 8 时绝对误差约 1e-15

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
// 无并列时样本量 m、n 的 U 精确分布，按上式逐列递推；结果是长度 m*n+1 的概率质量函数

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

// Two-sided p: exact enumeration when the smaller sample has fewer than 8 values and no ties
// (the recursion assumes distinct ranks), otherwise the normal approximation with tie
// correction and a 0.5 continuity correction; z <= 0 saturates at p = 1.
// 双侧 p 值：较小样本少于 8 个且无并列时精确枚举（递推假设秩互不相同），
// 否则用带并列修正与 0.5 连续性校正的正态近似；z <= 0 时 p 饱和为 1。
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
// Cohen d 用合并（n - 1）标准差；无离散时给 0 或带符号的无穷大（JSON 落 null，HTML 显示 inf）

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
// 均值差的百分位 bootstrap，随机性完全由传入的 rng 驱动，同一计划哈希下结果确定

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
// Holm 逐步下降校正；非有限 p 值按 1 计。running 取最大值保证单调：原始 p 更大的假设
// 永远不会拿到更小的校正值

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
// 分布距离

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

// SimBench-style score 100 * (1 - TVD(p, q) / TVD(p, uniform)): 100 is a perfect match and 0
// means no closer to the target than the uniform distribution, whatever the bin count.
// SimBench 式得分 100 * (1 - TVD(p, q) / TVD(p, uniform))：100 为完全吻合，
// 0 表示不比均匀分布更接近目标，与箱数无关。
export const simbenchScore = (p: readonly number[], q: readonly number[]): number => {
	const distance = tvd(p, q);
	const denominator = tvdToUniform(p);
	if (denominator === 0) return distance === 0 ? 100 : 0;
	return 100 * (1 - distance / denominator);
};

// W1 as the integral of |F_a - F_b| between consecutive breakpoints of the merged samples
// W1 取合并样本相邻断点之间 |F_a - F_b| 的积分，即经验 CDF 之差的面积

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

// Cliff's delta = P(x > y) - P(x < y) over all pairs, counted with binary searches on the sorted
// second sample so the cost is O((m + n) log n) rather than O(m n); ties count for neither side.
// Cliff delta = 全部配对上的 P(x > y) - P(x < y)，在排好序的第二样本上二分计数，
// 代价为 O((m + n) log n) 而非 O(m n)；并列两边都不计。
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
// 方向与证据等级

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

// Grades follow 4.4 step 7: weak below 10 replications, with any single-level axis or with no
// axes at all (appendix E); strong needs 30 replications, 3 levels per axis, 2 models and, for
// policy claims, axes at the micro, meso and macro levels.
// 等级按 4.4 第 7 步：复制数不足 10、任一轴只有一个取值或根本没有轴（附录 E）为 weak；
// strong 需要 30 次复制、每轴 3 个取值、2 个模型，policy 类主张还要求轴覆盖 micro/meso/macro。
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
