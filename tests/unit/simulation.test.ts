import { describe, expect, test } from "bun:test";
import { loadCheckpoint, saveCheckpoint } from "../../src/core/checkpoint";
import { FAILURE_TYPES } from "../../src/core/failures";
import { toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import type { Executor } from "../../src/core/protocols";
import { ok } from "../../src/core/result";
import { IncompleteTick, createSimulation, type Simulation } from "../../src/core/simulation";
import type { EntityId, EventKind, JsonObject } from "../../src/core/types";
import { silentLogger } from "../../src/logging/logger";
import {
	gatewayFactory,
	kernelRegistry,
	kernelScenario,
	type KernelFixture,
} from "../helpers/kernel";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-sim-"));

const build = (
	fixture: KernelFixture = kernelRegistry(),
	overrides: JsonObject = {},
): Simulation => {
	const created = createSimulation(kernelScenario(overrides), fixture.registry, {
		outDir: tempDir(),
		logger: silentLogger,
		log: createMemoryEventLog(),
		createGateway: gatewayFactory,
	});
	if (!created.ok) throw new Error(`${created.error.excType}: ${created.error.message}`);
	return created.value;
};

const kinds = (sim: Simulation, tick: number): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const e of sim.log.query({ tick })) out[e.kind] = (out[e.kind] ?? 0) + 1;
	return out;
};

describe("createSimulation", () => {
	test("assembles population, modules, executors, providers, policy and instruments", () => {
		const sim = build();
		expect(sim.world.count("agent")).toBe(3);
		expect(
			sim.world
				.columns("agent")
				.map((c) => c.name)
				.sort(),
		).toEqual(["ordinal", "persona.mood", "persona.name", "score"].sort());
		expect(String(sim.runId)).toBe("kernel:0");
		expect(sim.clock.now).toEqual({ tick: 0, substep: 0, seq: 0 });
		expect(sim.log.count()).toBe(0);
	});

	test("reports instantiate failures as typed results", () => {
		const fixture = kernelRegistry();
		const unknownProvider = createSimulation(
			kernelScenario({ providers: { other: { kind: "scripted" } } }),
			fixture.registry,
			{
				outDir: tempDir(),
				logger: silentLogger,
				log: createMemoryEventLog(),
				createGateway: gatewayFactory,
			},
		);
		expect(unknownProvider.ok).toBe(false);
		if (!unknownProvider.ok) {
			expect(unknownProvider.error.stage).toBe("instantiate");
			expect(unknownProvider.error.excType).toBe("UnknownProvider");
		}
		const unknownModule = createSimulation(
			kernelScenario({ modules: [{ kind: "nope" }] }),
			fixture.registry,
			{
				outDir: tempDir(),
				logger: silentLogger,
				log: createMemoryEventLog(),
				createGateway: gatewayFactory,
			},
		);
		expect(unknownModule.ok && "").toBe(false);
		const badReads = createSimulation(
			kernelScenario({
				executors: [
					{
						kind: "focal",
						options: { provider: "main", components: [{ kind: "summaryMemory" }] },
					},
				],
			}),
			fixture.registry,
			{
				outDir: tempDir(),
				logger: silentLogger,
				log: createMemoryEventLog(),
				createGateway: gatewayFactory,
			},
		);
		expect(badReads.ok).toBe(false);
		if (!badReads.ok) expect(badReads.error.excType).toBe("ExecutorDeclare");
	});
});

