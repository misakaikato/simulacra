import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COHORT_RULE_KIND } from "../../src/providers";
import { columnStats, zScore } from "../../src/agents/cohort";
import { opinionDynamics } from "../../src/agents/transitions";
import { FAILURE_TYPES } from "../../src/core/failures";
import { makeRunId, toEntityId, toEventId } from "../../src/core/ids";
import { inspectEvents, renderInspect } from "../../src/core/inspect";
import { createMemoryEventLog, openSqliteEventLog } from "../../src/core/log";
import type { DecisionProvider, EventLog, GraphView } from "../../src/core/protocols";
import { err, ok } from "../../src/core/result";
import { rngFromSeed } from "../../src/core/rng";
import { overrideScenario, parseScenarioYaml } from "../../src/core/scenario";
import { createSimulation, type Simulation } from "../../src/core/simulation";
import type { Decision, EntityId, EventOf, JsonValue, Scenario } from "../../src/core/types";
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

const build = (
	scenario: Scenario,
	registry = builtinRegistry(),
	log: EventLog = createMemoryEventLog(),
): Simulation => {
	const created = createSimulation(scenario, registry, {
		outDir: tempDir(),
		logger: silentLogger,
		log,
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

const observationBatches = (sim: Simulation): readonly EventOf<"observation_batch">[] =>
	sim.log
		.query({ kind: ["observation_batch"] })
		.filter((e): e is EventOf<"observation_batch"> => e.kind === "observation_batch");

const decisionBatches = (sim: Simulation): readonly EventOf<"decision_batch">[] =>
	sim.log
		.query({ kind: ["decision_batch"] })
		.filter((e): e is EventOf<"decision_batch"> => e.kind === "decision_batch");

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

const kindCounts = (sim: Simulation, tick: number): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const e of sim.log.query({ tick })) out[e.kind] = (out[e.kind] ?? 0) + 1;
	return out;
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
		expect(sim.log.query({ kind: ["observation", "decision"] })).toEqual([]);
		const observations = observationBatches(sim);
		const decisions = decisionBatches(sim);
		expect(observations).toHaveLength(3);
		expect(decisions).toHaveLength(3);
		expect(sum(observations.map((e) => e.payload.count))).toBe(integrity.activated);
		for (const [i, observation] of observations.entries()) {
			const activation = sim.log.query({ kind: ["activation"], tick: i })[0];
			expect(observation.agentId).toBeUndefined();
			expect(observation.parent).toBe(activation?.eventId);
			expect(observation.payload.executor).toBe("crowd");
			expect(observation.payload.count).toBe(observation.payload.agentIds.length);
			expect(observation.payload.featuresSha).toBeUndefined();
			const decision = decisions[i];
			expect(decision?.parent).toBe(observation.eventId);
			expect(decision?.agentId).toBeUndefined();
			expect(decision?.payload.agentIds).toEqual(observation.payload.agentIds);
			expect(decision?.payload.actions).toHaveLength(observation.payload.count);
			expect(decision?.payload).toMatchObject({
				executor: "crowd",
				provider: "rule",
				provenance: "rule",
				parseFailures: 0,
				cost: ZERO_COST,
			});
			expect(decision?.provenance).toBe("rule");
		}
		const actions = new Set(decisions.flatMap((d) => d.payload.actions));
		expect([...actions].sort()).toEqual(["post", "silent"]);
		expect(sim.measurements().meanStance).toBeDefined();
	});

	test("every tick of a 100-agent cohort has exactly one observation batch and one decision batch", async () => {
		const sim = build(cohortScenario(100));
		await runTicks(sim, 3);
		for (const tick of [0, 1, 2])
			expect(kindCounts(sim, tick)).toMatchObject({
				activation: 1,
				observation_batch: 1,
				decision_batch: 1,
				effect: 1,
			});
		expect(sim.log.query({ kind: ["observation", "decision", "failure"] })).toEqual([]);
		const integrity = sim.integrity();
		expect(integrity.complete).toBe(true);
		expect(integrity.failed).toBe(0);
		expect(integrity.activated).toBe(sum(observationBatches(sim).map((e) => e.payload.count)));
		expect(integrity.ok).toBe(sum(decisionBatches(sim).map((e) => e.payload.agentIds.length)));
		const effects = sim.log.query({ kind: ["effect"] });
		for (const [i, e] of effects.entries()) {
			if (e.kind !== "effect") continue;
			const batch = decisionBatches(sim)[i];
			for (const effect of e.payload.effects) expect(batch?.eventId).toBe(effect.cause);
		}
	});

	test("recordFeatures stores the feature matrix and names it from the observation batch", async () => {
		const sim = build(
			cohortScenario(30, (s) => ({
				...s,
				executors: s.executors.map((e) => ({
					...e,
					options: { ...e.options, recordFeatures: true },
				})),
			})),
		);
		await runTicks(sim, 1);
		const [observation] = observationBatches(sim);
		expect(observation?.payload.featuresSha).toBeDefined();
		const matrix = JSON.parse(
			sim.log.getContent(observation?.payload.featuresSha ?? "") ?? "null",
		) as number[][];
		expect(matrix).toHaveLength(observation?.payload.count ?? -1);
		for (const row of matrix) expect(row).toHaveLength(2);
	});

	test("provider errors become one failure per agent while the batch keeps the fallback action", async () => {
		const registry = builtinRegistry();
		const flaky: DecisionProvider = {
			name: "flaky",
			decide: async (requests) =>
				requests.map((req, i) =>
					i % 3 === 0
						? err({
								agentId: req.agentId,
								reason: "unparseable",
								retryable: false,
								excType: FAILURE_TYPES.parseFailure,
							})
						: ok(ruleDecision(req, "post")),
				),
			reset: () => {},
			getState: () => null,
			setState: () => {},
		};
		registry.providers.register("flaky", () => ok(flaky));
		const sim = build(
			cohortScenario(100, (s) => ({ ...s, providers: { rule: { kind: "flaky" } } })),
			registry,
		);
		await runTicks(sim, 2);
		const integrity = sim.integrity();
		expect(integrity.complete).toBe(true);
		expect(integrity.failed).toBeGreaterThan(0);
		expect(integrity.parseFailures).toBe(integrity.failed);
		const failures = sim.log.query({ kind: ["failure"] });
		expect(failures).toHaveLength(integrity.failed);
		const batches = decisionBatches(sim);
		expect(batches).toHaveLength(2);
		expect(sum(batches.map((b) => b.payload.agentIds.length))).toBe(
			integrity.ok + integrity.failed,
		);
		expect(sum(batches.map((b) => b.payload.parseFailures))).toBe(integrity.parseFailures);
		expect(sim.log.query({ kind: ["decision"] })).toEqual([]);
		for (const failure of failures) {
			if (failure.kind !== "failure") continue;
			expect(failure.agentId).toBeDefined();
			expect(failure.payload).toMatchObject({
				stage: "decide",
				excType: FAILURE_TYPES.parseFailure,
			});
			const batch = batches.find((b) => b.t.tick === failure.t.tick);
			expect(failure.parent).toBe(batch?.parent);
			const i = batch?.payload.agentIds.indexOf(failure.agentId ?? toEntityId("")) ?? -1;
			expect(i).toBeGreaterThanOrEqual(0);
			expect(batch?.payload.actions[i]).toBe("silent");
		}
		const posts = batches.flatMap((b) => b.payload.actions.filter((a) => a === "post"));
		expect(posts).toHaveLength(integrity.ok);
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
		const batches = decisionBatches(sim);
		expect(sum(batches.map((b) => b.payload.agentIds.length))).toBe(integrity.activated);
		expect(sum(batches.map((b) => b.payload.parseFailures))).toBe(integrity.parseFailures);
		expect(batches.flatMap((b) => b.payload.actions).every((a) => a === "silent")).toBe(true);
		const failures = sim.log.query({ kind: ["failure"] });
		expect(failures).toHaveLength(integrity.failed);
		expect(
			failures.every(
				(f) => f.kind === "failure" && f.payload.excType === FAILURE_TYPES.invalidAction,
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
		const actions = decisionBatches(sim).flatMap((b) => b.payload.actions);
		expect(actions).toHaveLength(integrity.activated);
		expect(actions.every((a) => a === "post" || a === "silent")).toBe(true);
	});

	test("inspect resolves a cohort agent to the batch events that list it", async () => {
		for (const log of [createMemoryEventLog(), openSqliteEventLog(":memory:")]) {
			const sim = build(
				cohortScenario(40, (s) => ({ ...s, policy: { kind: "allAgents" } })),
				builtinRegistry(),
				log,
			);
			await runTicks(sim, 2);
			const [agentId] = sim.world.ids("agent");
			if (agentId === undefined) throw new Error("no agents");
			const latest = inspectEvents(sim.log, { agentId });
			expect(latest.ok).toBe(true);
			if (!latest.ok) continue;
			expect(latest.value.tick).toBe(1);
			expect(latest.value.observation).toBeUndefined();
			expect(latest.value.decision).toBeUndefined();
			expect(latest.value.observationBatch?.payload.agentIds).toContain(agentId);
			expect(latest.value.decisionBatch?.payload.agentIds).toContain(agentId);
			expect(latest.value.chain.map((e) => e.kind)).toEqual([
				"activation",
				"observation_batch",
				"decision_batch",
			]);
			expect(latest.value.failures).toEqual([]);
			for (const effect of latest.value.effects) {
				expect(effect.op).toBe("setColumn");
				expect(latest.value.decisionBatch?.eventId).toBe(effect.cause);
				if (effect.op === "setColumn") expect(effect.ids).toContain(agentId);
			}
			const lines = renderInspect(latest.value);
			expect(lines.some((l) => l.includes("batch action="))).toBe(true);
			expect(lines.some((l) => l.includes("batch executor=crowd agents=40"))).toBe(true);
			const first = inspectEvents(sim.log, { agentId, tick: 0 });
			expect(first.ok && first.value.tick).toBe(0);
			expect(first.ok && first.value.decisionBatch?.t.tick).toBe(0);
			expect(sim.log.batchesOf(agentId, { kind: ["decision_batch"] })).toHaveLength(2);
			const nobody = inspectEvents(sim.log, { agentId: toEntityId("nobody") });
			expect(nobody.ok).toBe(false);
			sim.close();
		}
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
