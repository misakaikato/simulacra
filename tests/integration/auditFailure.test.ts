import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunId } from "../../src/core/ids";
import type { RunFn } from "../../src/core/protocols";
import { parseScenario, scenarioHash } from "../../src/core/scenario";
import { AuditPlanSchema } from "../../src/core/schema";
import type { AuditPlan, AuditReport, RunResult } from "../../src/core/types";
import { renderReportHtml } from "../../src/harness/report";
import {
	AUDIT_FILE,
	PLAN_FILE,
	REPORT_FILE,
	RUNS_DIR,
	audit,
	conditionDirName,
	conditionDirNames,
	readAuditReport,
	runPool,
} from "../../src/harness/runner";
import { silentLogger } from "../../src/logging/logger";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-audit-"));

const ZERO_COST = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
} as const;

const base = () => {
	const parsed = parseScenario({ scenarioId: "t", seed: 5, population: { n: 3 } });
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};

const plan = (overrides: Partial<Record<keyof AuditPlan, unknown>> = {}): AuditPlan =>
	AuditPlanSchema.parse({
		base: base(),
		axes: [
			{
				id: "n",
				level: "macro",
				kind: "design",
				dimension: "population scale",
				target: "population.n",
				levels: [3, 4],
			},
		],
		replications: 5,
		metrics: ["m"],
		hypothesis: {
			id: "h",
			claim: "m rises",
			claimType: "mechanism",
			arms: [],
			outcomes: [
				{ name: "o", metric: "m", direction: "increase" },
				{ name: "d", metric: "d", direction: "any", targetDistribution: [0.5, 0.5] },
			],
		},
		...overrides,
	});

// Throws for population.n === 4; replication 2 of every other condition is incomplete
const stubRun =
	(onStart?: () => void, onEnd?: () => void): RunFn =>
	async (scenario, seed, dir) => {
		onStart?.();
		await Bun.sleep(2);
		onEnd?.();
		if (scenario.population.n === 4) throw new Error("boom");
		const rep = scenario.replicationId;
		const result: RunResult = {
			runId: makeRunId(scenario.scenarioId, rep),
			scenarioHash: scenarioHash(scenario),
			seed,
			status: "succeeded",
			metrics: { m: rep + scenario.population.n },
			distributions: { d: [rep, rep + 1] },
			integrity: {
				activated: 3,
				ok: 3,
				failed: 0,
				parseFailures: 0,
				llmCalls: 0,
				llmFailures: 0,
				droppedEffects: 0,
				rejectedActions: 0,
				complete: rep !== 2,
			},
			cost: { ...ZERO_COST, wallMs: 1 },
			logPath: join(dir, "log.jsonl"),
		};
		return result;
	};

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

