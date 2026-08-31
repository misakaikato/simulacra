import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_TYPES } from "../../src/core/failures";
import { createMemoryEventLog } from "../../src/core/log";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";
import { RESULT_FILE, runScenario } from "../../src/core/run";
import { createSimulation, type Simulation } from "../../src/core/simulation";
import { silentLogger } from "../../src/logging/logger";
import {
	gatewayFactory,
	kernelRegistry,
	kernelScenario,
	type KernelFixture,
} from "../helpers/kernel";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-fail-"));

const build = (fixture: KernelFixture): Simulation => {
	const created = createSimulation(kernelScenario(), fixture.registry, {
		outDir: tempDir(),
		logger: silentLogger,
		log: createMemoryEventLog(),
		createGateway: gatewayFactory,
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
};

const failureTypes = (sim: Simulation, tick?: number): readonly string[] =>
	sim.log
		.query({ kind: ["failure"], ...(tick === undefined ? {} : { tick }) })
		.map((e) => (e.kind === "failure" ? e.payload.excType : ""));

describe("failure paths", () => {
	test("a single agent provider error falls back, records a failure and keeps the run succeeded", async () => {
		const out = tempDir();
		const fixture = kernelRegistry();
		fixture.behaviour = { kind: "failIndex", index: 1 };
		const r = await runScenario(
			kernelScenario({ steps: [{ kind: "run", ticks: 1 }] }),
			fixture.registry,
			out,
			{ createGateway: gatewayFactory },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.status).toBe("succeeded");
		expect(r.value.integrity).toMatchObject({
			activated: 3,
			ok: 2,
			failed: 1,
			parseFailures: 1,
			complete: true,
		});
		const log = openSqliteEventLog(eventLogPath(out));
		const failures = log.query({ kind: ["failure"] });
		expect(failures).toHaveLength(1);
		const failure = failures[0];
		if (failure?.kind === "failure") {
			expect(failure.payload.excType).toBe(FAILURE_TYPES.parseFailure);
			expect(failure.payload.retryable).toBe(false);
			expect(failure.payload.stage).toBe("decide");
		}
		const decisions = log.query({ kind: ["decision"], agentId: failure!.agentId! });
		expect(decisions).toHaveLength(1);
		if (decisions[0]?.kind === "decision") {
			expect(decisions[0].payload.action).toBe("noop");
			expect(decisions[0].payload.parseOk).toBe(false);
		}
		expect(failure?.parent).toBeDefined();
		expect(log.chain(failure!.eventId).map((e) => e.kind)).toEqual(["observation", "failure"]);
		expect(log.query({ kind: ["decision"] })).toHaveLength(3);
		log.close();
		expect(r.value.metrics.scoreSum).toBe(2);
	});

	test("three consecutive whole-batch failures fail the run but keep integrity complete", async () => {
		const out = tempDir();
		const fixture = kernelRegistry();
		fixture.behaviour = { kind: "throw" };
		const r = await runScenario(
			kernelScenario({ steps: [{ kind: "run", ticks: 5 }] }),
			fixture.registry,
			out,
			{ createGateway: gatewayFactory },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.status).toBe("failed");
		expect(r.value.failure?.excType).toBe(FAILURE_TYPES.consecutiveBatchFailures);
		expect(r.value.failure?.at?.tick).toBe(2);
		expect(r.value.integrity).toMatchObject({ activated: 9, ok: 0, failed: 9, complete: true });
		expect(existsSync(join(out, RESULT_FILE))).toBe(true);
		const log = openSqliteEventLog(eventLogPath(out));
		expect(log.query({ kind: ["activation"] })).toHaveLength(3);
		const batchFailures = log
			.query({ kind: ["failure"] })
			.filter(
				(e) => e.kind === "failure" && e.payload.excType === FAILURE_TYPES.providerThrew,
			);
		expect(batchFailures).toHaveLength(3);
		expect(
			log
				.query({ kind: ["decision"] })
				.every((d) => d.kind === "decision" && d.payload.action === "noop"),
		).toBe(true);
		log.close();
	});

	test("a batch where every agent fails counts as a batch failure, a partial recovery resets the streak", async () => {
		const fixture = kernelRegistry();
		const sim = build(fixture);
		fixture.behaviour = { kind: "allErr" };
		expect((await sim.step()).ok).toBe(true);
		expect((await sim.step()).ok).toBe(true);
		fixture.behaviour = { kind: "failIndex", index: 0 };
		expect((await sim.step()).ok).toBe(true);
		fixture.behaviour = { kind: "allErr" };
		expect((await sim.step()).ok).toBe(true);
		expect((await sim.step()).ok).toBe(true);
		const third = await sim.step();
		expect(third.ok).toBe(false);
		expect(failureTypes(sim, 0)).toEqual([
			FAILURE_TYPES.network,
			FAILURE_TYPES.network,
			FAILURE_TYPES.network,
		]);
		expect(sim.integrity()).toMatchObject({
			activated: 18,
			ok: 2,
			failed: 16,
			parseFailures: 1,
			complete: true,
		});
	});

	test("a provider returning the wrong number of results triggers a contract violation and full fallback", async () => {
		const fixture = kernelRegistry();
		const sim = build(fixture);
		fixture.behaviour = { kind: "short" };
		const r = await sim.step();
		expect(r.ok).toBe(true);
		const types = failureTypes(sim, 0);
		expect(types).toEqual([FAILURE_TYPES.providerContractViolation]);
		const decisions = sim.log.query({ kind: ["decision"], tick: 0 });
		expect(decisions).toHaveLength(3);
		expect(
			decisions.every(
				(d) => d.kind === "decision" && d.payload.action === "noop" && !d.payload.parseOk,
			),
		).toBe(true);
		expect(sim.integrity()).toMatchObject({ activated: 3, ok: 0, failed: 3, complete: true });

		fixture.behaviour = { kind: "wrongAgent" };
		expect((await sim.step()).ok).toBe(true);
		expect(failureTypes(sim, 1)).toEqual(
			Array(3).fill(FAILURE_TYPES.providerContractViolation),
		);
		expect(sim.integrity()).toMatchObject({ activated: 6, ok: 0, failed: 6, complete: true });
	});

	test("invalid args from a provider are validation failures with fallback", async () => {
		const fixture = kernelRegistry();
		fixture.registry.providers.register("badArgs", () => ({
			ok: true,
			value: {
				name: "badArgs",
				decide: async (requests) =>
					requests.map((r) => ({
						ok: true as const,
						value: {
							agentId: r.agentId,
							action: "bump",
							args: { amount: "lots" },
							provenance: "rule" as const,
							cost: {
								llmCalls: 0,
								promptTokens: 0,
								completionTokens: 0,
								cachedTokens: 0,
								wallMs: 0,
							},
							parseOk: true,
						},
					})),
				reset: () => {},
				getState: () => null,
				setState: () => {},
			},
		}));
		const created = createSimulation(
			kernelScenario({ providers: { main: { kind: "badArgs" } } }),
			fixture.registry,
			{
				outDir: tempDir(),
				logger: silentLogger,
				log: createMemoryEventLog(),
				createGateway: gatewayFactory,
			},
		);
		if (!created.ok) throw new Error(created.error.message);
		const sim = created.value;
		expect((await sim.step()).ok).toBe(true);
		expect(failureTypes(sim, 0)).toEqual(Array(3).fill(FAILURE_TYPES.invalidArgs));
		expect(sim.integrity()).toMatchObject({
			ok: 0,
			failed: 3,
			parseFailures: 3,
			complete: true,
		});
		expect(sim.world.column<number>("agent", "score").toArray()).toEqual([0, 0, 0]);
	});
});
