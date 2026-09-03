// Rule provider: a user-supplied `(request, rng) => Decision` function with a per-agent rng
// derived from the scenario seed, the round's seed path and a hash of the agent id, so an agent's
// stream does not depend on batch order. A throwing rule is a per-agent failure, not a crash.
// 规则提供者：用户给的 `(request, rng) => Decision` 函数，rng 由场景种子、本轮种子路径与
// agent id 的哈希派生，agent 的随机流与批次顺序无关。规则抛异常记为该 agent 的失败而非崩溃。

import { FAILURE_TYPES } from "../core/failures";
import { sha256Hex } from "../core/hash";
import type { DecisionProvider, Rng } from "../core/protocols";
import { err, ok } from "../core/result";
import { rngFromSeed } from "../core/rng";
import type {
	Cost,
	Decision,
	DecisionRequest,
	EntityId,
	JsonValue,
	ProviderFailure,
	Result,
	RoundContext,
} from "../core/types";
import { readSeedPathState, seedPathState } from "./state";

export type RuleFn = (req: DecisionRequest, rng: Rng) => Decision;

export interface RuleProviderOptions {
	readonly name: string;
	readonly seed: number;
	readonly rule: RuleFn;
}

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const agentKey = (id: EntityId): number => Number.parseInt(sha256Hex(id).slice(0, 8), 16) >>> 0;

class RuleProvider implements DecisionProvider {
	readonly name: string;
	private readonly seed: number;
	private readonly rule: RuleFn;
	private seedPath: readonly number[] = [];

	constructor(options: RuleProviderOptions) {
		this.name = options.name;
		this.seed = options.seed;
		this.rule = options.rule;
	}

	async decide(
		requests: readonly DecisionRequest[],
		ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]> {
		return requests.map((req) => {
			const rng = rngFromSeed(this.seed, [...ctx.seedPath, agentKey(req.agentId)]);
			try {
				return ok(this.rule(req, rng));
			} catch (e) {
				return err({
					agentId: req.agentId,
					reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
					retryable: false,
					excType: FAILURE_TYPES.ruleThrew,
				});
			}
		});
	}

	reset(seedPath: readonly number[]): void {
		this.seedPath = [...seedPath];
	}

	getState(): JsonValue {
		return seedPathState(this.seedPath);
	}

	setState(s: JsonValue): void {
		const seedPath = readSeedPathState(s);
		if (seedPath !== undefined) this.seedPath = seedPath;
	}
}

export const createRuleProvider = (options: RuleProviderOptions): DecisionProvider =>
	new RuleProvider(options);

// Built-in rule over the feature vector: one action when a feature exceeds a threshold, another otherwise.
// 内置的特征向量规则：某个特征超过阈值选一个动作，否则选另一个。

export interface ThresholdRuleOptions {
	readonly feature: number;
	readonly threshold: number;
	readonly above: string;
	readonly below: string;
}

export const ruleDecision = (req: DecisionRequest, action: string): Decision => ({
	agentId: req.agentId,
	action,
	args: {},
	provenance: "rule",
	cost: ZERO_COST,
	parseOk: true,
});

export const thresholdRule =
	(options: ThresholdRuleOptions): RuleFn =>
	(req) => {
		const value = req.features?.[options.feature];
		if (value === undefined)
			throw new RangeError(`request carries no feature at index ${options.feature}`);
		return ruleDecision(req, value > options.threshold ? options.above : options.below);
	};
