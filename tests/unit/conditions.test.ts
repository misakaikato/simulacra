import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "../../src/core/result";
import { scenarioHash } from "../../src/core/scenario";
import { AuditPlanSchema, PerturbationAxisSchema } from "../../src/core/schema";
import type { AuditPlan, JsonValue, PerturbationAxis } from "../../src/core/types";
import {
	AXIS_CATALOG,
	DESIGN_AXES,
	REPRESENTATION_AXES,
	axisFromTemplate,
	axisTemplate,
} from "../../src/harness/axes";
import {
	assignmentsOf,
	baselineOf,
	conditionIdOf,
	generateConditions,
	isBaseCondition,
} from "../../src/harness/conditions";
import { parseAuditPlanYaml, planHash } from "../../src/harness/plan";
import { loadAuditPlan, loadScenario } from "../../src/index";

const ROOT = join(import.meta.dir, "../..");

const echoChamber = () => {
	const loaded = loadScenario(join(ROOT, "examples/echo_chamber/scenario.yaml"));
	if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
	return loaded.value;
};

const axis = (id: string, target: string, levels: readonly JsonValue[]): PerturbationAxis => ({
	id,
	level: "meso",
	kind: "design",
	dimension: id,
	target,
	levels,
});

const planWith = (overrides: Partial<Record<keyof AuditPlan, unknown>> = {}): AuditPlan =>
	AuditPlanSchema.parse({
		base: echoChamber(),
		axes: [
			axis("homophily", "params.homophily", ["low", "medium", "high"]),
			axis("feedSize", "params.feedSize", [5, 10]),
		],
		metrics: ["stanceAssortativity"],
		...overrides,
	});

describe("axis catalog", () => {
	test("has eight design dimensions and five representation categories with unique ids", () => {
		expect(DESIGN_AXES).toHaveLength(8);
		expect(REPRESENTATION_AXES).toHaveLength(5);
		expect(AXIS_CATALOG).toHaveLength(13);
		expect(new Set(AXIS_CATALOG.map((a) => a.id)).size).toBe(13);
		expect(DESIGN_AXES.every((a) => a.kind === "design")).toBe(true);
		expect(REPRESENTATION_AXES.every((a) => a.kind === "representation")).toBe(true);
		expect(AXIS_CATALOG.map((a) => a.id)).toEqual([
			"model_substrate",
			"agent_specification",
			"internal_state",
			"memory_temporality",
			"interaction_protocol",
			"intervention_design",
			"environment_structure",
			"population_scale",
			"representational_format",
			"instruction_hierarchy",
			"linguistic_framing",
			"context_representation",
			"interaction_sequencing",
		]);
		expect(new Set(AXIS_CATALOG.map((a) => a.level))).toEqual(
			new Set(["micro", "meso", "macro"]),
		);
	});

	test("axisTemplate and axisFromTemplate produce schema-valid axes", () => {
		expect(axisTemplate("model_substrate")?.target).toBe("llm.model");
		expect(axisTemplate("nope")).toBeUndefined();
		const a = axisFromTemplate("representational_format", ["plain", "table"]);
		expect(a).toBeDefined();
		expect(PerturbationAxisSchema.safeParse(a).success).toBe(true);
		expect(a?.target).toBe("prompt.personaFormat");
		const custom = axisFromTemplate("environment_structure", [1, 2], {
			id: "hub",
			target: "params.hub",
		});
		expect(custom?.id).toBe("hub");
		expect(custom?.target).toBe("params.hub");
		expect(axisFromTemplate("nope", [1])).toBeUndefined();
	});
});

