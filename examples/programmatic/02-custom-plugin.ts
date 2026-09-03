// Define a world module, two actions and a rule provider in code, register them
// on a registry and run a scenario object without any YAML on disk.
// 在代码里定义一个世界模块、两个动作与一个规则 provider，注册到注册表上，
// 不落任何 YAML 文件即可运行一个场景对象。
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

// Actions declare zod params and resolve to effects; the kernel validates the args and applies
// the effects through its single write path.
// 动作声明 zod 参数并解析成效果；内核校验参数，并经唯一写入口应用效果。
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

// A module owns its columns (declare), contributes actions, feeds observations and may step the
// world each tick; this one only keeps a balance.
// 模块拥有自己的列（declare）、贡献动作、提供观察，并可以在每个 tick 推进世界；这个只维护余额。
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
// 余额高于平均的 agent 向人口里随机一个邻居捐赠。
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

// Registering on the default registry keeps the built-in plugins; the scenario refers to the
// new kinds by name.
// 注册到默认注册表上保留了内置插件；场景按名字引用新的 kind。
const register = (registry: Registry) => {
	const m = registry.modules.register("ledger", () => ok(ledger));
	if (!m.ok) throw new Error(JSON.stringify(m.error));
	const p = registry.providers.register("generous", (_spec, ctx) =>
		ok(createRuleProvider({ name: "generous", seed: ctx.scenario.seed, rule: generous })),
	);
	if (!p.ok) throw new Error(JSON.stringify(p.error));
};

// The scenario names the module and provider kinds registered above; llm and prompt are empty
// because a rule provider never calls a model.
// 场景引用上面注册的模块与 provider kind；llm 与 prompt 为空，因为规则 provider 从不调用模型。
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
