import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COHORT_RULE_KIND } from "../../src/providers";
import { columnStats, zScore } from "../../src/agents/cohort";
import { opinionDynamics } from "../../src/agents/transitions";
import { makeRunId, toEntityId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import type { DecisionProvider, GraphView } from "../../src/core/protocols";
import { ok } from "../../src/core/result";
import { rngFromSeed } from "../../src/core/rng";
import { overrideScenario, parseScenarioYaml } from "../../src/core/scenario";
import { createSimulation, type Simulation } from "../../src/core/simulation";
import type { Decision, EntityId, JsonValue, Scenario } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { silentLogger } from "../../src/logging/logger";
import { ruleDecision } from "../../src/providers/rule";
import { gatewayFactory } from "../helpers/kernel";
import { builtinRegistry } from "../helpers/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "../..");
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-cohort-"));

const ZERO_COST = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
} as const;

const cohortScenario = (n: number, extra: (s: Scenario) => Scenario = (s) => s): Scenario => {
	const parsed = parseScenarioYaml(
		readFileSync(join(ROOT, "examples", "echo_chamber", "cohort.yaml"), "utf8"),
	);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	const sized = overrideScenario(parsed.value, "population.n", n);
	if (!sized.ok) throw new Error(sized.error.kind);
	return extra(sized.value);
};

const build = (scenario: Scenario, registry = builtinRegistry()): Simulation => {
	const created = createSimulation(scenario, registry, {
		outDir: tempDir(),
		logger: silentLogger,
		log: createMemoryEventLog(),
		createGateway: gatewayFactory,
	});
	if (!created.ok) throw new Error(`${created.error.excType}: ${created.error.message}`);
	return created.value;
};

const runTicks = async (sim: Simulation, ticks: number): Promise<void> => {
	for (let i = 0; i < ticks; i += 1) {
		const r = await sim.step();
		if (!r.ok) throw new Error(r.error.message);
	}
};

const decision = (agentId: EntityId, action: string): Decision => ({
	agentId,
	action,
	args: {},
	provenance: "rule",
	cost: ZERO_COST,
	parseOk: true,
});

describe("cohort.yaml", () => {
	test("population.n is driven by params.n and the schema resolves the reference", () => {
		const parsed = parseScenarioYaml(
			readFileSync(join(ROOT, "examples", "echo_chamber", "cohort.yaml"), "utf8"),
		);
		expect(parsed.ok && parsed.value.population.n).toBe(100000);
		expect(parsed.ok && parsed.value.params.n).toBe(100000);
		const missing = parseScenarioYaml(
			"scenarioId: x\nseed: 1\npopulation:\n  n: { $param: size }\n",
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok)
			expect(missing.error.map((i) => i.path.join("."))).toContain("population.n");
	});
});

describe("opinionDynamics transition", () => {
	test("moves stance toward the mean of posting neighbours, scaled by rate and stubbornness", () => {
		const world = createWorld();
		for (const [name, dtype] of [
			["stance", "f64"],
			["stubbornness", "f64"],
		] as const) {
			const r = world.declare({
				entity: "agent",
				name,
				dtype,
				default: 0,
				owner: "persona",
				merge: "last",
			});
			if (!r.ok) throw new Error(r.error.message);
		}
		const ids = world.create(
			"agent",
			[
				{ "persona.stance": 0, "persona.stubbornness": 0.5 },
				{ "persona.stance": 2, "persona.stubbornness": 0 },
				{ "persona.stance": -2, "persona.stubbornness": 0 },
				{ "persona.stance": 1, "persona.stubbornness": 0 },
			],
			rngFromSeed(1, [0]),
		);
		const [a, b, c, d] = ids as [EntityId, EntityId, EntityId, EntityId];
		const graph: GraphView = {
			edgeCount: 3,
			neighbors: (id) => (id === a ? [b, c, d] : id === b ? [a] : []),
			degree: (id) => (id === a ? 3 : id === b ? 1 : 0),
		};
		const transition = opinionDynamics({
			entity: "agent",
			rate: 0.5,
			stanceColumn: "persona.stance",
			stubbornnessColumn: "persona.stubbornness",
			postAction: "post",
		});
		const effects = transition.apply(
			world,
			ids,
			[
				decision(b, "post"),
				decision(d, "post"),
				decision(c, "silent"),
				decision(a, "silent"),
			],
			rngFromSeed(1, [1]),
			graph,
		);
		expect(effects).toHaveLength(1);
		const effect = effects[0];
		if (effect?.op !== "setColumn") throw new Error("expected setColumn");
		expect(effect.column).toBe("persona.stance");
		// a: posting neighbours b (2) and d (1) -> mean 1.5; 0 + 0.5 * (1 - 0.5) * 1.5 = 0.375
		// b: neighbour a did not post -> untouched; c, d: no neighbours
		expect(effect.ids).toEqual([a]);
		expect(effect.values).toEqual([0.375]);
		expect(
			transition.apply(world, ids, [decision(a, "silent")], rngFromSeed(1, [2]), graph),
		).toEqual([]);
		expect(transition.apply(world, ids, [decision(b, "post")], rngFromSeed(1, [2]))).toEqual(
			[],
		);
	});
});