describe("audit plan parsing", () => {
	const dir = mkdtempSync(join(tmpdir(), "simulacra-plan-"));
	const inlineYaml = `
base:
  scenarioId: s
  seed: 3
  population: { n: 2 }
  plugins: ["./rules.ts"]
axes:
  - { id: a, level: micro, kind: design, dimension: d, target: population.n, levels: [2, 4] }
replications: 4
metrics: [m]
`;

	test("inline base resolves plugins against the plan directory", () => {
		const parsed = parseAuditPlanYaml(inlineYaml, { baseDir: dir, loadScenario });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.base.plugins).toEqual([join(dir, "rules.ts")]);
		expect(parsed.value.replications).toBe(4);
		expect(parsed.value.design).toBe("one_at_a_time");
		expect(parsed.value.concurrency).toBe(1);
	});

	test("baseScenario loads relative to the plan and reports missing files", () => {
		const scenarioPath = join(dir, "nested", "scenario.yaml");
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(scenarioPath, "");
		const seen: string[] = [];
		const parsed = parseAuditPlanYaml("baseScenario: ./nested/scenario.yaml\nmetrics: [x]\n", {
			baseDir: dir,
			loadScenario: (path) => {
				seen.push(path);
				return ok(echoChamber());
			},
		});
		expect(parsed.ok).toBe(true);
		expect(seen).toEqual([scenarioPath]);
		if (parsed.ok) expect(parsed.value.base.scenarioId).toBe("echo_chamber");
		const missing = parseAuditPlanYaml("baseScenario: ./missing.yaml\n", {
			baseDir: dir,
			loadScenario,
		});
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error[0]?.path).toEqual(["baseScenario"]);
			expect(missing.error[0]?.message).toContain("file not found");
		}
		const broken = parseAuditPlanYaml("baseScenario: ./nested/scenario.yaml\n", {
			baseDir: dir,
			loadScenario: () =>
				err([{ code: "custom", path: ["population", "n"], message: "bad", input: 0 }]),
		});
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.error[0]?.path).toEqual(["baseScenario", "population", "n"]);
	});

	test("rejects plans with neither or both base forms and bad YAML", () => {
		const neither = parseAuditPlanYaml("metrics: [x]\n", { baseDir: dir, loadScenario });
		expect(neither.ok).toBe(false);
		const both = parseAuditPlanYaml(`${inlineYaml}baseScenario: ./x.yaml\n`, {
			baseDir: dir,
			loadScenario,
		});
		expect(both.ok).toBe(false);
		const bad = parseAuditPlanYaml("base: [\n", { baseDir: dir, loadScenario });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error[0]?.message).toContain("YAML");
	});

	test("loadAuditPlan reads a plan file next to its scenario and planHash is stable", () => {
		const path = join(dir, "plan.yaml");
		writeFileSync(join(dir, "scenario.yaml"), "scenarioId: p\nseed: 1\npopulation: { n: 1 }\n");
		writeFileSync(
			path,
			"baseScenario: ./scenario.yaml\naxes:\n  - { id: n, level: macro, kind: design, dimension: n, target: population.n, levels: [1, 2] }\nmetrics: [x]\nreplications: 2\n",
		);
		const a = loadAuditPlan(path);
		const b = loadAuditPlan(path);
		expect(a.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(planHash(a.value)).toBe(planHash(b.value));
		expect(planHash({ ...a.value, replications: a.value.replications + 1 })).not.toBe(
			planHash(a.value),
		);
		expect(loadAuditPlan(join(dir, "nope.yaml")).ok).toBe(false);
	});
});

