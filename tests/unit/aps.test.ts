import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRunId, toEntityId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import type { DecisionProvider } from "../../src/core/protocols";
import { ok } from "../../src/core/result";
import { rngFromSeed } from "../../src/core/rng";
import { overrideScenario, parseScenarioYaml } from "../../src/core/scenario";
import { createSimulation } from "../../src/core/simulation";
import type { DecisionRequest, RoundContext } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { silentLogger } from "../../src/logging/logger";
import {
	apportion,
	createApsProvider,
	miniBatchKMeans,
	projectToSimplex,
	tailScores,
	type ApsProviderOptions,
} from "../../src/providers/routers/aps";
import { ruleDecision } from "../../src/providers/rule";
import { gatewayFactory } from "../helpers/kernel";
import { builtinRegistry } from "../helpers/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "../..");
const N = 2000;
const TICKS = 5;

// A three-way teacher over two features: the downstream everything is compared against.
const teacher = (f: readonly number[]): string => {
	const [a = 0, b = 0] = f;
	if (a > 0.5) return "post";
	return b < -0.5 ? "like" : "silent";
};

const teacherProvider = () => {
	const handle = {
		calls: 0,
		provider: {
			name: "teacher",
			decide: async (requests: readonly DecisionRequest[]) => {
				handle.calls += requests.length;
				return requests.map((req) => ok(ruleDecision(req, teacher(req.features ?? []))));
			},
			reset: () => {},
			getState: () => null,
			setState: () => {},
		} satisfies DecisionProvider,
	};
	return handle;
};

const requestsFor = (round: number): readonly DecisionRequest[] => {
	const rng = rngFromSeed(99, [round]);
	return Array.from({ length: N }, (_, i) => ({
		agentId: toEntityId(`agent-${String(i).padStart(5, "0")}`),
		t: { tick: round, substep: 0, seq: 0 },
		state: {},
		observation: {},
		observationEvent: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FC0"),
		features: [rng.normal(), rng.normal()],
		actionSpace: ["post", "like", "silent"],
	}));
};

const context = (round: number): RoundContext => ({
	t: { tick: round, substep: 0, seq: 0 },
	runId: makeRunId("aps", 0),
	seedPath: [round],
	world: createWorld(),
	log: createMemoryEventLog(),
});

const distributionOf = (actions: readonly string[]): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const a of actions) out[a] = (out[a] ?? 0) + 1 / actions.length;
	return out;
};

const jsd = (p: Record<string, number>, q: Record<string, number>): number => {
	const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
	const kl = (a: Record<string, number>, m: Record<string, number>): number => {
		let s = 0;
		for (const k of keys) {
			const ak = a[k] ?? 0;
			const mk = m[k] ?? 0;
			if (ak > 0 && mk > 0) s += ak * Math.log2(ak / mk);
		}
		return s;
	};
	const m: Record<string, number> = {};
	for (const k of keys) m[k] = ((p[k] ?? 0) + (q[k] ?? 0)) / 2;
	return (kl(p, m) + kl(q, m)) / 2;
};

const OPTIONS: ApsProviderOptions = {
	name: "aps",
	seed: 7,
	Nb: 5000,
	alphaB: 0.08,
	Mb: 10,
	lambda: 0.6,
	eta: 0.5,
	zeta: 0.4,
	gamma: 0.02,
	kappa: 5,
	tau: 0.1,
	tailFraction: 0.02,
	alphaMin: 0.01,
	auditMin: 5,
	kmeansIterations: 20,
	kmeansBatch: 256,
};

