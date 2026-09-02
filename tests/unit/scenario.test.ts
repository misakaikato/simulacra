import { describe, expect, test } from "bun:test";
import {
	overrideScenario,
	parseScenario,
	parseScenarioYaml,
	resolveScenarioPaths,
	scenarioHash,
	spawnReplications,
} from "../../src/core/scenario";
import { AuditPlanSchema, ScenarioSchema, SelectorSchema } from "../../src/core/schema";
import type { Scenario } from "../../src/core/types";

const minimalYaml = `
scenarioId: demo
seed: 7
population:
  n: 3
  fields:
    - name: stance
      dtype: f64
      sampling: { kind: range, min: -1, max: 1 }
    - name: group
      dtype: str
      private: true
      sampling: { kind: choice, choices: [a, b], weights: [0.5, 0.5] }
params:
  feed:
    size: 5
  homophily: 0.3
modules:
  - kind: feed
    options: { size: 5 }
providers:
  main: { kind: mock }
policy: { kind: bernoulli, options: { p: 0.5 } }
instruments:
  - { kind: cooperationRate, every: 2 }
steps:
  - { kind: run, ticks: 3 }
  - { kind: intervene, arm: treatment }
  - { kind: questionnaire, name: q1, targets: { where: { "persona.group": { in: [a] } } } }
  - { kind: checkpoint }
`;

const load = (): Scenario => {
	const r = parseScenarioYaml(minimalYaml);
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return r.value;
};

describe("ScenarioSchema", () => {
	test("parses YAML and fills defaults", () => {
		const s = load();
		expect(s.replicationId).toBe(0);
		expect(s.seedPath).toEqual([]);
		expect(s.llm.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(s.llm.concurrency).toEqual({ initial: 4, max: 16 });
		expect(s.llm.budget.maxCalls).toBe(1000);
		expect(s.prompt.personaFormat).toBe("plain");
		expect(s.prompt.contextWindow).toBe(4000);
		expect(s.population.source).toEqual({ kind: "synthetic" });
		expect(s.population.provenance).toBe("synthetic");
		expect(s.executors).toEqual([]);
		expect(s.instruments[0]?.every).toBe(2);
		expect(s.steps).toHaveLength(4);
		const q = s.steps[2];
		expect(q?.kind === "questionnaire" && q.targets?.where["persona.group"]).toEqual({
			in: ["a"],
		});
	});

	test("population.n = 0 fails with the issue pointing at population.n", () => {
		const r = parseScenarioYaml(minimalYaml.replace("n: 3", "n: 0"));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.map((i) => i.path.join("."))).toContain("population.n");
	});

	test("missing required fields and bad enums are reported", () => {
		const r = parseScenario({ scenarioId: "x" });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		const paths = r.error.map((i) => i.path.join("."));
		expect(paths).toContain("seed");
		expect(paths).toContain("population");
		const bad = ScenarioSchema.safeParse({
			scenarioId: "x",
			seed: 1,
			population: { n: 1 },
			prompt: { personaFormat: "poem" },
		});
		expect(bad.success).toBe(false);
	});

	test("invalid YAML syntax is returned as a single custom issue", () => {
		const r = parseScenarioYaml("scenarioId: [unclosed");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toHaveLength(1);
		expect(r.error[0]?.message).toMatch(/^YAML: /);
	});

	test("selector predicates keep their operator shape", () => {
		const parsed = SelectorSchema.parse({
			where: { age: { gt: 30 }, group: { in: ["a"] }, flag: true, score: { lt: 1 } },
			fraction: 0.5,
		});
		expect(parsed.where).toEqual({
			age: { gt: 30 },
			group: { in: ["a"] },
			flag: true,
			score: { lt: 1 },
		});
	});

	test("AuditPlanSchema nests a full scenario and defaults design fields", () => {
		const plan = AuditPlanSchema.parse({
			base: { scenarioId: "b", seed: 1, population: { n: 2 } },
			axes: [
				{
					id: "persona",
					level: "micro",
					kind: "representation",
					dimension: "prompt",
					target: "prompt.personaFormat",
					levels: ["plain", "table"],
				},
			],
		});
		expect(plan.design).toBe("one_at_a_time");
		expect(plan.replications).toBe(1);
		expect(plan.base.policy).toEqual({ kind: "allAgents" });
	});
});

