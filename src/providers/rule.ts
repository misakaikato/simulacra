import { FAILURE_TYPES } from "../core/failures";
import { sha256Hex } from "../core/hash";
import type { DecisionProvider, Rng } from "../core/protocols";
import { err, ok } from "../core/result";
import { rngFromSeed } from "../core/rng";
import type {
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
