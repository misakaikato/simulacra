import { z } from "zod";
import { FAILURE_TYPES } from "../../core/failures";
import type { DecisionProvider, Rng } from "../../core/protocols";
import { err, ok } from "../../core/result";
import { keyFromLabel, rngFromSeed } from "../../core/rng";
import type {
	Cost,
	Decision,
	DecisionRequest,
	EntityId,
	JsonValue,
	ProviderFailure,
	Result,
	RoundContext,
} from "../../core/types";
import type { Logger } from "../../logging/logger";

export const APS_KIND = "aps";

export const ApsOptionsSchema = z.object({
	downstream: z.string().min(1),
	Nb: z.number().int().positive().default(5000),
	alphaB: z.number().positive().max(1).default(0.15),
	Mb: z.number().int().positive().default(10),
	lambda: z.number().min(0).max(1).default(0.6),
	eta: z.number().nonnegative().default(0.5),
	zeta: z.number().nonnegative().default(0.4),
	gamma: z.number().nonnegative().default(0.05),
	kappa: z.number().int().positive().default(5),
	tau: z.number().nonnegative().default(0.1),
	tailFraction: z.number().min(0).max(1).default(0.02),
	alphaMin: z.number().positive().max(1).default(0.01),
	auditMin: z.number().int().nonnegative().default(5),
	kmeansIterations: z.number().int().positive().default(20),
	kmeansBatch: z.number().int().positive().default(256),
});

export type ApsOptions = z.output<typeof ApsOptionsSchema>;

export interface ApsProviderOptions extends Omit<ApsOptions, "downstream"> {
	readonly name: string;
	readonly seed: number;
}

export interface ApsReport {
	readonly mismatchRate: number;
	readonly residualVar: number;
	readonly calls: number;
	readonly reportedDistribution: Readonly<Record<string, number>>;
}

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const DISTANCE_FLOOR = 1e-9;

const StateSchema = z.object({
	seedPath: z.array(z.number()),
	centroids: z.array(z.array(z.number())).nullable(),
	tail: z.array(z.string()),
	residual: z.array(z.number()),
	calls: z.number().int().nonnegative(),
	rounds: z.number().int().nonnegative(),
	report: z
		.object({
			mismatchRate: z.number(),
			residualVar: z.number(),
			reportedDistribution: z.record(z.string(), z.number()),
		})
		.nullable(),
});

// Numeric helpers

export const median = (xs: readonly number[]): number => {
	if (xs.length === 0) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] ?? 0)
		: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

export const euclidean = (a: readonly number[], b: readonly number[]): number => {
	let s = 0;
	for (let i = 0; i < a.length; i += 1) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		s += d * d;
	}
	return Math.sqrt(s);
};

// Tail score per point: L2 norm of the per-dimension robust z-score (median / MAD).
export const tailScores = (points: readonly (readonly number[])[]): readonly number[] => {
	const first = points[0];
	if (first === undefined) return [];
	const dims = first.length;
	const medians: number[] = [];
	const mads: number[] = [];
	for (let j = 0; j < dims; j += 1) {
		const column = points.map((p) => p[j] ?? 0);
		const m = median(column);
		const mad = median(column.map((v) => Math.abs(v - m)));
		medians.push(m);
		mads.push(mad > 0 ? mad : 1);
	}
	return points.map((p) => {
		let s = 0;
		for (let j = 0; j < dims; j += 1) {
			const z = ((p[j] ?? 0) - (medians[j] ?? 0)) / (mads[j] ?? 1);
			s += z * z;
		}
		return Math.sqrt(s);
	});
};

export const nearestIndex = (
	point: readonly number[],
	centroids: readonly (readonly number[])[],
): number => {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	centroids.forEach((c, i) => {
		const d = euclidean(point, c);
		if (d < bestDistance) {
			bestDistance = d;
			best = i;
		}
	});
	return best;
};

export const miniBatchKMeans = (
	points: readonly (readonly number[])[],
	k: number,
	rng: Rng,
	iterations: number,
	batchSize: number,
): readonly (readonly number[])[] => {
	if (points.length === 0 || k <= 0) return [];
	const clusters = Math.min(k, points.length);
	const order = rng.shuffle(points.map((_, i) => i));
	const centroids = order.slice(0, clusters).map((i) => [...(points[i] ?? [])]);
	const counts = new Array<number>(clusters).fill(0);
	const size = Math.min(batchSize, points.length);
	for (let it = 0; it < iterations; it += 1) {
		const batch = Array.from({ length: size }, () => points[rng.int(points.length)] ?? []);
		const assigned = batch.map((p) => nearestIndex(p, centroids));
		batch.forEach((p, b) => {
			const c = assigned[b] ?? 0;
			counts[c] = (counts[c] ?? 0) + 1;
			const rate = 1 / (counts[c] ?? 1);
			const centroid = centroids[c];
			if (centroid === undefined) return;
			for (let j = 0; j < centroid.length; j += 1)
				centroid[j] = (centroid[j] ?? 0) + rate * ((p[j] ?? 0) - (centroid[j] ?? 0));
		});
	}
	return centroids;
};

