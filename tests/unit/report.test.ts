import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeRunId } from "../../src/core/ids";
import { AuditPlanSchema } from "../../src/core/schema";
import type {
	AuditPlan,
	Condition,
	JsonValue,
	PerturbationAxis,
	RunResult,
} from "../../src/core/types";
import { generateConditions } from "../../src/harness/conditions";
import { planHash } from "../../src/harness/plan";
import { renderReportHtml } from "../../src/harness/report";
import { analyze, type AuditRun } from "../../src/harness/runner";
import { loadScenario } from "../../src/index";

const ROOT = join(import.meta.dir, "../..");

const axis = (id: string, target: string, levels: readonly JsonValue[]): PerturbationAxis => ({
	id,
	level: "meso",
	kind: "design",
	dimension: id,
	target,
	levels,
});

const planWith = (overrides: Partial<Record<keyof AuditPlan, unknown>> = {}): AuditPlan => {
	const loaded = loadScenario(join(ROOT, "examples/echo_chamber/scenario.yaml"));
	if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
	return AuditPlanSchema.parse({
		base: loaded.value,
		axes: [
			axis("homophily", "params.homophily", ["low", "high"]),
			axis("feedSize", "params.feedSize", [5, 10]),
		],
		metrics: ["stanceAssortativity"],
		design: "full_factorial",
		...overrides,
	});
};

const succeeded = (condition: Condition, replicationId: number, value: number): AuditRun => {
	const result: RunResult = {
		runId: makeRunId(condition.scenario.scenarioId, replicationId),
		scenarioHash: "h",
		seed: condition.scenario.seed,
		status: "succeeded",
		metrics: { stanceAssortativity: value },
		distributions: {},
		integrity: {
			activated: 1,
			ok: 1,
			failed: 0,
			parseFailures: 0,
			llmCalls: 0,
			llmFailures: 0,
			droppedEffects: 0,
			rejectedActions: 0,
			complete: true,
		},
		cost: { llmCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, wallMs: 1 },
		logPath: "log.jsonl",
	};
	return {
		ref: { conditionId: condition.conditionId, replicationId, dir: "runs" },
		result,
	};
};

const reportFor = (plan: AuditPlan, replications: number) => {
	const conditions = generateConditions(plan);
	if (!conditions.ok) throw new Error(JSON.stringify(conditions.error));
	const runs = conditions.value.flatMap((c, ci) =>
		Array.from({ length: replications }, (_, i) => succeeded(c, i, ci * 0.1 + i * 0.01)),
	);
	return analyze(plan, planHash(plan), conditions.value, runs, {
		includeIncomplete: false,
		bootstrapIters: 50,
	});
};

describe("report pairwise section", () => {
	test("full_factorial audits compare every cell against the base condition", () => {
		const report = reportFor(planWith({ replications: 2 }), 2);
		expect(report.conditions).toHaveLength(1 + 4);
		expect(report.pairwise).toHaveLength(4);
		expect(report.pairwise.every((t) => t.a === "base")).toBe(true);
		const html = renderReportHtml(report);
		expect(html).not.toContain("no pairwise tests");
		expect(html).toContain("homophily=1|feedSize=1");
	});

	test("the pairwise note names the real reason when the table is empty", () => {
		const single = renderReportHtml(reportFor(planWith({ replications: 1 }), 1));
		expect(single).toContain(
			"no pairwise tests (fewer than 2 usable replications per condition)",
		);
		const alone = renderReportHtml(reportFor(planWith({ axes: [], replications: 3 }), 3));
		expect(alone).toContain("no perturbation conditions");
		expect(alone).not.toContain("fewer than 2 usable replications");
	});
});
