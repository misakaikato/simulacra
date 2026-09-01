import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toEntityId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import type { DecisionProvider } from "../../src/core/protocols";
import { ok } from "../../src/core/result";
import { createSimulation, type Simulation } from "../../src/core/simulation";
import type { DecisionRequest, JsonObject } from "../../src/core/types";
import { silentLogger } from "../../src/logging/logger";
import { createMockProvider } from "../../src/providers/mock";
import {
	aggregateObservations,
	majorityVote,
	publicPersonaOf,
} from "../../src/providers/archetype";
import { ruleDecision } from "../../src/providers/rule";
import {
	gatewayFactory,
	kernelRegistry,
	kernelScenario,
	type KernelFixture,
} from "../helpers/kernel";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-archetype-"));

interface Counter {
	requests: number;
	batches: number;
	seen: DecisionRequest[];
}

// A downstream that counts what it receives and otherwise behaves like the mock provider.
const countingProvider = (fixture: KernelFixture, counter: Counter): DecisionProvider => {
	const mock = createMockProvider(fixture.registry.actions, "counter");
	return {
		name: "counter",
		decide: async (requests, ctx) => {
			counter.requests += requests.length;
			counter.batches += 1;
			counter.seen.push(...requests);
			return mock.decide(requests, ctx);
		},
		reset: () => {},
		getState: () => null,
		setState: () => {},
	};
};

const population = (n: number): JsonObject => ({
	n,
	fields: [
		{
			name: "group",
			dtype: "str",
			sampling: { kind: "choice", choices: ["a", "b", "c", "d"] },
		},
		{ name: "mood", dtype: "f64", sampling: { kind: "range", min: 0, max: 1 } },
		{ name: "secret", dtype: "str", private: true, sampling: { kind: "value", value: "s" } },
	],
});

const build = (
	n: number,
	nArch: number,
	providers: JsonObject = {
		arch: {
			kind: "archetype",
			options: { downstream: "counter", groupOn: ["persona.group"], nArch },
		},
		counter: { kind: "counting" },
	},
): { readonly sim: Simulation; readonly counter: Counter } => {
	const fixture = kernelRegistry();
	const counter: Counter = { requests: 0, batches: 0, seen: [] };
	fixture.registry.providers.register("counting", () => ok(countingProvider(fixture, counter)));
	const scenario = kernelScenario({
		population: population(n),
		executors: [
			{
				kind: "focal",
				name: "people",
				options: { provider: "arch", components: [{ kind: "persona" }] },
			},
		],
		providers,
		steps: [{ kind: "run", ticks: 1 }],
	});
	const created = createSimulation(scenario, fixture.registry, {
		outDir: tempDir(),
		logger: silentLogger,
		log: createMemoryEventLog(),
		createGateway: gatewayFactory,
	});
	if (!created.ok) throw new Error(`${created.error.excType}: ${created.error.message}`);
	return { sim: created.value, counter };
};

