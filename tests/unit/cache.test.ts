import { describe, expect, test } from "bun:test";
import { makeRunId, toEntityId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import type { DecisionProvider } from "../../src/core/protocols";
import { err, ok } from "../../src/core/result";
import { createWorld } from "../../src/core/world";
import type { DecisionRequest, JsonObject, RoundContext } from "../../src/core/types";
import { cacheKeyOf, createCacheProvider } from "../../src/providers/cache";
import { ruleDecision } from "../../src/providers/rule";

const request = (
	i: number,
	state: JsonObject,
	observation: JsonObject,
	actionSpace: readonly string[] = ["post", "silent"],
): DecisionRequest => ({
	agentId: toEntityId(`agent-${i}`),
	t: { tick: 0, substep: 0, seq: 0 },
	state,
	observation,
	observationEvent: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FC0"),
	actionSpace,
});

const roundContext = (): RoundContext => ({
	t: { tick: 0, substep: 0, seq: 0 },
	runId: makeRunId("s", 0),
	seedPath: [0],
	world: createWorld(),
	log: createMemoryEventLog(),
});

const countingDownstream = (): { readonly provider: DecisionProvider; calls: number } => {
	const handle = {
		calls: 0,
		provider: {
			name: "down",
			decide: async (requests: readonly DecisionRequest[]) => {
				handle.calls += requests.length;
				return requests.map((req) =>
					typeof req.state.fail === "boolean" && req.state.fail
						? err({ agentId: req.agentId, reason: "nope", retryable: false })
						: ok({
								...ruleDecision(req, "post"),
								args: { text: String(req.state.x) },
								rationale: "r",
							}),
				);
			},
			reset: () => {},
			getState: () => null,
			setState: () => {},
		},
	};
	return handle;
};

describe("cache provider", () => {
	test("same key is served from the store; different keys reach downstream", async () => {
		const down = countingDownstream();
		const cache = createCacheProvider({ name: "c" }, down.provider);
		const first = await cache.decide(
			[request(1, { x: 1 }, { feed: [] }), request(2, { x: 2 }, { feed: [] })],
			roundContext(),
		);
		expect(down.calls).toBe(2);
		expect(first.map((r) => (r.ok ? r.value.provenance : "err"))).toEqual(["rule", "rule"]);
		const second = await cache.decide(
			[
				request(3, { x: 1 }, { feed: [] }),
				request(4, { x: 3 }, { feed: [] }),
				request(5, { x: 3 }, { feed: [] }),
			],
			roundContext(),
		);
		expect(down.calls).toBe(3);
		expect(second.map((r) => (r.ok ? r.value.provenance : "err"))).toEqual([
			"cache",
			"rule",
			"cache",
		]);
		expect(second.map((r) => (r.ok ? String(r.value.agentId) : ""))).toEqual([
			"agent-3",
			"agent-4",
			"agent-5",
		]);
		expect(second[0]?.ok && second[0].value.args).toEqual({ text: "1" });
		expect(second[0]?.ok && second[0].value.rationale).toBe("r");
		expect(cache.audit?.(roundContext())).toEqual({
			hitRate: 0.4,
			hits: 2,
			misses: 3,
			entries: 3,
		});
	});

	test("keyFields restrict the key and stored actions outside the action space miss", async () => {
		const down = countingDownstream();
		const cache = createCacheProvider(
			{ name: "c", keyFields: ["state.x", "observation.feed"] },
			down.provider,
		);
		await cache.decide([request(1, { x: 1, y: 9 }, { feed: [], t: 1 })], roundContext());
		const [hit] = await cache.decide(
			[request(2, { x: 1, y: 10 }, { feed: [], t: 2 })],
			roundContext(),
		);
		expect(down.calls).toBe(1);
		expect(hit?.ok && hit.value.provenance).toBe("cache");
		const [miss] = await cache.decide(
			[request(3, { x: 1, y: 10 }, { feed: [], t: 2 }, ["silent"])],
			roundContext(),
		);
		expect(down.calls).toBe(2);
		expect(miss?.ok && miss.value.provenance).toBe("rule");
		expect(cacheKeyOf(request(1, { x: 1, y: 9 }, { feed: [] }), ["state.x"])).toBe(
			cacheKeyOf(request(9, { x: 1, y: 0 }, { feed: [1] }), ["state.x"]),
		);
		expect(cacheKeyOf(request(1, { x: 1 }, {}))).not.toBe(cacheKeyOf(request(1, { x: 2 }, {})));
	});

	test("downstream failures are not stored and state round-trips", async () => {
		const down = countingDownstream();
		const cache = createCacheProvider({ name: "c" }, down.provider);
		const [failed] = await cache.decide([request(1, { fail: true }, {})], roundContext());
		expect(failed?.ok).toBe(false);
		await cache.decide([request(2, { fail: true }, {})], roundContext());
		expect(down.calls).toBe(2);
		await cache.decide([request(3, { x: 5 }, {})], roundContext());
		const state = cache.getState();
		const restored = createCacheProvider({ name: "c2" }, down.provider);
		restored.setState(state);
		expect(restored.getState()).toEqual(state);
		const [hit] = await restored.decide([request(4, { x: 5 }, {})], roundContext());
		expect(hit?.ok && hit.value.provenance).toBe("cache");
		expect(down.calls).toBe(3);
	});
});
