// Cache provider: memoises downstream decisions under a hash of (state subset, observation
// subset). Hits are replayed with provenance `cache` and zero cost, identical keys inside one
// batch share a single downstream call, and entries survive checkpoints through getState.
// 缓存提供者：按（状态子集，观察子集）的哈希记忆下游决策。命中以 provenance `cache`、零成本
// 复用，同一批内相同键只调一次下游，条目经 getState 跨检查点保留。

import { z } from "zod";
import { canonicalJson, sha256Hex } from "../core/hash";
import type { DecisionProvider } from "../core/protocols";
import { err, ok } from "../core/result";
import { JsonObjectSchema } from "../core/schema";
import type {
	Cost,
	Decision,
	DecisionRequest,
	JsonObject,
	JsonValue,
	ProviderFailure,
	Result,
	RoundContext,
} from "../core/types";

export const CACHE_KIND = "cache";

export const CacheOptionsSchema = z.object({
	downstream: z.string().min(1),
	keyFields: z.array(z.string().min(1)).optional(),
});

export interface CacheProviderOptions {
	readonly name: string;
	readonly keyFields?: readonly string[];
}

const STATE_PREFIX = "state.";
const OBSERVATION_PREFIX = "observation.";

const EntrySchema = z.object({
	action: z.string(),
	args: JsonObjectSchema,
	soft: z.record(z.string(), z.number()).optional(),
	rationale: z.string().optional(),
});

const StateSchema = z.object({
	seedPath: z.array(z.number()),
	entries: z.record(z.string(), EntrySchema),
	hits: z.number().int().nonnegative(),
	misses: z.number().int().nonnegative(),
});

type Entry = z.output<typeof EntrySchema>;

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const subset = (source: JsonObject, keys: readonly string[] | undefined): JsonObject => {
	if (keys === undefined) return source;
	const out: Record<string, JsonValue> = {};
	for (const key of keys) {
		const value = source[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
};

// Key fields are written as state.<column> or observation.<key>; without any the whole
// state and observation form the key.
// 键字段写成 state.<列名> 或 observation.<键名>；不给键字段时整个状态与观察构成键。
export const cacheKeyOf = (req: DecisionRequest, keyFields?: readonly string[]): string => {
	const stateKeys =
		keyFields === undefined
			? undefined
			: keyFields
					.filter((k) => k.startsWith(STATE_PREFIX))
					.map((k) => k.slice(STATE_PREFIX.length));
	const observationKeys =
		keyFields === undefined
			? undefined
			: keyFields
					.filter((k) => k.startsWith(OBSERVATION_PREFIX))
					.map((k) => k.slice(OBSERVATION_PREFIX.length));
	return sha256Hex(
		canonicalJson({
			state: subset(req.state, stateKeys),
			observation: subset(req.observation, observationKeys),
		}),
	);
};

const entryOf = (d: Decision): Entry => ({
	action: d.action,
	args: d.args,
	...(d.soft === undefined ? {} : { soft: d.soft }),
	...(d.rationale === undefined ? {} : { rationale: d.rationale }),
});

const entryJson = (entry: Entry): JsonObject => ({
	action: entry.action,
	args: entry.args,
	...(entry.soft === undefined ? {} : { soft: entry.soft }),
	...(entry.rationale === undefined ? {} : { rationale: entry.rationale }),
});

const fromEntry = (req: DecisionRequest, entry: Entry): Decision => ({
	agentId: req.agentId,
	action: entry.action,
	args: entry.args,
	...(entry.soft === undefined ? {} : { soft: entry.soft }),
	...(entry.rationale === undefined ? {} : { rationale: entry.rationale }),
	provenance: "cache",
	cost: ZERO_COST,
	parseOk: true,
});

class CacheProvider implements DecisionProvider {
	readonly name: string;
	private readonly keyFields: readonly string[] | undefined;
	private readonly downstream: DecisionProvider;
	private entries = new Map<string, Entry>();
	private seedPath: readonly number[] = [];
	private hits = 0;
	private misses = 0;

	constructor(options: CacheProviderOptions, downstream: DecisionProvider) {
		this.name = options.name;
		this.keyFields = options.keyFields;
		this.downstream = downstream;
	}

	// A hit is usable only while the cached action is still in the request's action space;
	// otherwise the request goes downstream and the entry is overwritten. Failures are never
	// cached, so a transient downstream error is retried on the next identical request.
	// 只有缓存的动作仍在请求的动作空间内才算命中；否则请求走下游并覆盖条目。
	// 失败从不缓存，下游的瞬时错误在下一次相同请求时会重试。
	async decide(
		requests: readonly DecisionRequest[],
		ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]> {
		const keys = requests.map((req) => cacheKeyOf(req, this.keyFields));
		const results: (Result<Decision, ProviderFailure> | undefined)[] = requests.map(
			() => undefined,
		);
		const representatives: { readonly index: number; readonly key: string }[] = [];
		const seen = new Set<string>();
		requests.forEach((req, index) => {
			const key = keys[index] ?? "";
			const entry = this.entries.get(key);
			if (entry !== undefined && req.actionSpace.includes(entry.action)) {
				results[index] = ok(fromEntry(req, entry));
				this.hits += 1;
				return;
			}
			if (seen.has(key)) {
				this.hits += 1;
				return;
			}
			this.misses += 1;
			seen.add(key);
			representatives.push({ index, key });
		});
		if (representatives.length > 0) {
			const downstreamRequests = representatives.flatMap(({ index }) => {
				const req = requests[index];
				return req === undefined ? [] : [req];
			});
			const fetched = await this.downstream.decide(downstreamRequests, ctx);
			const byKey = new Map<string, Result<Decision, ProviderFailure>>();
			representatives.forEach(({ key }, i) => {
				const result = fetched[i];
				if (result === undefined) return;
				byKey.set(key, result);
				if (result.ok) this.entries.set(key, entryOf(result.value));
			});
			requests.forEach((req, index) => {
				if (results[index] !== undefined) return;
				const result = byKey.get(keys[index] ?? "");
				if (result === undefined) return;
				results[index] = result.ok
					? result.value.agentId === req.agentId
						? result
						: ok(fromEntry(req, entryOf(result.value)))
					: err({ ...result.error, agentId: req.agentId });
			});
		}
		return requests.map(
			(req, index) =>
				results[index] ??
				err({
					agentId: req.agentId,
					reason: "downstream returned no result",
					retryable: false,
				}),
		);
	}

	audit(): Readonly<Record<string, number>> {
		const total = this.hits + this.misses;
		return {
			hitRate: total === 0 ? 0 : this.hits / total,
			hits: this.hits,
			misses: this.misses,
			entries: this.entries.size,
		};
	}

	reset(seedPath: readonly number[]): void {
		this.seedPath = [...seedPath];
	}

	getState(): JsonValue {
		const entries: Record<string, JsonObject> = {};
		for (const [k, v] of this.entries) entries[k] = entryJson(v);
		return { seedPath: [...this.seedPath], entries, hits: this.hits, misses: this.misses };
	}

	setState(s: JsonValue): void {
		const parsed = StateSchema.safeParse(s);
		if (!parsed.success) return;
		this.seedPath = parsed.data.seedPath;
		this.entries = new Map(Object.entries(parsed.data.entries));
		this.hits = parsed.data.hits;
		this.misses = parsed.data.misses;
	}
}

export const createCacheProvider = (
	options: CacheProviderOptions,
	downstream: DecisionProvider,
): DecisionProvider => new CacheProvider(options, downstream);