describe("Simulation.step", () => {
	test("runs the full tick protocol and keeps integrity complete", async () => {
		const fixture = kernelRegistry();
		const sim = build(fixture);
		for (let i = 0; i < 3; i += 1) {
			const r = await sim.step();
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.value).toEqual({ tick: i, activated: 3, ok: 3, failed: 0 });
		}
		expect(kinds(sim, 0)).toEqual({
			activation: 1,
			observation: 3,
			decision: 3,
			effect: 1,
			module_step: 1,
			measurement: 2,
		});
		expect(kinds(sim, 1).measurement).toBe(1);
		expect(sim.clock.now).toEqual({ tick: 3, substep: 0, seq: 0 });
		expect(sim.world.env("ticker.tick")).toBe(2);
		expect(sim.world.column<number>("agent", "score").toArray()).toEqual([3, 3, 3]);
		expect(sim.measurements()).toEqual({ scoreSum: 9, scores: [3, 3, 3] });
		expect(fixture.ticker.steps).toBe(3);
		expect(sim.integrity()).toEqual({
			activated: 9,
			ok: 9,
			failed: 0,
			parseFailures: 0,
			llmCalls: 0,
			llmFailures: 0,
			droppedEffects: 0,
			complete: true,
		});
		const decision = sim.log.query({ kind: ["decision"], tick: 1 })[0];
		expect(decision?.parent).toBeDefined();
		const chain = sim.log.chain(decision?.eventId ?? toEventId(""));
		expect(chain.map((e) => e.kind)).toEqual(["observation", "decision"]);
		const effect = sim.log.query({ kind: ["effect"], tick: 1 })[0];
		if (effect?.kind === "effect") {
			expect(effect.payload.effects).toHaveLength(3);
			expect(effect.payload.effects.some((e) => e.cause === decision?.eventId)).toBe(true);
		}
		const observation = sim.log.query({ kind: ["observation"], tick: 2 })[0];
		if (observation?.kind === "observation") {
			const prompt = sim.log.getContent(observation.payload.contentSha) ?? "";
			expect(prompt).toContain("Play along.");
			expect(prompt).toContain("post-1");
			expect(prompt).toContain("bump");
		}
		expect(sim.log.query({ tick: 2 }).every((e) => e.seedPath[0] === 2)).toBe(true);
	});

	test("same seed gives the same digest, a different seed does not", async () => {
		const a = build();
		const b = build();
		const c = build(kernelRegistry(), { seed: 22 });
		for (let i = 0; i < 3; i += 1) {
			await a.step();
			await b.step();
			await c.step();
		}
		expect(a.log.digest()).toBe(b.log.digest());
		expect(a.world.hash()).toBe(b.world.hash());
		expect(a.log.digest()).not.toBe(c.log.digest());
	});

	test("an empty activation still steps modules and passes the completion assertion", async () => {
		const fixture = kernelRegistry();
		const sim = build(fixture, { policy: { kind: "explicit", options: { schedule: {} } } });
		const r = await sim.step();
		expect(r.ok).toBe(true);
		expect(kinds(sim, 0)).toEqual({ activation: 1, effect: 1, module_step: 1, measurement: 2 });
		expect(sim.integrity().complete).toBe(true);
		expect(sim.integrity().activated).toBe(0);
		expect(fixture.ticker.steps).toBe(1);
	});

	test("activation override with manual calls dispatches directly", async () => {
		const sim = build();
		const [first, second] = sim.world.ids("agent");
		const r = await sim.step({
			agents: { [first as EntityId]: "manual", [second as EntityId]: "llm" },
			manualCalls: {
				[first as EntityId]: {
					agentId: first as EntityId,
					name: "bump",
					args: { amount: 5 },
					cause: toEventId("00000000000000000000000000"),
				},
			},
		});
		expect(r.ok).toBe(true);
		expect(sim.world.column<number>("agent", "score").get(first as EntityId)).toBe(5);
		expect(sim.world.column<number>("agent", "score").get(second as EntityId)).toBe(1);
		const manual = sim.log.query({ kind: ["decision"], agentId: first as EntityId });
		expect(manual).toHaveLength(1);
		if (manual[0]?.kind === "decision") {
			expect(manual[0].payload.provider).toBe("manual");
			expect(manual[0].provenance).toBe("manual");
		}
		expect(sim.integrity()).toMatchObject({ activated: 2, ok: 2, failed: 0, complete: true });
	});

	test("rejected effects become failure events and droppedEffects", async () => {
		const fixture = kernelRegistry();
		fixture.registry.providers.register("bogus", () =>
			ok({
				name: "bogus",
				decide: async (requests) =>
					requests.map((r) =>
						ok({
							agentId: r.agentId,
							action: "bogus",
							args: {},
							provenance: "rule" as const,
							cost: {
								llmCalls: 0,
								promptTokens: 0,
								completionTokens: 0,
								cachedTokens: 0,
								wallMs: 0,
							},
							parseOk: true,
						}),
					),
				reset: () => {},
				getState: () => null,
				setState: () => {},
			}),
		);
		const sim = build(fixture, { providers: { main: { kind: "bogus" } } });
		const r = await sim.step();
		expect(r.ok).toBe(true);
		const failures = sim.log.query({ kind: ["failure"] });
		expect(failures).toHaveLength(3);
		if (failures[0]?.kind === "failure")
			expect(failures[0].payload.excType).toBe(FAILURE_TYPES.effectRejected);
		expect(sim.integrity()).toMatchObject({
			ok: 3,
			failed: 0,
			droppedEffects: 3,
			complete: true,
		});
	});

	test("an executor that silently drops an agent trips IncompleteTick", async () => {
		const fixture = kernelRegistry();
		fixture.registry.executors.register("silent", (spec, ctx) => {
			const inner = fixture.registry.executors.create({ ...spec, kind: "focal" }, ctx);
			if (!inner.ok) return inner;
			const wrapped: Executor = {
				...inner.value,
				name: inner.value.name,
				entity: inner.value.entity,
				provider: inner.value.provider,
				declare: (w) => inner.value.declare(w),
				observe: async (world, ids, t, log, rng, obs) =>
					inner.value.observe(world, ids.slice(1), t, log, rng, obs),
				act: (d, c) => inner.value.act(d, c),
				after: (d, r, l) => inner.value.after(d, r, l),
				getState: () => inner.value.getState(),
				setState: (s) => inner.value.setState(s),
			};
			return ok(wrapped);
		});
		const sim = build(fixture, {
			executors: [
				{ kind: "silent", name: "people", options: { provider: "main", components: [] } },
			],
		});
		await expect(sim.step()).rejects.toBeInstanceOf(IncompleteTick);
		expect(sim.integrity().complete).toBe(false);
		expect(sim.log.query({ tick: 0 }).length).toBeGreaterThan(0);
	});

	test("module failures are recorded, skipped, and fail the run after three in a row", async () => {
		const fixture = kernelRegistry();
		fixture.ticker.failUntil = 2;
		const sim = build(fixture);
		const first = await sim.step();
		expect(first.ok).toBe(true);
		expect(kinds(sim, 0).module_step).toBeUndefined();
		const moduleFailures = sim.log.query({ kind: ["failure"], tick: 0 });
		expect(moduleFailures).toHaveLength(1);
		if (moduleFailures[0]?.kind === "failure")
			expect(moduleFailures[0].payload.excType).toBe(FAILURE_TYPES.moduleStepFailed);
		expect(sim.world.env("ticker.tick")).toBeUndefined();
		expect((await sim.step()).ok).toBe(true);
		expect((await sim.step()).ok).toBe(true);
		expect(sim.world.env("ticker.tick")).toBe(2);

		const always = kernelRegistry();
		always.ticker.failAlways = true;
		const doomed = build(always);
		expect((await doomed.step()).ok).toBe(true);
		expect((await doomed.step()).ok).toBe(true);
		const third = await doomed.step();
		expect(third.ok).toBe(false);
		if (!third.ok) expect(third.error.excType).toBe(FAILURE_TYPES.consecutiveModuleFailures);
		expect(doomed.integrity().complete).toBe(true);
	});

	test("checkpoint input round-trips through save and load at a tick boundary", async () => {
		const sim = build();
		await sim.step();
		await sim.step();
		const dir = tempDir();
		const saved = saveCheckpoint(sim.checkpointInput(), dir);
		expect(saved.ok).toBe(true);
		const loaded = loadCheckpoint(dir, sim.scenarioHash);
		expect(loaded.ok).toBe(true);
		if (loaded.ok) {
			expect(loaded.value.world.hash()).toBe(sim.world.hash());
			expect(loaded.value.clock.now).toEqual({ tick: 2, substep: 0, seq: 0 });
			expect(Object.keys(loaded.value.executors)).toEqual(["people"]);
			expect(Object.keys(loaded.value.providers)).toEqual(["main"]);
			expect(loaded.value.modules).toEqual({ ticker: { steps: 2 } });
			expect(loaded.value.digest).toBe(sim.log.digest());
		}
	});

	test("events written at tick boundaries use the boundary seed path", async () => {
		const sim = build();
		const e = sim.emit({
			kind: "checkpoint",
			payload: { path: "x", worldHash: sim.world.hash() },
		});
		expect(e.t).toEqual({ tick: 0, substep: 0, seq: 1 });
		expect(e.seedPath.length).toBe(1);
		await sim.step();
		const kindsSeen: EventKind[] = sim.log.query({ tick: 0 }).map((x) => x.kind);
		expect(kindsSeen[0]).toBe("checkpoint");
		expect(kindsSeen[1]).toBe("activation");
	});
});
