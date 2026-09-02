// Define a world module, two actions and a rule provider in code, register them
// on a registry and run a scenario object without any YAML on disk.
//
//   bun examples/programmatic/02-custom-plugin.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	createDefaultRegistry,
	createRuleProvider,
	defineAction,
	ok,
	parseScenarioYaml,
	runScenario,
	toEntityId,
	type Decision,
	type DecisionRequest,
	type Effect,
	type Module,
	type Registry,
	type Rng,
} from "../../src/index";

const ENTITY = "agent";
const BALANCE = "ledger.balance";

const donate = defineAction({
	name: "donate",
	description: "Give one unit of balance to another agent.",
	params: z.object({ target: z.string() }),
	requiresModules: ["ledger"],
	fallback: false,
	resolve: async (call) => [
		{
			op: "inc",
			entity: ENTITY,
			id: toEntityId(call.args.target),
			column: BALANCE,
			value: 1,
			cause: call.cause,
		},
		{
			op: "inc",
			entity: ENTITY,
			id: call.agentId,
			column: BALANCE,
			value: -1,
			cause: call.cause,
		},
	],
});

const hold = defineAction({
	name: "hold",
	description: "Keep the balance this tick.",
	params: z.object({}),
	requiresModules: ["ledger"],
	fallback: true,
	resolve: async () => [],
});

const ledger: Module = {
	name: "ledger",
	concurrencySafe: true,
	declare: (world) =>
		world.declare({
			entity: ENTITY,
			name: "balance",
			dtype: "f64",
			default: 10,
			owner: "ledger",
			merge: "sum",
		}),
	actions: () => [donate, hold],
	observe: (view, ids) =>
		Object.fromEntries(
			ids.map((id) => [id, { balance: view.column<number>(ENTITY, BALANCE).get(id) ?? 0 }]),
		),
	step: async () => [] as readonly Effect[],
	getState: () => null,
	setState: () => undefined,
};

// Agents with an above-average balance donate to a random neighbor in the population.
const generous = (req: DecisionRequest, rng: Rng): Decision => {
	const balance = Number(req.observation["balance"] ?? 0);
	const others = (req.state["others"] as readonly string[] | undefined) ?? [];
	const target = others.length > 0 ? rng.pick(others) : undefined;
	const action = balance > 10 && target !== undefined ? "donate" : "hold";
	return {
		agentId: req.agentId,
		action,
		args: action === "donate" && target !== undefined ? { target } : {},
		provenance: "rule",
		cost: { llmCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, wallMs: 0 },
		parseOk: true,
	};
};

const register = (registry: Registry) => {
	const m = registry.modules.register("ledger", () => ok(ledger));
	if (!m.ok) throw new Error(JSON.stringify(m.error));
	const p = registry.providers.register("generous", (_spec, ctx) =>
		ok(createRuleProvider({ name: "generous", seed: ctx.scenario.seed, rule: generous })),
	);
	if (!p.ok) throw new Error(JSON.stringify(p.error));
};

const yaml = `
scenarioId: ledger-demo
seed: 3
population:
  n: 12
  provenance: synthetic
  source: { kind: synthetic }
  fields:
    - { name: name, dtype: str, sampling: { kind: choice, choices: [Ada, Ben, Cy, Dee] } }
modules:
  - { kind: ledger }
executors:
  - kind: focal
    name: people
    options:
      provider: rule
      actions: [donate, hold]
      components:
        - { kind: persona }
        - { kind: instructions, options: { text: "Decide whether to donate one unit." } }
providers:
  rule: { kind: generous }
policy: { kind: allAgents }
instruments: []
steps:
  - { kind: run, ticks: 4 }
llm: {}
prompt: {}
`;

const scenario = parseScenarioYaml(yaml);
if (!scenario.ok) throw new Error(JSON.stringify(scenario.error));

const registry = createDefaultRegistry();
register(registry);

const outDir = mkdtempSync(join(tmpdir(), "simulacra-example-"));
const result = await runScenario(scenario.value, outDir, { registry, logLevel: "error" });
if (!result.ok) throw new Error(result.error.message);
console.log(
	`status ${result.value.status}, activated ${result.value.integrity.activated}, rejected ${result.value.integrity.rejectedActions}`,
);
console.log(result.value.integrity.complete ? "complete" : "incomplete");
rmSync(outDir, { recursive: true, force: true });
