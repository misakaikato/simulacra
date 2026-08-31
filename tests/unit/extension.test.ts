import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	ZERO_EVENT_ID,
	createDefaultRegistry,
	defineAction,
	inspect,
	loadScenario,
	ok,
	runScenario,
	type ActivationPolicy,
	type Adapter,
	type DecisionProvider,
	type Metric,
	type Module,
	type Registry,
} from "../../src/index";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-ext-"));

const cheer = defineAction({
	name: "cheer",
	description: "Raise your own mood",
	params: z.object({ amount: z.number().int().positive() }),
	requiresModules: ["mood"],
	fallback: false,
	resolve: async (call) => [
		{
			op: "inc",
			entity: "agent",
			id: call.agentId,
			column: "mood.level",
			value: call.args.amount,
			cause: call.cause,
		},
	],
});

const rest = defineAction({
	name: "rest",
	description: "Do nothing",
	params: z.object({}),
	requiresModules: ["mood"],
	fallback: true,
	resolve: async () => [],
});

const moodModule: Module = {
	name: "mood",
	concurrencySafe: true,
	declare: (world) =>
		world.declare({
			entity: "agent",
			name: "level",
			dtype: "i32",
			default: 0,
			owner: "mood",
			merge: "sum",
		}),
	actions: () => [cheer, rest],
	observe: (view, ids) =>
		Object.fromEntries(
			ids.map((id) => [
				id,
				{ mood: view.column<number>("agent", "mood.level").get(id) ?? 0 },
			]),
		),
	step: async (view, t) => [
		{
			op: "envSet",
			key: "mood.average",
			value:
				view
					.column<number>("agent", "mood.level")
					.toArray()
					.reduce((a, b) => a + b, 0) / Math.max(1, view.count("agent")),
			cause: ZERO_EVENT_ID,
		},
		{ op: "envSet", key: "mood.tick", value: t.tick, cause: ZERO_EVENT_ID },
	],
	getState: () => null,
	setState: () => {},
};

const cheerProvider: DecisionProvider = {
	name: "cheerful",
	decide: async (requests) =>
		requests.map((req) =>
			ok({
				agentId: req.agentId,
				action: "cheer",
				args: { amount: 2 },
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
};

const evenAgents: ActivationPolicy = {
	name: "evenAgents",
	select: (world) => {
		const ordinal = world.column<number>("agent", "ordinal");
		return {
			agents: Object.fromEntries(
				world
					.ids("agent")
					.filter((id) => (ordinal.get(id) ?? 1) % 2 === 0)
					.map((id) => [id, "rule" as const]),
			),
		};
	},
};

const moodTotal: Metric = {
	name: "moodTotal",
	compute: (view) =>
		view
			.column<number>("agent", "mood.level")
			.toArray()
			.reduce((a, b) => a + b, 0),
};

const registerExtensions = (registry: Registry): void => {
	const results = [
		registry.modules.register("mood", () => ok(moodModule)),
		registry.providers.register("cheerful", () => ok(cheerProvider)),
		registry.policies.register("evenAgents", () => ok(evenAgents)),
		registry.metrics.register("moodTotal", () => ok(moodTotal)),
		registry.adapters.register("external", () =>
			ok<Adapter>({
				name: "external",
				toScenario: () => ({ ok: false, error: "not implemented in this test" }),
				run: () => Promise.reject(new Error("never called")),
			}),
		),
	];
	for (const r of results) if (!r.ok) throw new Error(JSON.stringify(r.error));
};

const SCENARIO = `
scenarioId: extension
seed: 5
population:
  n: 6
  fields:
    - { name: name, dtype: str, sampling: { kind: value, value: Ext } }
modules:
  - kind: mood
executors:
  - kind: focal
    name: people
    options:
      provider: main
      components:
        - kind: persona
        - kind: recentMemory
          options: { k: 2 }
providers:
  main: { kind: cheerful }
policy: { kind: evenAgents }
instruments:
  - { kind: moodTotal, every: 1 }
steps:
  - { kind: run, ticks: 3 }
`;

describe("extension without touching src/core", () => {
	test("a new action, module, provider, policy, metric and adapter run for 3 ticks", async () => {
		const registry = createDefaultRegistry();
		registerExtensions(registry);
		expect(registry.adapters.has("external")).toBe(true);
		const scenario = loadScenario(SCENARIO);
		expect(scenario.ok).toBe(true);
		if (!scenario.ok) return;
		const out = tempDir();
		const result = await runScenario(scenario.value, out, { registry });
		expect(result.ok && result.value.status).toBe("succeeded");
		if (!result.ok) return;
		expect(result.value.integrity).toEqual({
			activated: 9,
			ok: 9,
			failed: 0,
			parseFailures: 0,
			llmCalls: 0,
			llmFailures: 0,
			droppedEffects: 0,
			complete: true,
		});
		expect(result.value.metrics.moodTotal).toBe(18);
		const log = openSqliteEventLog(eventLogPath(out));
		const decisions = log.query({ kind: ["decision"] });
		expect(decisions).toHaveLength(9);
		expect(decisions.every((d) => d.kind === "decision" && d.payload.action === "cheer")).toBe(
			true,
		);
		const measurements = log.query({ kind: ["measurement"] });
		expect(
			measurements.map((m) => (m.kind === "measurement" ? m.payload.value : null)),
		).toEqual([6, 12, 18]);
		expect(log.query({ kind: ["module_step"] })).toHaveLength(3);
		const agentId = decisions[0]?.agentId;
		log.close();
		expect(agentId).toBeDefined();
		if (agentId === undefined) return;
		const chain = inspect(out, { agentId, tick: 2 });
		expect(chain.ok && chain.value.decision?.payload.action).toBe("cheer");
		expect(chain.ok && chain.value.effects.map((e) => e.op)).toEqual(["inc"]);
		expect(chain.ok && chain.value.promptPreview).toContain("You are agent");
	});
});
