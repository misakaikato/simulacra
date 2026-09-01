import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryEventLog } from "../../src/core/log";
import { ok } from "../../src/core/result";
import { createSimulation, type Simulation } from "../../src/core/simulation";
import type { JsonObject } from "../../src/core/types";
import { silentLogger } from "../../src/logging/logger";
import { createRuleProvider, ruleDecision } from "../../src/providers/rule";
import {
	gatewayFactory,
	kernelRegistry,
	kernelScenario,
	type KernelFixture,
} from "../helpers/kernel";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-intervene-"));

// A rule that reads the live scenario params on every decision.
const registerParamRule = (fixture: KernelFixture): void => {
	fixture.registry.providers.register("paramRule", (spec, ctx) =>
		ok(
			createRuleProvider({
				name: spec.name ?? "paramRule",
				seed: ctx.scenario.seed,
				rule: (req) => {
					const amount = ctx.scenario.params.amount;
					return (
						ruleDecision(req, "bump") && {
							...ruleDecision(req, "bump"),
							args: { amount: typeof amount === "number" ? amount : 1 },
						}
					);
				},
			}),
		),
	);
};

const hypothesis = (arms: readonly JsonObject[]): JsonObject => ({
	id: "h1",
	claim: "larger bumps raise the score",
	claimType: "mechanism",
	arms,
	outcomes: [{ name: "score", metric: "scoreSum", direction: "increase" }],
});

const build = (overrides: JsonObject, fixture: KernelFixture = kernelRegistry()): Simulation => {
	const created = createSimulation(kernelScenario(overrides), fixture.registry, {
		outDir: tempDir(),
		logger: silentLogger,
		log: createMemoryEventLog(),
		createGateway: gatewayFactory,
	});
	if (!created.ok) throw new Error(`${created.error.excType}: ${created.error.message}`);
	return created.value;
};

const failures = (sim: Simulation): readonly string[] =>
	sim.log
		.query({ kind: ["failure"] })
		.map((e) => (e.kind === "failure" ? e.payload.excType : ""));

const bumpArgs = (sim: Simulation, tick: number): readonly number[] =>
	sim.log
		.query({ kind: ["decision"], tick })
		.map((e) =>
			e.kind === "decision" && typeof e.payload.args === "object" && e.payload.args !== null
				? Number((e.payload.args as { amount?: number }).amount)
				: NaN,
		);