describe("audit with a failing condition", () => {
	test("failures become failed RunResults, statistics skip them and files are written", async () => {
		const out = tempDir();
		const r = await audit(plan(), stubRun(), out, { logger: silentLogger });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const report = r.value;
		expect(report.conditions.map((c) => c.conditionId)).toEqual(["base", "n=0", "n=1"]);
		expect(report.conditions[1]?.flags).toEqual(["identicalToBase"]);
		expect(report.conditions.every((c) => c.scenario.scenarioId === `t#${c.conditionId}`)).toBe(
			true,
		);
		expect(report.runs).toHaveLength(15);
		expect(report.runIndex).toHaveLength(15);
		const failing = report.runIndex
			.map((ref, i) => [ref, report.runs[i]] as const)
			.filter(([ref]) => ref.conditionId === "n=1");
		expect(failing).toHaveLength(5);
		for (const [ref, run] of failing) {
			expect(run?.status).toBe("failed");
			expect(run?.failure?.message).toBe("boom");
			expect(run?.failure?.excType).toBe("Error");
			expect(run?.failure?.stage).toBe("run");
			expect(run?.integrity.complete).toBe(false);
			expect(String(run?.runId)).toBe(`t#n=1:${ref.replicationId}`);
			expect(existsSync(ref.dir)).toBe(true);
			expect(ref.dir).toBe(join(out, RUNS_DIR, "n-1", String(ref.replicationId)));
		}
		expect(report.integritySummary).toMatchObject({
			runs: 15,
			succeeded: 10,
			failed: 5,
			incomplete: 7,
			excluded: 7,
			activated: 30,
			agentOk: 30,
		});
		expect(report.costSummary.wallMs).toBe(10);
		expect(report.pairwise).toHaveLength(1);
		const [test0] = report.pairwise;
		expect(test0).toMatchObject({
			metric: "m",
			a: "base",
			b: "n=0",
			nA: 4,
			nB: 4,
			meanDiff: 0,
			cohenD: 0,
			mwuP: 1,
			holmP: 1,
			directionFlip: false,
		});
		expect(test0?.ci95[0]).toBeLessThan(0);
		expect(test0?.ci95[1]).toBeGreaterThan(0);
		expect(report.directionConsistency).toEqual({ m: 1 });
		expect(report.sensitivityRank).toEqual([["n", 0]]);
		expect(report.distributionTests).toHaveLength(1);
		expect(report.distributionTests[0]).toMatchObject({
			metric: "d",
			a: "base",
			b: "n=0",
			w1: 0,
			cliffDelta: 0,
		});
		expect(report.distributionTests[0]?.tvd).toBeDefined();
		expect(report.distributionTests[0]?.tvd).toBe(report.distributionTests[0]?.tvdBase);
		expect(report.crossModel).toEqual({ "deepseek-v4-flash": { m: 5 } });
		expect(report.evidenceGrade).toBe("weak");
		expect(report.plan).toMatchObject({ scenarioId: "t", replications: 5, metrics: ["m"] });
		expect(report.options).toEqual({ includeIncomplete: false, bootstrapIters: 2000 });

		expect(existsSync(join(out, PLAN_FILE))).toBe(true);
		expect(readJson<AuditPlan>(join(out, PLAN_FILE)).replications).toBe(5);
		const written = readJson<AuditReport>(join(out, AUDIT_FILE));
		expect(written.planHash).toBe(report.planHash);
		expect(written.pairwise[0]?.holmP).toBe(1);
		const html = readFileSync(join(out, REPORT_FILE), "utf8");
		expect(html).toBe(renderReportHtml(report));
		expect(html.includes("http")).toBe(false);
		expect(html.includes("<script")).toBe(false);
		expect(html).toContain("n=1");
		expect(html).toContain("weak");
		expect(html).toContain("<svg");
		expect(html).toContain("prefers-color-scheme");
		const reread = readAuditReport(out);
		expect(reread.ok && reread.value.planHash).toBe(report.planHash);
		expect(readAuditReport(tempDir()).ok).toBe(false);
	});

	test("includeIncomplete keeps incomplete runs, overrides change the plan, and dirs are guarded", async () => {
		const out = tempDir();
		const r = await audit(plan(), stubRun(), out, {
			logger: silentLogger,
			includeIncomplete: true,
			replications: 3,
			concurrency: 2,
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.runs).toHaveLength(9);
		expect(r.value.integritySummary).toMatchObject({
			runs: 9,
			failed: 3,
			incomplete: 5,
			excluded: 3,
		});
		expect(r.value.pairwise[0]).toMatchObject({ nA: 3, nB: 3 });
		expect(r.value.plan.replications).toBe(3);
		expect(readJson<AuditPlan>(join(out, PLAN_FILE))).toMatchObject({
			replications: 3,
			concurrency: 2,
		});
		const again = await audit(plan(), stubRun(), out, { logger: silentLogger });
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error).toEqual({ kind: "OutputDirNotEmpty", path: out });
		const replaced = await audit(plan(), stubRun(), out, {
			logger: silentLogger,
			overwrite: true,
			replications: 2,
		});
		expect(replaced.ok && replaced.value.runs).toHaveLength(6);
		const untouched = tempDir();
		const bad = await audit(
			plan({
				axes: [
					{
						id: "x",
						level: "micro",
						kind: "design",
						dimension: "d",
						target: "params.nope",
						levels: [1],
					},
				],
			}),
			stubRun(),
			join(untouched, "never"),
			{ logger: silentLogger },
		);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error.kind).toBe("UnknownOverride");
		expect(existsSync(join(untouched, "never"))).toBe(false);
	});

	test("concurrency bounds in-flight runs and results keep their order", async () => {
		let inFlight = 0;
		let peak = 0;
		const run = stubRun(
			() => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
			},
			() => {
				inFlight -= 1;
			},
		);
		const a = await audit(plan({ models: ["m1", "m2"] }), run, tempDir(), {
			logger: silentLogger,
			concurrency: 3,
		});
		expect(a.ok).toBe(true);
		if (!a.ok) return;
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(3);
		expect(a.value.conditions.map((c) => c.conditionId)).toEqual([
			"base@m1",
			"base@m2",
			"n=0@m1",
			"n=0@m2",
			"n=1@m1",
			"n=1@m2",
		]);
		expect(
			a.value.runIndex.map((r) => `${r.conditionId}/${r.replicationId}`).slice(0, 6),
		).toEqual(["base@m1/0", "base@m1/1", "base@m1/2", "base@m1/3", "base@m1/4", "base@m2/0"]);
		expect(a.value.runIndex[5]?.dir.endsWith(join("base~m2", "0"))).toBe(true);
		const b = await audit(plan({ models: ["m1", "m2"] }), stubRun(), tempDir(), {
			logger: silentLogger,
			concurrency: 1,
		});
		expect(b.ok && b.value.pairwise).toEqual(a.value.pairwise);
		expect(b.ok && Object.keys(b.value.crossModel).sort()).toEqual(["m1", "m2"]);
		const ordered = await runPool(
			[3, 1, 2].map((ms) => async () => {
				await Bun.sleep(ms);
				return ms;
			}),
			3,
		);
		expect(ordered).toEqual([3, 1, 2]);
		expect(await runPool([], 4)).toEqual([]);
	});

	test("condition directory names are file-system safe and unique", () => {
		expect(conditionDirName("homophily=0|feedSize=1@m/1")).toBe("homophily-0+feedSize-1~m_1");
		expect(conditionDirName("")).toBe("condition");
		const names = conditionDirNames([
			{ conditionId: "a=b", axisValues: {}, model: "m", scenario: base() },
			{ conditionId: "a-b", axisValues: {}, model: "m", scenario: base() },
		]);
		expect([...names.values()]).toEqual(["a-b", "a-b-2"]);
	});
});