describe("archetype provider", () => {
	test("downstream calls equal groups times nArch and do not grow with N", async () => {
		const small = build(100, 2);
		const large = build(10000, 2);
		const rs = await small.sim.step();
		const rl = await large.sim.step();
		expect(rs.ok && rl.ok).toBe(true);
		expect(small.sim.integrity().complete).toBe(true);
		expect(large.sim.integrity().complete).toBe(true);
		expect(small.sim.integrity().ok).toBe(100);
		expect(large.sim.integrity().ok).toBe(10000);
		expect(small.counter.requests).toBe(4 * 2);
		expect(large.counter.requests).toBe(4 * 2);
		expect(small.counter.batches).toBe(2);
		const decisions = large.sim.log.query({ kind: ["decision"] });
		expect(decisions).toHaveLength(10000);
		expect(decisions.every((d) => d.provenance === "prototype")).toBe(true);
		const representative = large.counter.seen[0];
		expect(representative?.state.groupSize).toBeGreaterThan(0);
		expect(representative?.state["persona.group"]).toBeDefined();
		expect(representative?.state["persona.secret"]).toBeUndefined();
		expect(representative?.observation.groupSize).toBe(representative?.state.groupSize);
		const prototypes = large.sim.log
			.query({ kind: ["observation"] })
			.filter((e) => e.provenance === "prototype");
		expect(prototypes).toHaveLength(8);
		expect(prototypes.every((e) => e.agentId === undefined && e.parent !== undefined)).toBe(
			true,
		);
	});

	test("members of a group share the majority action and soft frequencies", async () => {
		const { sim } = build(200, 3);
		const r = await sim.step();
		expect(r.ok).toBe(true);
		const byGroup = new Map<string, Set<string>>();
		for (const d of sim.log.query({ kind: ["decision"] })) {
			if (d.kind !== "decision" || d.agentId === undefined) continue;
			const group = String(sim.world.row("agent", d.agentId)?.["persona.group"]);
			const actions = byGroup.get(group) ?? new Set<string>();
			actions.add(d.payload.action);
			byGroup.set(group, actions);
			const soft = d.payload.soft ?? {};
			const total = Object.values(soft).reduce((a, b) => a + b, 0);
			expect(total).toBeCloseTo(1, 12);
			expect(soft[d.payload.action]).toBeGreaterThanOrEqual(1 / 3);
		}
		for (const actions of byGroup.values()) expect(actions.size).toBe(1);
	});

	test("assembly rejects unknown persona columns, unknown downstreams and cycles", () => {
		const fixture = kernelRegistry();
		const attempt = (providers: JsonObject) =>
			createSimulation(
				kernelScenario({
					population: population(5),
					executors: [{ kind: "focal", name: "people", options: { provider: "arch" } }],
					providers,
				}),
				fixture.registry,
				{
					outDir: tempDir(),
					logger: silentLogger,
					log: createMemoryEventLog(),
					createGateway: gatewayFactory,
				},
			);
		const unknownColumn = attempt({
			arch: {
				kind: "archetype",
				options: { downstream: "main", groupOn: ["persona.nope"] },
			},
			main: { kind: "mock" },
		});
		expect(unknownColumn.ok).toBe(false);
		if (!unknownColumn.ok) {
			expect(unknownColumn.error.excType).toBe("ProviderCreate");
			expect(unknownColumn.error.message).toContain("persona.nope");
		}
		const unknownDownstream = attempt({
			arch: {
				kind: "archetype",
				options: { downstream: "ghost", groupOn: ["persona.group"] },
			},
		});
		expect(unknownDownstream.ok).toBe(false);
		if (!unknownDownstream.ok) expect(unknownDownstream.error.message).toContain("ghost");
		const cycle = attempt({
			arch: {
				kind: "archetype",
				options: { downstream: "cached", groupOn: ["persona.group"] },
			},
			cached: { kind: "cache", options: { downstream: "arch" } },
		});
		expect(cycle.ok).toBe(false);
		if (!cycle.ok) {
			expect(cycle.error.excType).toBe("ProviderCreate");
			expect(cycle.error.message).toContain("arch -> cached -> arch");
		}
	});

	test("requests without the groupOn columns fail typed", async () => {
		const fixture = kernelRegistry();
		const counter: Counter = { requests: 0, batches: 0, seen: [] };
		fixture.registry.providers.register("counting", () =>
			ok(countingProvider(fixture, counter)),
		);
		const scenario = kernelScenario({ population: population(4) });
		const created = createSimulation(scenario, fixture.registry, {
			outDir: tempDir(),
			logger: silentLogger,
			log: createMemoryEventLog(),
			createGateway: gatewayFactory,
		});
		if (!created.ok) throw new Error(created.error.message);
		const registry = fixture.registry;
		const ctx = {
			scenario,
			registry,
			logger: silentLogger,
			provider: () => ok(countingProvider(fixture, counter)),
		};
		const arch = registry.providers.create(
			{
				kind: "archetype",
				name: "arch",
				options: { downstream: "x", groupOn: ["persona.group"] },
			},
			ctx,
		);
		expect(arch.ok).toBe(true);
		if (!arch.ok) return;
		const req: DecisionRequest = {
			agentId: created.value.world.ids("agent")[0] ?? toEntityId("missing"),
			t: { tick: 0, substep: 0, seq: 0 },
			state: {},
			observation: {},
			observationEvent: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FC0"),
			actionSpace: ["noop"],
		};
		const [result] = await arch.value.decide([req], {
			t: req.t,
			runId: created.value.runId,
			seedPath: [0],
			world: created.value.world,
			log: created.value.log,
		});
		expect(result?.ok).toBe(false);
		if (result !== undefined && !result.ok) expect(result.error.excType).toBe("missing_column");
		expect(counter.requests).toBe(0);
	});
});

describe("archetype helpers", () => {
	test("majority vote breaks ties by action name and reports agreement", () => {
		const d = (action: string) =>
			ruleDecision(
				{
					agentId: toEntityId("a"),
					t: { tick: 0, substep: 0, seq: 0 },
					state: {},
					observation: {},
					observationEvent: toEventId("e"),
					actionSpace: [action],
				},
				action,
			);
		const vote = majorityVote([d("post"), d("like"), d("like"), d("post")]);
		expect(vote?.action).toBe("like");
		expect(vote?.agreement).toBe(0.5);
		expect(vote?.soft).toEqual({ like: 0.5, post: 0.5 });
		expect(majorityVote([])).toBeUndefined();
	});

	test("observations aggregate numbers by mean and booleans by majority", () => {
		expect(
			aggregateObservations([
				{ x: 1, flag: true, tag: "a", list: [1] },
				{ x: 3, flag: false, tag: "b", list: [2] },
				{ x: 5, flag: true, tag: "c", list: [3] },
			]),
		).toEqual({ x: 3, flag: true, tag: "a", list: [1] });
		expect(aggregateObservations([])).toEqual({});
	});

	test("public persona drops private fields and non-persona columns", () => {
		expect(
			publicPersonaOf(
				{ "persona.a": 1, "persona.secret": "x", ordinal: 3, "mood.level": 2 },
				new Set(["persona.secret"]),
			),
		).toEqual({ "persona.a": 1 });
	});
});