describe("generateConditions", () => {
	test("one_at_a_time yields base plus one condition per level", () => {
		const plan = planWith();
		const r = generateConditions(plan);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value).toHaveLength(1 + 3 + 2);
		expect(r.value.map((c) => c.conditionId)).toEqual([
			"base",
			"homophily=0",
			"homophily=1",
			"homophily=2",
			"feedSize=0",
			"feedSize=1",
		]);
		const base = r.value[0];
		expect(base !== undefined && isBaseCondition(base)).toBe(true);
		expect(base?.flags).toBeUndefined();
		expect(base?.model).toBe(plan.base.llm.model);
		expect(base !== undefined && scenarioHash(base.scenario)).toBe(scenarioHash(plan.base));
		const high = r.value[3];
		expect(high?.axisValues).toEqual({ homophily: "high" });
		expect(high?.scenario.params.homophily).toBe("high");
		expect(high?.flags).toBeUndefined();
		expect(r.value[2]?.flags).toEqual(["identicalToBase"]);
		expect(r.value[4]?.flags).toEqual(["identicalToBase"]);
		expect(r.value[5]?.scenario.params.feedSize).toBe(10);
		for (const c of r.value) expect(baselineOf(r.value, c)).toBe(base);
	});

	test("full_factorial yields the cartesian product and crosses with models", () => {
		const factorial = generateConditions(planWith({ design: "full_factorial" }));
		expect(factorial.ok).toBe(true);
		if (!factorial.ok) return;
		expect(factorial.value).toHaveLength(3 * 2);
		expect(factorial.value.map((c) => c.conditionId)).toEqual([
			"homophily=0|feedSize=0",
			"homophily=0|feedSize=1",
			"homophily=1|feedSize=0",
			"homophily=1|feedSize=1",
			"homophily=2|feedSize=0",
			"homophily=2|feedSize=1",
		]);
		expect(
			factorial.value.filter((c) => c.flags !== undefined).map((c) => c.conditionId),
		).toEqual(["homophily=1|feedSize=0"]);
		expect(factorial.value.some(isBaseCondition)).toBe(false);
		const crossed = generateConditions(planWith({ models: ["m1", "m2"] }));
		expect(crossed.ok).toBe(true);
		if (!crossed.ok) return;
		expect(crossed.value).toHaveLength(6 * 2);
		expect(crossed.value.slice(0, 2).map((c) => c.conditionId)).toEqual(["base@m1", "base@m2"]);
		expect(crossed.value.every((c) => c.scenario.llm.model === c.model)).toBe(true);
		const last = crossed.value[11];
		expect(last?.conditionId).toBe("feedSize=1@m2");
		expect(baselineOf(crossed.value, last as never)?.conditionId).toBe("base@m2");
		const noAxes = generateConditions(planWith({ axes: [] }));
		expect(noAxes.ok && noAxes.value.map((c) => c.conditionId)).toEqual(["base"]);
		const factorialNoAxes = generateConditions(
			planWith({ axes: [], design: "full_factorial" }),
		);
		expect(factorialNoAxes.ok && factorialNoAxes.value.map((c) => c.conditionId)).toEqual([
			"base",
		]);
	});

	test("prompt targets land in scenario.prompt and unknown targets fail", () => {
		const prompt = generateConditions(
			planWith({ axes: [axis("format", "prompt.personaFormat", ["bullets", "table"])] }),
		);
		expect(prompt.ok).toBe(true);
		if (prompt.ok) {
			expect(prompt.value[1]?.scenario.prompt.personaFormat).toBe("bullets");
			expect(prompt.value[2]?.scenario.prompt.personaFormat).toBe("table");
		}
		const unknown = generateConditions(planWith({ axes: [axis("x", "params.nope", [1])] }));
		expect(unknown.ok).toBe(false);
		if (!unknown.ok)
			expect(unknown.error).toEqual({ kind: "UnknownOverride", path: "params.nope" });
		const invalid = generateConditions(
			planWith({ axes: [axis("n", "population.n", ["many"])] }),
		);
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.error.kind).toBe("InvalidOverride");
	});

	test("is pure and stable across calls", () => {
		const plan = planWith({ models: ["a"], design: "full_factorial" });
		const first = generateConditions(plan);
		const second = generateConditions(plan);
		expect(first).toEqual(second);
		const axes = plan.axes;
		expect(assignmentsOf(axes, "one_at_a_time")).toHaveLength(6);
		expect(assignmentsOf(axes, "full_factorial")).toHaveLength(6);
		expect(conditionIdOf(axes, [{ axis: 1, level: 1 }], "z")).toBe("feedSize=1@z");
		expect(conditionIdOf(axes, [])).toBe("base");
	});
});