describe("intervene step", () => {
	test("params overrides are visible to providers on later ticks", async () => {
		const fixture = kernelRegistry();
		registerParamRule(fixture);
		const sim = build(
			{
				params: { amount: 1 },
				providers: { main: { kind: "paramRule" } },
				hypothesis: hypothesis([
					{ name: "treatment", role: "treatment", overrides: { "params.amount": 5 } },
				]),
			},
			fixture,
		);
		await sim.step();
		expect(bumpArgs(sim, 0)).toEqual([1, 1, 1]);
		await sim.intervene("treatment", undefined, 1);
		expect(sim.scenario.params.amount).toBe(5);
		await sim.step();
		expect(bumpArgs(sim, 1)).toEqual([5, 5, 5]);
		expect(failures(sim)).toEqual([]);
		const intervention = sim.log.query({ kind: ["intervention"] })[0];
		expect(intervention?.kind === "intervention" && intervention.payload.targets).toHaveLength(
			3,
		);
		expect(intervention?.t).toEqual({ tick: 1, substep: 0, seq: 0 });
		expect(sim.clock.now).toEqual({ tick: 2, substep: 0, seq: 0 });
		expect(sim.integrity().complete).toBe(true);
	});

	test("policy options and prompt options are hot; executor options driven by params rebuild the executor", async () => {
		const sim = build({
			policy: { kind: "bernoulli", options: { p: 0 } },
			params: { window: 3 },
			executors: [
				{
					kind: "focal",
					name: "people",
					options: {
						provider: "main",
						components: [
							{ kind: "instructions", options: { text: "Play along." } },
							{ kind: "persona" },
							{ kind: "recentMemory", options: { k: { $param: "window" } } },
						],
					},
				},
			],
			hypothesis: hypothesis([
				{
					name: "wake",
					role: "treatment",
					overrides: {
						"policy.options.p": 1,
						"prompt.personaFormat": "bullets",
						"params.window": 1,
					},
				},
			]),
		});
		await sim.step();
		expect(sim.integrity().activated).toBe(0);
		await sim.intervene("wake", undefined, 1);
		expect(failures(sim)).toEqual([]);
		expect(sim.scenario.prompt.personaFormat).toBe("bullets");
		expect(sim.scenario.params.window).toBe(1);
		await sim.step();
		expect(sim.integrity().activated).toBe(3);
		const prompt = sim.log
			.query({ kind: ["observation"], tick: 1 })
			.map((e) => (e.kind === "observation" ? sim.log.getContent(e.payload.contentSha) : ""));
		expect(prompt[0]).toContain("- name:");
	});

	test("instruction reaches the selected agents' next observation only", async () => {
		const sim = build({
			providers: { main: { kind: "mock" } },
			hypothesis: hypothesis([
				{
					name: "nudge",
					role: "treatment",
					overrides: {},
					selection: { where: { "persona.name": "Ann" } },
				},
			]),
		});
		await sim.step();
		await sim.intervene("nudge", "Please be kinder today.", 1);
		const intervention = sim.log.query({ kind: ["intervention"] })[0];
		const targets = intervention?.kind === "intervention" ? intervention.payload.targets : [];
		expect(targets.length).toBeGreaterThan(0);
		await sim.step();
		const prompts = sim.log.query({ kind: ["observation"], tick: 1 }).map((e) => ({
			agentId: e.agentId,
			text: e.kind === "observation" ? (sim.log.getContent(e.payload.contentSha) ?? "") : "",
		}));
		for (const p of prompts)
			expect(p.text.includes("Please be kinder today.")).toBe(
				p.agentId !== undefined && targets.includes(p.agentId),
			);
		await sim.step();
		const later = sim.log
			.query({ kind: ["observation"], tick: 2 })
			.map((e) =>
				e.kind === "observation" ? (sim.log.getContent(e.payload.contentSha) ?? "") : "",
			);
		expect(later.some((t) => t.includes("Please be kinder today."))).toBe(false);
	});

	test("non-hot paths, module-affecting params, unknown arms and empty selections are failures", async () => {
		const fixture = kernelRegistry();
		fixture.registry.modules.register("sized", (spec) => {
			const size = (spec.options ?? {}).size;
			return ok({
				name: "sized",
				concurrencySafe: true,
				declare: () => ok(undefined),
				actions: () => [],
				observe: () => ({}),
				step: async () => [],
				getState: () => (typeof size === "number" ? size : null),
				setState: () => {},
			});
		});
		const sim = build(
			{
				params: { size: 2, amount: 1 },
				modules: [
					{ kind: "ticker" },
					{ kind: "sized", options: { size: { $param: "size" } } },
				],
				hypothesis: hypothesis([
					{
						name: "cold",
						role: "treatment",
						overrides: { "llm.model": "other", "params.size": 9, "params.amount": 2 },
					},
					{
						name: "nobody",
						role: "control",
						overrides: {},
						selection: { where: { "persona.name": "Zed" } },
					},
				]),
			},
			fixture,
		);
		await sim.intervene("cold", undefined, 0);
		await sim.intervene("nobody", undefined, 1);
		await sim.intervene("ghost", undefined, 2);
		expect(failures(sim)).toEqual([
			"override_not_hot",
			"override_not_hot",
			"empty_selection",
			"unknown_arm",
		]);
		expect(sim.scenario.params.amount).toBe(2);
		expect(sim.scenario.params.size).toBe(2);
		const interventions = sim.log.query({ kind: ["intervention"] });
		expect(
			interventions.map((e) => (e.kind === "intervention" ? e.payload.targets.length : -1)),
		).toEqual([3, 0, 0]);
	});
});