// Largest-remainder apportionment of `total` over `weights`, each share capped by `caps`.
export const apportion = (
	total: number,
	weights: readonly number[],
	caps: readonly number[],
	minimum: number,
): readonly number[] => {
	const n = weights.length;
	const out = new Array<number>(n).fill(0);
	if (n === 0 || total <= 0) return out;
	const capOf = (i: number): number => caps[i] ?? 0;
	const at = (i: number): number => out[i] ?? 0;
	const weightSum = weights.reduce((a, w, i) => a + (capOf(i) > 0 ? w : 0), 0);
	if (weightSum <= 0) return out;
	const exact = weights.map((w, i) => (capOf(i) > 0 ? (total * w) / weightSum : 0));
	exact.forEach((x, i) => {
		out[i] = Math.min(Math.floor(x), capOf(i));
	});
	let remaining = total - out.reduce((a, b) => a + b, 0);
	const byFraction = exact
		.map((x, i) => ({ i, frac: x - Math.floor(x) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (const { i } of byFraction) {
		if (remaining <= 0) break;
		if (at(i) >= capOf(i)) continue;
		out[i] = at(i) + 1;
		remaining -= 1;
	}
	// Every layer that can take a share gets at least `minimum`, taken from the largest shares.
	for (let i = 0; i < n; i += 1) {
		let need = Math.min(minimum, capOf(i)) - at(i);
		while (need > 0) {
			let donor = -1;
			for (let j = 0; j < n; j += 1)
				if (j !== i && at(j) > minimum && (donor === -1 || at(j) > at(donor))) donor = j;
			if (donor === -1) break;
			out[donor] = at(donor) - 1;
			out[i] = at(i) + 1;
			need -= 1;
		}
	}
	return out;
};

export const projectToSimplex = (
	values: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> => {
	const keys = Object.keys(values).sort();
	const v = keys.map((k) => values[k] ?? 0);
	if (v.length === 0) return {};
	const sorted = [...v].sort((a, b) => b - a);
	let cumulative = 0;
	let rho = 0;
	let theta = 0;
	for (let j = 0; j < sorted.length; j += 1) {
		cumulative += sorted[j] ?? 0;
		const t = (cumulative - 1) / (j + 1);
		if ((sorted[j] ?? 0) - t > 0) {
			rho = j + 1;
			theta = t;
		}
	}
	if (rho === 0) theta = (cumulative - 1) / sorted.length;
	const out: Record<string, number> = {};
	keys.forEach((k, i) => {
		out[k] = Math.max((v[i] ?? 0) - theta, 0);
	});
	return out;
};

interface Support {
	readonly features: readonly number[];
	readonly decision: Decision;
}

const argmaxAction = (h: Readonly<Record<string, number>>): string | undefined => {
	let best: string | undefined;
	let bestValue = Number.NEGATIVE_INFINITY;
	for (const action of Object.keys(h).sort()) {
		const p = h[action] ?? 0;
		if (p > bestValue) {
			bestValue = p;
			best = action;
		}
	}
	return best;
};

// Inverse-distance weighted soft label from the kappa nearest queried prototypes.
export const interpolate = (
	features: readonly number[],
	support: readonly Support[],
	kappa: number,
): { readonly soft: Readonly<Record<string, number>>; readonly nearest: Support } | undefined => {
	if (support.length === 0) return undefined;
	const ranked = support
		.map((s, i) => ({ s, i, d: euclidean(features, s.features) }))
		.sort((a, b) => a.d - b.d || a.i - b.i)
		.slice(0, kappa);
	const soft: Record<string, number> = {};
	let total = 0;
	for (const { s, d } of ranked) {
		const w = 1 / (d + DISTANCE_FLOOR);
		soft[s.decision.action] = (soft[s.decision.action] ?? 0) + w;
		total += w;
	}
	for (const k of Object.keys(soft)) soft[k] = (soft[k] ?? 0) / total;
	const nearest = ranked[0]?.s;
	return nearest === undefined ? undefined : { soft, nearest };
};

class ApsDecisionProvider implements DecisionProvider {
	readonly name: string;
	private readonly options: ApsProviderOptions;
	private readonly downstream: DecisionProvider;
	private readonly logger: Logger;
	private seedPath: readonly number[] = [];
	private centroids: readonly (readonly number[])[] | undefined;
	private tail = new Set<EntityId>();
	private residual: number[] = [];
	private calls = 0;
	private rounds = 0;
	private lastReport: Omit<ApsReport, "calls"> = {
		mismatchRate: 0,
		residualVar: 0,
		reportedDistribution: {},
	};

	constructor(options: ApsProviderOptions, downstream: DecisionProvider, logger: Logger) {
		this.name = options.name;
		this.options = options;
		this.downstream = downstream;
		this.logger = logger.child({ component: `provider:${options.name}` });
	}

	async decide(
		requests: readonly DecisionRequest[],
		ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]> {
		const results: (Result<Decision, ProviderFailure> | undefined)[] = requests.map(
			() => undefined,
		);
		const valid: number[] = [];
		const dims = requests.find((r) => r.features !== undefined)?.features?.length;
		requests.forEach((req, i) => {
			if (req.features === undefined || req.features.length !== dims)
				results[i] = err({
					agentId: req.agentId,
					reason:
						req.features === undefined
							? "request carries no features"
							: `feature width ${req.features.length} differs from ${String(dims)}`,
					retryable: false,
					excType: FAILURE_TYPES.noFeatures,
				});
			else valid.push(i);
		});
		if (valid.length > 0) await this.route(requests, valid, results, ctx);
		return requests.map(
			(req, i) =>
				results[i] ?? err({ agentId: req.agentId, reason: "not routed", retryable: false }),
		);
	}

	audit(): Readonly<Record<string, number>> {
		const out: Record<string, number> = {
			mismatchRate: this.lastReport.mismatchRate,
			residualVar: this.lastReport.residualVar,
			calls: this.calls,
			layers: this.centroids?.length ?? 0,
		};
		for (const [action, p] of Object.entries(this.lastReport.reportedDistribution))
			out[`reportedDistribution.${action}`] = p;
		return out;
	}

	report(): ApsReport {
		return { ...this.lastReport, calls: this.calls };
	}

	reset(seedPath: readonly number[]): void {
		this.seedPath = [...seedPath];
	}

	getState(): JsonValue {
		return {
			seedPath: [...this.seedPath],
			centroids: this.centroids === undefined ? null : this.centroids.map((c) => [...c]),
			tail: [...this.tail],
			residual: [...this.residual],
			calls: this.calls,
			rounds: this.rounds,
			report: {
				mismatchRate: this.lastReport.mismatchRate,
				residualVar: this.lastReport.residualVar,
				reportedDistribution: { ...this.lastReport.reportedDistribution },
			},
		};
	}

	setState(s: JsonValue): void {
		const parsed = StateSchema.safeParse(s);
		if (!parsed.success) return;
		this.seedPath = parsed.data.seedPath;
		this.centroids = parsed.data.centroids ?? undefined;
		this.tail = new Set(parsed.data.tail.map((id) => id as EntityId));
		this.residual = [...parsed.data.residual];
		this.calls = parsed.data.calls;
		this.rounds = parsed.data.rounds;
		if (parsed.data.report !== null) this.lastReport = parsed.data.report;
	}

	private featuresAt(requests: readonly DecisionRequest[], i: number): readonly number[] {
		return requests[i]?.features ?? [];
	}

	// Tail set and k-means layers are built once, from the first round's features.
	private preprocess(
		requests: readonly DecisionRequest[],
		valid: readonly number[],
		rng: Rng,
	): void {
		const points = valid.map((i) => this.featuresAt(requests, i));
		const scores = tailScores(points);
		const tailCount = Math.ceil(this.options.tailFraction * valid.length);
		const ranked = valid
			.map((i, k) => ({ i, score: scores[k] ?? 0 }))
			.sort((a, b) => b.score - a.score || a.i - b.i)
			.slice(0, tailCount);
		this.tail = new Set(
			ranked.flatMap(({ i }) => {
				const id = requests[i]?.agentId;
				return id === undefined ? [] : [id];
			}),
		);
		const core = valid.filter((i) => {
			const id = requests[i]?.agentId;
			return id === undefined || !this.tail.has(id);
		});
		const n = valid.length;
		const layers = Math.max(
			1,
			Math.min(
				this.options.Mb,
				Math.ceil(this.options.Mb * Math.sqrt(n / this.options.Nb)),
				Math.max(1, core.length),
			),
		);
		this.centroids = miniBatchKMeans(
			core.map((i) => this.featuresAt(requests, i)),
			layers,
			rng.fork(keyFromLabel("kmeans")),
			this.options.kmeansIterations,
			this.options.kmeansBatch,
		);
		this.residual = this.centroids.map(() => 0);
		this.logger.info("aps preprocessed", { agents: n, tail: this.tail.size, layers });
	}

	private async route(
		requests: readonly DecisionRequest[],
		valid: readonly number[],
		results: (Result<Decision, ProviderFailure> | undefined)[],
		ctx: RoundContext,
	): Promise<void> {
		const o = this.options;
		const rng = rngFromSeed(o.seed, [...ctx.seedPath, keyFromLabel(`aps:${this.name}`)]);
		if (this.centroids === undefined)
			this.preprocess(requests, valid, rng.fork(keyFromLabel("preprocess")));
		const centroids = this.centroids ?? [];
		const layerCount = Math.max(1, centroids.length);
		const n = valid.length;

		// Layer membership for this round
		const layerOf = new Map<number, number>();
		const tailIndices: number[] = [];
		const members: number[][] = Array.from({ length: layerCount }, () => []);
		for (const i of valid) {
			const id = requests[i]?.agentId;
			if (id !== undefined && this.tail.has(id)) {
				tailIndices.push(i);
				continue;
			}
			const layer =
				centroids.length === 0 ? 0 : nearestIndex(this.featuresAt(requests, i), centroids);
			layerOf.set(i, layer);
			members[layer]?.push(i);
		}

		// Core budget across layers, proportional to |C_m| * sqrt(R_m + tau)
		const alpha = Math.max(o.alphaMin, o.alphaB * Math.sqrt(o.Nb / n));
		const coreSize = members.reduce((a, m) => a + m.length, 0);
		const budget = Math.min(coreSize, Math.ceil(alpha * n));
		const weights = members.map(
			(m, k) => m.length * Math.sqrt((this.residual[k] ?? 0) + o.tau),
		);
		const allocation = apportion(
			budget,
			weights,
			members.map((m) => m.length),
			1,
		);
		const prototypes = new Set<number>();
		members.forEach((m, k) => {
			const picked = rng
				.fork(keyFromLabel(`prototypes:${this.rounds}:${k}`))
				.shuffle(m)
				.slice(0, allocation[k] ?? 0);
			for (const i of picked) prototypes.add(i);
		});

		// Shadow audit: stratified sample of non-prototype agents, labels only correct the report
		const eligible = members.map((m) => m.filter((i) => !prototypes.has(i)));
		const auditBudget = Math.max(
			o.auditMin,
			Math.floor(o.gamma * o.Nb * Math.max(1, (n / o.Nb) ** 0.4)),
		);
		const auditAllocation = apportion(
			Math.min(
				auditBudget,
				eligible.reduce((a, m) => a + m.length, 0),
			),
			eligible.map((m) => m.length),
			eligible.map((m) => m.length),
			0,
		);
		const audited = new Map<number, number>(); // index -> inclusion probability
		eligible.forEach((m, k) => {
			const count = auditAllocation[k] ?? 0;
			if (count === 0 || m.length === 0) return;
			const picked = rng
				.fork(keyFromLabel(`audit:${this.rounds}:${k}`))
				.shuffle(m)
				.slice(0, count);
			for (const i of picked) audited.set(i, count / m.length);
		});

		// One downstream batch: tail, prototypes, audit samples
		const queried = [
			...tailIndices,
			...[...prototypes].sort((a, b) => a - b),
			...[...audited.keys()].sort((a, b) => a - b),
		];
		const subRequests = queried.flatMap((i) => {
			const req = requests[i];
			return req === undefined ? [] : [req];
		});
		const fetched = await this.downstream.decide(subRequests, {
			...ctx,
			seedPath: [...ctx.seedPath, keyFromLabel(`aps:${this.name}`)],
		});
		this.calls += subRequests.length;
		const fetchedAt = new Map<number, Result<Decision, ProviderFailure>>();
		queried.forEach((i, k) => {
			const r = fetched[k];
			if (r !== undefined) fetchedAt.set(i, r);
		});

		// Supports per layer from queried prototypes
		const supportByLayer: Support[][] = Array.from({ length: layerCount }, () => []);
		const allSupport: Support[] = [];
		for (const i of prototypes) {
			const r = fetchedAt.get(i);
			if (r === undefined || !r.ok) continue;
			const support: Support = { features: this.featuresAt(requests, i), decision: r.value };
			supportByLayer[layerOf.get(i) ?? 0]?.push(support);
			allSupport.push(support);
		}

		// Hard decisions and soft labels
		const soft = new Map<number, Readonly<Record<string, number>>>();
		const hard = new Map<number, string>();
		const setQueried = (i: number): void => {
			const r = fetchedAt.get(i);
			const req = requests[i];
			if (req === undefined) return;
			if (r === undefined) {
				results[i] = err({
					agentId: req.agentId,
					reason: "downstream returned no result",
					retryable: false,
				});
				return;
			}
			results[i] = r;
			if (r.ok) {
				soft.set(i, { [r.value.action]: 1 });
				hard.set(i, r.value.action);
			}
		};
		for (const i of tailIndices) setQueried(i);
		for (const i of prototypes) setQueried(i);
		for (const i of valid) {
			if (results[i] !== undefined) continue;
			const req = requests[i];
			if (req === undefined) continue;
			const layer = layerOf.get(i) ?? 0;
			const local = supportByLayer[layer] ?? [];
			const interpolated = interpolate(
				req.features ?? [],
				local.length > 0 ? local : allSupport,
				o.kappa,
			);
			const action = interpolated === undefined ? undefined : argmaxAction(interpolated.soft);
			if (interpolated === undefined || action === undefined) {
				results[i] = err({
					agentId: req.agentId,
					reason: "no queried prototype to interpolate from",
					retryable: false,
					excType: FAILURE_TYPES.providerContractViolation,
				});
				continue;
			}
			const template =
				local.find((s) => s.decision.action === action)?.decision ??
				allSupport.find((s) => s.decision.action === action)?.decision ??
				interpolated.nearest.decision;
			soft.set(i, interpolated.soft);
			hard.set(i, action);
			results[i] = ok({
				agentId: req.agentId,
				action,
				args: template.args,
				soft: interpolated.soft,
				provenance: "prototype",
				cost: ZERO_COST,
				parseOk: true,
			});
		}

		// Report: mean soft label plus the Horvitz-Thompson correction from audited labels
		const actions = new Set<string>();
		for (const h of soft.values()) for (const a of Object.keys(h)) actions.add(a);
		for (const i of audited.keys()) {
			const r = fetchedAt.get(i);
			if (r?.ok) actions.add(r.value.action);
		}
		const estimate: Record<string, number> = {};
		for (const a of actions) estimate[a] = 0;
		for (const h of soft.values())
			for (const [a, p] of Object.entries(h)) estimate[a] = (estimate[a] ?? 0) + p / n;
		const mismatch = new Map<number, number[]>();
		const residualVar = new Map<number, number[]>();
		for (const [i, psi] of audited) {
			const r = fetchedAt.get(i);
			const h = soft.get(i);
			if (r === undefined || !r.ok || h === undefined || psi <= 0) continue;
			const label = r.value.action;
			for (const a of actions) {
				const indicator = a === label ? 1 : 0;
				estimate[a] = (estimate[a] ?? 0) + (indicator - (h[a] ?? 0)) / psi / n;
			}
			const layer = layerOf.get(i) ?? 0;
			const miss = hard.get(i) === label ? 0 : 1;
			let sq = 0;
			for (const a of actions) sq += ((a === label ? 1 : 0) - (h[a] ?? 0)) ** 2;
			mismatch.set(layer, [...(mismatch.get(layer) ?? []), miss]);
			residualVar.set(layer, [...(residualVar.get(layer) ?? []), sq]);
		}
		const mean = (xs: readonly number[]): number =>
			xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
		for (let k = 0; k < layerCount; k += 1) {
			const m = mismatch.get(k);
			const v = residualVar.get(k);
			if (m === undefined || v === undefined) continue;
			this.residual[k] =
				o.lambda * (this.residual[k] ?? 0) +
				(1 - o.lambda) * (o.eta * mean(m) + o.zeta * mean(v));
		}
		const allMismatch = [...mismatch.values()].flat();
		const allResidual = [...residualVar.values()].flat();
		this.lastReport = {
			mismatchRate: mean(allMismatch),
			residualVar: mean(allResidual),
			reportedDistribution: projectToSimplex(estimate),
		};
		this.rounds += 1;
		this.logger.debug("aps round", {
			agents: n,
			queried: subRequests.length,
			audited: audited.size,
			mismatchRate: this.lastReport.mismatchRate,
		});
	}
}

export interface ApsProvider extends DecisionProvider {
	report(): ApsReport;
}

export const createApsProvider = (
	options: ApsProviderOptions,
	downstream: DecisionProvider,
	logger: Logger,
): ApsProvider => new ApsDecisionProvider(options, downstream, logger);