describe("aps router", () => {
	test("queries under 30% of agents and reports a distribution close to the full direct one", async () => {
		const down = teacherProvider();
		const aps = createApsProvider(OPTIONS, down.provider, silentLogger);
		aps.reset([0]);
		for (let round = 0; round < TICKS; round += 1) {
			const requests = requestsFor(round);
			const results = await aps.decide(requests, context(round));
			expect(results).toHaveLength(N);
			expect(results.every((r) => r.ok)).toBe(true);
			const direct = distributionOf(requests.map((r) => teacher(r.features ?? [])));
			const report = aps.report();
			expect(jsd(report.reportedDistribution, direct)).toBeLessThan(0.05);
			const total = Object.values(report.reportedDistribution).reduce((a, b) => a + b, 0);
			expect(total).toBeCloseTo(1, 9);
			const hard = distributionOf(results.map((r) => (r.ok ? r.value.action : "")));
			expect(jsd(hard, direct)).toBeLessThan(0.05);
			const prototypes = results.filter((r) => r.ok && r.value.provenance === "prototype");
			expect(prototypes.length).toBeGreaterThan(N / 2);
			for (const r of prototypes) {
				if (!r.ok) continue;
				const soft = r.value.soft ?? {};
				expect(Object.values(soft).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
				expect(soft[r.value.action]).toBeGreaterThan(0);
			}
		}
		expect(down.calls).toBeLessThan(0.3 * N * TICKS);
		expect(down.calls).toBe(aps.report().calls);
		const audit = aps.audit?.(context(TICKS)) ?? {};
		expect(audit.mismatchRate).toBeLessThan(0.2);
		expect(audit["reportedDistribution.post"]).toBeGreaterThan(0);
		expect(audit.layers).toBe(7);
	});

	test("same seed and requests give identical decisions and reports", async () => {
		const a = createApsProvider(OPTIONS, teacherProvider().provider, silentLogger);
		const b = createApsProvider(OPTIONS, teacherProvider().provider, silentLogger);
		const requests = requestsFor(0);
		const ra = await a.decide(requests, context(0));
		const rb = await b.decide(requests, context(0));
		expect(ra).toEqual(rb);
		expect(a.report()).toEqual(b.report());
		expect(a.getState()).toEqual(b.getState());
		const restored = createApsProvider(OPTIONS, teacherProvider().provider, silentLogger);
		restored.setState(a.getState());
		expect(restored.getState()).toEqual(a.getState());
	});

	test("requests without features fail typed while the rest are routed", async () => {
		const aps = createApsProvider(OPTIONS, teacherProvider().provider, silentLogger);
		const requests = requestsFor(0).slice(0, 50);
		const { features: _dropped, ...bare } = requests[0] ?? requestsFor(0)[0]!;
		const results = await aps.decide([bare, ...requests.slice(1)], context(0));
		expect(results[0]?.ok).toBe(false);
		if (results[0] !== undefined && !results[0].ok)
			expect(results[0].error.excType).toBe("no_features");
		expect(results.slice(1).every((r) => r.ok)).toBe(true);
	});

	test("runs inside the kernel over a cohort executor", async () => {
		const parsed = parseScenarioYaml(
			readFileSync(join(ROOT, "examples", "echo_chamber", "cohort.yaml"), "utf8"),
		);
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
		const sized = overrideScenario(parsed.value, "population.n", 500);
		if (!sized.ok) throw new Error(sized.error.kind);
		const scenario = {
			...sized.value,
			policy: { kind: "allAgents" },
			providers: {
				rule: {
					kind: "aps",
					options: { downstream: "teacher", alphaB: 0.08, gamma: 0.02 },
				},
				teacher: { kind: "cohortRule", options: { threshold: 0.3 } },
			},
		};
		const registry = builtinRegistry();
		const created = createSimulation(scenario, registry, {
			outDir: mkdtempSync(join(tmpdir(), "simulacra-aps-")),
			logger: silentLogger,
			log: createMemoryEventLog(),
			createGateway: gatewayFactory,
		});
		if (!created.ok) throw new Error(`${created.error.excType}: ${created.error.message}`);
		const sim = created.value;
		for (let i = 0; i < 3; i += 1) {
			const r = await sim.step();
			expect(r.ok).toBe(true);
		}
		expect(sim.integrity().complete).toBe(true);
		expect(sim.integrity().failed).toBe(0);
		const provenances = new Set(sim.log.query({ kind: ["decision"] }).map((e) => e.provenance));
		expect(provenances).toEqual(new Set(["rule", "prototype"]));
	});
});

describe("aps helpers", () => {
	test("tail scores rank outliers first", () => {
		const points = [
			[0, 0],
			[0.1, -0.1],
			[-0.1, 0.1],
			[0.2, 0],
			[10, 10],
		];
		const scores = tailScores(points);
		expect(scores.indexOf(Math.max(...scores))).toBe(4);
		expect(tailScores([])).toEqual([]);
	});

	test("apportion respects caps, minimums and the total", () => {
		expect(apportion(10, [1, 1, 2], [5, 5, 5], 1)).toEqual([3, 2, 5]);
		expect(apportion(4, [3, 1], [2, 10], 1)).toEqual([2, 2]);
		expect(apportion(0, [1, 1], [5, 5], 1)).toEqual([0, 0]);
		expect(apportion(3, [1, 0], [5, 0], 1)).toEqual([3, 0]);
	});

	test("simplex projection returns a distribution", () => {
		const p = projectToSimplex({ a: 0.7, b: 0.5, c: -0.2 });
		expect(Object.values(p).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12);
		expect(p.c).toBe(0);
		expect(p.a).toBeGreaterThan(p.b ?? 0);
		expect(projectToSimplex({ a: 0.25, b: 0.75 })).toEqual({ a: 0.25, b: 0.75 });
	});

	test("mini-batch k-means is deterministic and places centroids near the clusters", () => {
		const rng = rngFromSeed(1, [0]);
		const points = Array.from({ length: 400 }, (_, i) =>
			i % 2 === 0
				? [5 + rng.normal(0, 0.3), 5 + rng.normal(0, 0.3)]
				: [-5 + rng.normal(0, 0.3), -5],
		);
		const a = miniBatchKMeans(points, 2, rngFromSeed(2, [0]), 20, 64);
		const b = miniBatchKMeans(points, 2, rngFromSeed(2, [0]), 20, 64);
		expect(a).toEqual(b);
		const sorted = [...a].sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
		expect(sorted[0]?.[0]).toBeCloseTo(-5, 0);
		expect(sorted[1]?.[0]).toBeCloseTo(5, 0);
		expect(miniBatchKMeans([], 3, rng, 5, 5)).toEqual([]);
	});
});
