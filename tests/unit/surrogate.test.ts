import { describe, expect, test } from "bun:test";
import { makeRunId, toEntityId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import { rngFromSeed } from "../../src/core/rng";
import type { DecisionRequest, RoundContext } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { ruleDecision } from "../../src/providers/rule";
import { createSurrogateProvider, softmax, type TraceEntry } from "../../src/providers/surrogate";

const ACTIONS = ["post", "like", "silent"] as const;

// The teacher is a piecewise-linear rule so that a softmax regression can learn it.
const teacher = (f: readonly number[]): string => {
	const [a = 0, b = 0] = f;
	if (a + 0.5 * b > 0.2) return "post";
	return b < -0.8 ? "like" : "silent";
};

const request = (i: number, features: readonly number[]): DecisionRequest => ({
	agentId: toEntityId(`agent-${i}`),
	t: { tick: 0, substep: 0, seq: 0 },
	state: {},
	observation: {},
	observationEvent: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FC0"),
	features,
	actionSpace: [...ACTIONS],
});

const trace = (count: number, seed: number): readonly TraceEntry[] => {
	const rng = rngFromSeed(seed, [0]);
	return Array.from({ length: count }, (_, i) => {
		const req = request(i, [rng.normal(), rng.normal()]);
		return { request: req, decision: ruleDecision(req, teacher(req.features ?? [])) };
	});
};

const roundContext = (): RoundContext => ({
	t: { tick: 0, substep: 0, seq: 0 },
	runId: makeRunId("s", 0),
	seedPath: [0],
	world: createWorld(),
	log: createMemoryEventLog(),
});

const provider = () =>
	createSurrogateProvider({
		name: "sur",
		seed: 3,
		iterations: 300,
		learningRate: 0.5,
		l2: 0.001,
	});

describe("surrogate provider", () => {
	test("fits a trace and beats the random baseline on held-out data", async () => {
		const surrogate = provider();
		surrogate.reset([1]);
		surrogate.fit(trace(3000, 11));
		const holdout = trace(500, 12);
		const results = await surrogate.decide(
			holdout.map((t) => t.request),
			roundContext(),
		);
		expect(results).toHaveLength(500);
		let correct = 0;
		for (const [i, r] of results.entries()) {
			expect(r.ok).toBe(true);
			if (!r.ok) continue;
			expect(r.value.provenance).toBe("surrogate");
			expect(String(r.value.agentId)).toBe(String(holdout[i]?.request.agentId));
			const soft = r.value.soft ?? {};
			expect(Object.values(soft).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
			if (r.value.action === holdout[i]?.decision.action) correct += 1;
		}
		const accuracy = correct / 500;
		expect(accuracy).toBeGreaterThan(1 / ACTIONS.length + 0.1);
		expect(accuracy).toBeGreaterThan(0.8);
	});

	test("same seed gives the same weights; state round-trips", () => {
		const a = provider();
		const b = provider();
		a.reset([2]);
		b.reset([2]);
		a.fit(trace(200, 5));
		b.fit(trace(200, 5));
		expect(a.getState()).toEqual(b.getState());
		expect(a.fitted()?.actions).toEqual(["like", "post", "silent"]);
		const c = provider();
		c.setState(a.getState());
		expect(c.getState()).toEqual(a.getState());
		expect(c.audit?.(roundContext())).toEqual({ fitted: 1, classes: 3, samples: 200 });
	});

	test("fails typed when unfitted, when features are absent or of the wrong width", async () => {
		const unfitted = provider();
		const [r0] = await unfitted.decide([request(0, [0, 0])], roundContext());
		expect(r0?.ok).toBe(false);
		if (r0 !== undefined && !r0.ok) expect(r0.error.excType).toBe("not_fitted");
		const fitted = provider();
		fitted.fit(trace(100, 7));
		const { features: _dropped, ...withoutFeatures } = request(1, [0, 0]);
		const [r1, r2, r3] = await fitted.decide(
			[
				withoutFeatures,
				request(2, [1, 2, 3]),
				{ ...request(3, [1, 1]), actionSpace: ["dance"] },
			],
			roundContext(),
		);
		expect(r1?.ok).toBe(false);
		if (r1 !== undefined && !r1.ok) expect(r1.error.excType).toBe("no_features");
		expect(r2?.ok).toBe(false);
		if (r2 !== undefined && !r2.ok) expect(r2.error.excType).toBe("no_features");
		expect(r3?.ok).toBe(false);
		if (r3 !== undefined && !r3.ok) expect(r3.error.excType).toBe("invalid_action");
	});

	test("softmax is a distribution and is shift invariant", () => {
		const p = softmax([1, 2, 3]);
		expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
		expect(softmax([101, 102, 103])).toEqual(p);
	});
});
