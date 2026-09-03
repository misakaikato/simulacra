// Surrogate provider: a multinomial logistic (softmax) regression fitted on a trace of
// (features, action) pairs, then used to decide from `features` alone at zero cost. Hand-written
// so the fit is deterministic under the derived rng and needs no dependency.
// 代理提供者：在（特征，动作）轨迹上拟合多项逻辑（softmax）回归，之后只凭 `features`
// 零成本决策。自写实现，拟合在派生 rng 下确定且不引入依赖。

import { z } from "zod";
import { FAILURE_TYPES } from "../core/failures";
import type { DecisionProvider, Rng } from "../core/protocols";
import { err, ok } from "../core/result";
import { keyFromLabel, rngFromSeed } from "../core/rng";
import type {
	Cost,
	Decision,
	DecisionRequest,
	JsonValue,
	ProviderFailure,
	Result,
	RoundContext,
} from "../core/types";

export const SURROGATE_KIND = "surrogate";

export const SurrogateOptionsSchema = z.object({
	iterations: z.number().int().positive().default(300),
	learningRate: z.number().positive().default(0.1),
	l2: z.number().nonnegative().default(0.001),
});

export interface SurrogateProviderOptions {
	readonly name: string;
	readonly seed: number;
	readonly iterations: number;
	readonly learningRate: number;
	readonly l2: number;
}

export interface SoftmaxModel {
	readonly actions: readonly string[];
	readonly weights: readonly (readonly number[])[]; // actions x (features + bias)
}

export interface TraceEntry {
	readonly request: DecisionRequest;
	readonly decision: Decision;
}

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const StateSchema = z.object({
	seedPath: z.array(z.number()),
	model: z
		.object({ actions: z.array(z.string()), weights: z.array(z.array(z.number())) })
		.nullable(),
	samples: z.number().int().nonnegative(),
});

export const softmax = (logits: readonly number[]): readonly number[] => {
	const max = Math.max(...logits);
	const exps = logits.map((l) => Math.exp(l - max));
	const total = exps.reduce((a, b) => a + b, 0);
	return exps.map((e) => e / total);
};

// The bias sits in the last column of each weight row, hence the row[features.length] term.
// 偏置放在每行权重的最后一列，所以先取 row[features.length]。
export const logitsOf = (model: SoftmaxModel, features: readonly number[]): readonly number[] =>
	model.weights.map((row) => {
		let z = row[features.length] ?? 0;
		for (let j = 0; j < features.length; j += 1) z += (row[j] ?? 0) * (features[j] ?? 0);
		return z;
	});

export const predictProbabilities = (
	model: SoftmaxModel,
	features: readonly number[],
): readonly number[] => softmax(logitsOf(model, features));

// Full-batch gradient descent on the multinomial logistic loss with an L2 penalty on the
// non-bias weights. Initial weights come from the derived rng so the fit is reproducible.
// 多项逻辑损失上的全批量梯度下降，非偏置权重带 L2 惩罚。初始权重取自派生 rng，拟合可复现。
export const fitSoftmax = (
	samples: readonly { readonly features: readonly number[]; readonly action: string }[],
	options: Pick<SurrogateProviderOptions, "iterations" | "learningRate" | "l2">,
	rng: Rng,
): SoftmaxModel | undefined => {
	const first = samples[0];
	if (first === undefined) return undefined;
	const dims = first.features.length;
	const usable = samples.filter((s) => s.features.length === dims);
	const actions = [...new Set(usable.map((s) => s.action))].sort();
	if (usable.length === 0 || actions.length === 0) return undefined;
	const index = new Map(actions.map((a, i) => [a, i] as const));
	const weights = actions.map(() => Array.from({ length: dims + 1 }, () => rng.normal(0, 0.01)));
	const n = usable.length;
	// Cross-entropy gradient per sample is (p_k - 1[k = target]) * x (and the same delta for the
	// bias); dividing by n keeps the learning rate independent of trace size.
	// 每个样本的交叉熵梯度是 (p_k - 1[k = target]) * x（偏置用同一个 delta）；
	// 除以 n 让学习率与轨迹大小无关。
	for (let it = 0; it < options.iterations; it += 1) {
		const grad = actions.map(() => new Array<number>(dims + 1).fill(0));
		for (const sample of usable) {
			const probs = predictProbabilities({ actions, weights }, sample.features);
			const target = index.get(sample.action) ?? 0;
			for (let k = 0; k < actions.length; k += 1) {
				const delta = (probs[k] ?? 0) - (k === target ? 1 : 0);
				const row = grad[k];
				if (row === undefined) continue;
				for (let j = 0; j < dims; j += 1)
					row[j] = (row[j] ?? 0) + delta * (sample.features[j] ?? 0);
				row[dims] = (row[dims] ?? 0) + delta;
			}
		}
		for (let k = 0; k < actions.length; k += 1) {
			const row = weights[k];
			const g = grad[k];
			if (row === undefined || g === undefined) continue;
			for (let j = 0; j <= dims; j += 1) {
				const penalty = j < dims ? options.l2 * (row[j] ?? 0) : 0;
				row[j] = (row[j] ?? 0) - options.learningRate * ((g[j] ?? 0) / n + penalty);
			}
		}
	}
	return { actions, weights };
};