describe("column statistics", () => {
	test("z-scores use the population mean and standard deviation", () => {
		const world = createWorld();
		const r = world.declare({
			entity: "agent",
			name: "x",
			dtype: "f64",
			default: 0,
			owner: "kernel",
			merge: "last",
		});
		if (!r.ok) throw new Error(r.error.message);
		world.create("agent", [{ x: 1 }, { x: 3 }, { x: 5 }], rngFromSeed(2, []));
		const stats = columnStats(world.column("agent", "x"));
		expect(stats.mean).toBe(3);
		expect(stats.sd).toBeCloseTo(Math.sqrt(8 / 3), 12);
		expect(zScore(3, stats)).toBe(0);
		expect(zScore(5, stats)).toBeCloseTo(2 / Math.sqrt(8 / 3), 12);
		expect(zScore(5, { mean: 5, sd: 0 })).toBe(0);
	});
});

describe("cohort executor in the kernel", () => {
	test("observes features, decides in bulk and writes one setColumn effect per tick", async () => {
		const sim = build(cohortScenario(60));
		await runTicks(sim, 3);
		const integrity = sim.integrity();
		expect(integrity.complete).toBe(true);
		expect(integrity.failed).toBe(0);
		expect(integrity.activated).toBeGreaterThan(0);
		const effects = sim.log.query({ kind: ["effect"] });
		expect(effects).toHaveLength(3);
		for (const e of effects) {
			if (e.kind !== "effect") continue;
			expect(e.payload.rejected).toEqual([]);
			expect(e.payload.effects.length).toBeLessThanOrEqual(1);
			for (const effect of e.payload.effects) expect(effect.op).toBe("setColumn");
		}
		expect(effects.some((e) => e.kind === "effect" && e.payload.effects.length === 1)).toBe(
			true,
		);
		const observations = sim.log.query({ kind: ["observation"] });
		expect(observations).toHaveLength(integrity.activated);
		const first = observations[0];
		if (first?.kind !== "observation") throw new Error("expected observation");
		const content = JSON.parse(sim.log.getContent(first.payload.contentSha) ?? "null") as {
			features: number[];
			neighborMean: number | null;
		};
		expect(content.features).toHaveLength(2);
		expect(typeof content.neighborMean).toBe("number");
		const decisions = sim.log.query({ kind: ["decision"] });
		expect(decisions).toHaveLength(integrity.activated);
		const actions = new Set(
			decisions.map((d) => (d.kind === "decision" ? d.payload.action : "")),
		);
		expect([...actions].sort()).toEqual(["post", "silent"]);
		expect(decisions.every((d) => d.kind === "decision" && d.payload.provider === "rule")).toBe(
			true,
		);
		expect(sim.measurements().meanStance).toBeDefined();
	});

	test("two runs with the same seed produce the same digest and a different seed does not", async () => {
		const a = build(cohortScenario(60));
		const b = build(cohortScenario(60));
		const c = build(cohortScenario(60, (s) => ({ ...s, seed: 8 })));
		await runTicks(a, 4);
		await runTicks(b, 4);
		await runTicks(c, 4);
		expect(a.log.digest()).toBe(b.log.digest());
		expect(a.log.digest()).not.toBe(c.log.digest());
		expect(a.world.hash()).toBe(b.world.hash());
	});

	test("decisions outside the virtual action space fall back to the executor's fallback action", async () => {
		const registry = builtinRegistry();
		const bogus: DecisionProvider = {
			name: "bogus",
			decide: async (requests) =>
				requests.map((req) =>
					ok(ruleDecision(req, req.features?.[0] === 0 ? "post" : "dance")),
				),
			reset: () => {},
			getState: () => null,
			setState: () => {},
		};
		registry.providers.register("bogus", () => ok(bogus));
		const sim = build(
			cohortScenario(20, (s) => ({ ...s, providers: { rule: { kind: "bogus" } } })),
			registry,
		);
		await runTicks(sim, 2);
		const integrity = sim.integrity();
		expect(integrity.complete).toBe(true);
		expect(integrity.failed).toBeGreaterThan(0);
		expect(integrity.parseFailures).toBe(integrity.failed);
		const decisions = sim.log.query({ kind: ["decision"] });
		expect(decisions.length).toBe(integrity.activated);
		expect(
			decisions.every(
				(d) => d.kind === "decision" && d.payload.action === "silent" && !d.payload.parseOk,
			),
		).toBe(true);
	});

	test("where restricts ownership and unowned activated agents are failures", async () => {
		const sim = build(
			cohortScenario(30, (s) => ({
				...s,
				executors: s.executors.map((e) => ({
					...e,
					options: { ...e.options, where: { ordinal: 3 } },
				})),
				policy: { kind: "allAgents" },
			})),
		);
		await runTicks(sim, 1);
		const integrity = sim.integrity();
		expect(integrity.activated).toBe(30);
		expect(integrity.ok).toBe(1);
		expect(integrity.failed).toBe(29);
		expect(integrity.complete).toBe(true);
	});

	test("missing feature columns are declare errors at assembly", () => {
		const registry = builtinRegistry();
		const created = createSimulation(
			cohortScenario(10, (s) => ({
				...s,
				executors: s.executors.map((e) => ({
					...e,
					options: { ...e.options, features: ["persona.absent"] },
				})),
			})),
			registry,
			{
				outDir: tempDir(),
				logger: silentLogger,
				log: createMemoryEventLog(),
				createGateway: gatewayFactory,
			},
		);
		expect(created.ok).toBe(false);
		if (!created.ok) {
			expect(created.error.excType).toBe("ExecutorDeclare");
			expect(created.error.message).toContain("persona.absent");
		}
	});

	test("the mock provider treats virtual actions as argument-free decisions", async () => {
		const sim = build(
			cohortScenario(40, (s) => ({ ...s, providers: { rule: { kind: "mock" } } })),
		);
		await runTicks(sim, 2);
		const integrity = sim.integrity();
		expect(integrity.complete).toBe(true);
		expect(integrity.failed).toBe(0);
		const actions = new Set(
			sim.log
				.query({ kind: ["decision"] })
				.map((d) => (d.kind === "decision" ? d.payload.action : "")),
		);
		expect([...actions].every((a) => a === "post" || a === "silent")).toBe(true);
	});

	test("cohortRule thresholds the first feature", async () => {
		const registry = builtinRegistry();
		const ctx = {
			scenario: cohortScenario(10),
			registry,
			logger: silentLogger,
		};
		const provider = registry.providers.create(
			{ kind: COHORT_RULE_KIND, options: { threshold: 0.5, above: "post", below: "silent" } },
			ctx,
		);
		expect(provider.ok).toBe(true);
		if (!provider.ok) return;
		const agent = toEntityId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		const request = (features: readonly number[] | undefined) => ({
			agentId: agent,
			t: { tick: 0, substep: 0, seq: 0 },
			state: {},
			observation: {},
			observationEvent: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FC0"),
			actionSpace: ["post", "silent"],
			...(features === undefined ? {} : { features }),
		});
		const results = await provider.value.decide(
			[request([1]), request([0.2]), request(undefined)],
			{
				t: { tick: 0, substep: 0, seq: 0 },
				runId: makeRunId("r", 0),
				seedPath: [0],
				world: createWorld(),
				log: createMemoryEventLog(),
			},
		);
		expect(results.map((r) => (r.ok ? r.value.action : r.error.excType))).toEqual([
			"post",
			"silent",
			"rule_threw",
		]);
		const state: JsonValue = provider.value.getState();
		expect(state).toEqual({ seedPath: [] });
	});
});