describe("scenario functions", () => {
	test("scenarioHash is stable, order independent, and ignores replication fields", () => {
		const a = load();
		const b = load();
		expect(scenarioHash(a)).toBe(scenarioHash(b));
		const reordered = parseScenarioYaml(
			minimalYaml.replace("scenarioId: demo\nseed: 7", "seed: 7\nscenarioId: demo"),
		);
		expect(reordered.ok && scenarioHash(reordered.value)).toBe(scenarioHash(a));
		const replicated = spawnReplications(a, 2)[1];
		expect(replicated && scenarioHash(replicated)).toBe(scenarioHash(a));
		const changed = parseScenarioYaml(minimalYaml.replace("seed: 7", "seed: 8"));
		expect(changed.ok && scenarioHash(changed.value)).not.toBe(scenarioHash(a));
	});

	test("spawnReplications appends the index to seedPath with pairwise distinct paths", () => {
		const base = { ...load(), seedPath: [4] };
		const reps = spawnReplications(base, 3);
		expect(reps.map((r) => r.replicationId)).toEqual([0, 1, 2]);
		expect(reps.map((r) => r.seedPath)).toEqual([
			[4, 0],
			[4, 1],
			[4, 2],
		]);
		const keys = new Set(reps.map((r) => r.seedPath.join("/")));
		expect(keys.size).toBe(3);
		expect(base.seedPath).toEqual([4]);
	});

	test("overrideScenario sets nested, array, flat-dotted and params-relative paths", () => {
		const s = load();
		const a = overrideScenario(s, "population.n", 10);
		expect(a.ok && a.value.population.n).toBe(10);
		const b = overrideScenario(s, "params.feed.size", 9);
		expect(b.ok && b.value.params).toEqual({ feed: { size: 9 }, homophily: 0.3 });
		const c = overrideScenario(s, "feed.size", 11);
		expect(c.ok && c.value.params).toEqual({ feed: { size: 11 }, homophily: 0.3 });
		const d = overrideScenario(s, "modules.0.options.size", 12);
		expect(d.ok && d.value.modules[0]?.options).toEqual({ size: 12 });
		const e = overrideScenario(s, "prompt.personaFormat", "table");
		expect(e.ok && e.value.prompt.personaFormat).toBe("table");
		expect(s.population.n).toBe(3);
		expect(s.params).toEqual({ feed: { size: 5 }, homophily: 0.3 });
	});

	test("overrideScenario rejects unknown paths and invalid values", () => {
		const s = load();
		const unknown = overrideScenario(s, "params.nope", 1);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok)
			expect(unknown.error).toEqual({ kind: "UnknownOverride", path: "params.nope" });
		const outOfRange = overrideScenario(s, "modules.3.kind", "x");
		expect(outOfRange.ok).toBe(false);
		const invalid = overrideScenario(s, "population.n", "many");
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.error.kind).toBe("InvalidOverride");
	});
});

describe("resolveScenarioPaths", () => {
	test("resolves plugins and llm.recordDir against the scenario directory", () => {
		const s = load();
		const relative: Scenario = {
			...s,
			plugins: ["./rules.ts"],
			llm: { ...s.llm, recordDir: "./recordings" },
		};
		const resolved = resolveScenarioPaths(relative, "/base/dir");
		expect(resolved.plugins).toEqual(["/base/dir/rules.ts"]);
		expect(resolved.llm.recordDir).toBe("/base/dir/recordings");
		expect(resolved.llm.mode).toBe(relative.llm.mode);
		expect(resolveScenarioPaths(resolved, "/elsewhere")).toEqual(resolved);
	});

	test("leaves absent and absolute paths alone", () => {
		const s = load();
		expect(s.llm.recordDir).toBeUndefined();
		expect(resolveScenarioPaths(s, "/base")).toEqual(s);
		const absolute: Scenario = { ...s, llm: { ...s.llm, recordDir: "/abs/recordings" } };
		expect(resolveScenarioPaths(absolute, "/base").llm.recordDir).toBe("/abs/recordings");
	});
});