class SurrogateDecisionProvider implements DecisionProvider {
	readonly name: string;
	private readonly options: SurrogateProviderOptions;
	private seedPath: readonly number[] = [];
	private model: SoftmaxModel | undefined;
	private samples = 0;

	constructor(options: SurrogateProviderOptions) {
		this.name = options.name;
		this.options = options;
	}

	fit(trace: readonly TraceEntry[]): void {
		const samples = trace.flatMap((t) =>
			t.request.features === undefined
				? []
				: [{ features: t.request.features, action: t.decision.action }],
		);
		this.model = fitSoftmax(
			samples,
			this.options,
			rngFromSeed(this.options.seed, [...this.seedPath, keyFromLabel("surrogate:init")]),
		);
		this.samples = samples.length;
	}

	async decide(
		requests: readonly DecisionRequest[],
		_ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]> {
		return requests.map((req) => this.decideOne(req));
	}

	audit(): Readonly<Record<string, number>> {
		return {
			fitted: this.model === undefined ? 0 : 1,
			classes: this.model?.actions.length ?? 0,
			samples: this.samples,
		};
	}

	reset(seedPath: readonly number[]): void {
		this.seedPath = [...seedPath];
	}

	getState(): JsonValue {
		return {
			seedPath: [...this.seedPath],
			model:
				this.model === undefined
					? null
					: {
							actions: [...this.model.actions],
							weights: this.model.weights.map((row) => [...row]),
						},
			samples: this.samples,
		};
	}

	setState(s: JsonValue): void {
		const parsed = StateSchema.safeParse(s);
		if (!parsed.success) return;
		this.seedPath = parsed.data.seedPath;
		this.model = parsed.data.model ?? undefined;
		this.samples = parsed.data.samples;
	}

	fitted(): SoftmaxModel | undefined {
		return this.model;
	}

	// `soft` reports every fitted class, but the hard choice is restricted to the request's action
	// space so a model fitted on an older action set never emits something the executor cannot
	// resolve.
	// `soft` 报告全部拟合类别，硬决策只在请求的动作空间内选，
	// 在旧动作集上拟合的模型不会给出执行体无法解析的动作。
	private decideOne(req: DecisionRequest): Result<Decision, ProviderFailure> {
		const model = this.model;
		if (model === undefined)
			return err({
				agentId: req.agentId,
				reason: "surrogate has not been fitted",
				retryable: false,
				excType: FAILURE_TYPES.notFitted,
			});
		const features = req.features;
		if (features === undefined)
			return err({
				agentId: req.agentId,
				reason: "request carries no features",
				retryable: false,
				excType: FAILURE_TYPES.noFeatures,
			});
		const dims = (model.weights[0]?.length ?? 1) - 1;
		if (features.length !== dims)
			return err({
				agentId: req.agentId,
				reason: `expected ${dims} features, got ${features.length}`,
				retryable: false,
				excType: FAILURE_TYPES.noFeatures,
			});
		const probs = predictProbabilities(model, features);
		let best: { readonly action: string; readonly p: number } | undefined;
		const soft: Record<string, number> = {};
		model.actions.forEach((action, i) => {
			const p = probs[i] ?? 0;
			soft[action] = p;
			if (!req.actionSpace.includes(action)) return;
			if (best === undefined || p > best.p) best = { action, p };
		});
		if (best === undefined)
			return err({
				agentId: req.agentId,
				reason: "no fitted action is in the action space",
				retryable: false,
				excType: FAILURE_TYPES.invalidAction,
			});
		return ok({
			agentId: req.agentId,
			action: best.action,
			args: {},
			soft,
			provenance: "surrogate",
			cost: ZERO_COST,
			parseOk: true,
		});
	}
}

export interface SurrogateProvider extends DecisionProvider {
	fit(trace: readonly TraceEntry[]): void;
	fitted(): SoftmaxModel | undefined;
}

export const createSurrogateProvider = (options: SurrogateProviderOptions): SurrogateProvider =>
	new SurrogateDecisionProvider(options);
