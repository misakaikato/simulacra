import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditPlanSchema } from "../../src/core/schema";
import { memorySink } from "../../src/logging/sinks";
import type { AuditPlan, Event, JsonObject, RunId, Scenario } from "../../src/core/types";
import {
	AUDIT_FILE,
	PLAN_FILE,
	RESULT_FILE,
	SCENARIO_FILE,
	createLogger,
	createRunRegistry,
	makeRunId,
	parseScenario,
	runDirName,
	silentLogger,
	toRunId,
	totalTicks,
	type AuditMessage,
	type RunMessage,
	type RunRegistry,
} from "../../src/index";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-registry-"));

const scenarioOf = (overrides: JsonObject = {}): Scenario => {
	const parsed = parseScenario({
		scenarioId: "reg",
		seed: 5,
		population: {
			n: 8,
			fields: [
				{ name: "stance", dtype: "f64", sampling: { kind: "range", min: -1, max: 1 } },
			],
		},
		modules: [
			{ kind: "socialGraph", options: { meanDegree: 2 } },
			{ kind: "feed", options: { size: 3, recommender: "followingFirst" } },
		],
		executors: [
			{
				kind: "focal",
				name: "people",
				options: {
					provider: "main",
					components: [
						{ kind: "persona" },
						{ kind: "feedObservation", options: { size: 3 } },
					],
				},
			},
		],
		providers: { main: { kind: "mock" } },
		instruments: [{ kind: "actionShare", name: "postShare", options: { action: "post" } }],
		steps: [{ kind: "run", ticks: 2 }, { kind: "checkpoint" }, { kind: "run", ticks: 2 }],
		...overrides,
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};

const planOf = (): AuditPlan =>
	AuditPlanSchema.parse({
		base: scenarioOf(),
		axes: [
			{
				id: "n",
				level: "macro",
				kind: "design",
				dimension: "population",
				target: "population.n",
				levels: [4, 6],
			},
		],
		replications: 2,
		metrics: ["postShare"],
	});

const untilRunDone = (registry: RunRegistry, runId: RunId, events: Event[] = []) =>
	new Promise<void>((resolve) => {
		const unsubscribe = registry.subscribe(runId, (m: RunMessage) => {
			if (m.kind === "event") events.push(m.event);
			else resolve();
		});
		if (unsubscribe === undefined) resolve();
	});

const untilAuditDone = (registry: RunRegistry, auditId: string, progress: number[] = []) =>
	new Promise<void>((resolve) => {
		const unsubscribe = registry.subscribeAudit(auditId, (m: AuditMessage) => {
			if (m.kind === "progress") progress.push(m.completed);
			else resolve();
		});
		if (unsubscribe === undefined) resolve();
	});

describe("run registry", () => {
	test("starts a run in the background, streams its events and lists it from memory and disk", async () => {
		const dataDir = tempDir();
		const registry = createRunRegistry({ dataDir, logger: silentLogger });
		const started = registry.startRun({ scenario: scenarioOf(), seed: 9, ticks: 3 });
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(String(started.value.runId)).toBe("reg:0");
		expect(registry.runDir(started.value.runId)).toBe(join(dataDir, "runs", "reg__0"));
		const again = registry.startRun({ scenario: scenarioOf() });
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error).toEqual({ kind: "RunExists", runId: toRunId("reg:0") });
		const running = registry.getRun(started.value.runId);
		expect(running?.progress).toEqual({ tick: 0, ticks: 3, status: "running" });
		expect(running?.agentCount).toBe(8);
		expect(running?.result).toBeUndefined();
		const events: Event[] = [];
		await untilRunDone(registry, started.value.runId, events);
		expect(events.filter((e) => e.kind === "activation")).toHaveLength(3);
		const done = registry.getRun(started.value.runId);
		expect(done).toBeDefined();
		if (done === undefined) return;
		expect(done.progress).toEqual({ tick: 3, ticks: 3, status: "succeeded" });
		expect(done.result?.status).toBe("succeeded");
		expect(done.result?.seed).toBe(9);
		expect(done.result?.integrity.complete).toBe(true);
		expect(registry.subscribe(started.value.runId, () => {})).toBeUndefined();
		expect(registry.listRuns().map((r) => r.runId)).toEqual([toRunId("reg:0")]);
		const reopened = createRunRegistry({ dataDir, logger: silentLogger });
		expect(reopened.getRun(toRunId("reg:0"))).toEqual(done);
		expect(reopened.listRuns()).toEqual([done]);
		expect(reopened.getRun(toRunId("nope:0"))).toBeUndefined();
		expect(reopened.startRun({ scenario: scenarioOf() }).ok).toBe(false);
	});

	test("unreadable result.json and plan.json are reported as failed entries with an error and logged", () => {
		const dataDir = tempDir();
		const sink = memorySink();
		const logger = createLogger({ level: "error", sinks: [sink] });
		const runDir = join(dataDir, "runs", "x__0");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, SCENARIO_FILE), JSON.stringify(scenarioOf({ scenarioId: "x" })));
		writeFileSync(join(runDir, RESULT_FILE), "{");
		const auditDir = join(dataDir, "audits", "bad");
		mkdirSync(auditDir, { recursive: true });
		writeFileSync(join(auditDir, PLAN_FILE), "{");
		writeFileSync(join(auditDir, AUDIT_FILE), "not json");
		const registry = createRunRegistry({ dataDir, logger });
		const runs = registry.listRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.progress).toEqual({ tick: 0, ticks: 4, status: "failed" });
		expect(runs[0]?.error).toContain(join(runDir, RESULT_FILE));
		expect(runs[0]?.result).toBeUndefined();
		expect(registry.getRun(toRunId("x:0"))?.error).toBe(runs[0]?.error ?? "");
		const audits = registry.listAudits();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.progress.status).toBe("failed");
		expect(audits[0]?.error).toContain(join(auditDir, PLAN_FILE));
		expect(audits[0]?.error).toContain(join(auditDir, AUDIT_FILE));
		expect(audits[0]?.plan).toBeUndefined();
		expect(audits[0]?.report).toBeUndefined();
		const messages = sink.records.filter((r) => r.level === "error").map((r) => r.msg);
		expect(messages).toContain("result.json unreadable");
		expect(messages).toContain("plan.json unreadable");
		expect(messages).toContain("audit.json unreadable");
	});

	test("a run that cannot start is recorded as failed and persisted", async () => {
		const registry = createRunRegistry({ dataDir: tempDir(), logger: silentLogger });
		const scenario = scenarioOf({ scenarioId: "broken", plugins: ["/nowhere/plugin.ts"] });
		const started = registry.startRun({ scenario });
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await untilRunDone(registry, started.value.runId);
		const failed = registry.getRun(started.value.runId);
		expect(failed?.progress.status).toBe("failed");
		expect(failed?.result?.failure?.excType).toBe("PluginLoad");
		expect(existsSync(join(registry.runDir(started.value.runId), RESULT_FILE))).toBe(true);
		expect(totalTicks(scenario)).toBe(4);
		expect(runDirName(makeRunId("a/b:c", 2))).toBe("a_b__c__2");
	});

	test("starts an audit, reports progress per finished run and lists it from disk afterwards", async () => {
		const dataDir = tempDir();
		const registry = createRunRegistry({ dataDir, logger: silentLogger });
		const bad = registry.startAudit({ plan: planOf(), name: "../x" });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error.kind).toBe("InvalidAuditName");
		const started = registry.startAudit({ plan: planOf(), name: "pd-smoke", replications: 2 });
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.value.auditId).toBe("pd-smoke");
		const dup = registry.startAudit({ plan: planOf(), name: "pd-smoke" });
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.error).toEqual({ kind: "AuditExists", auditId: "pd-smoke" });
		expect(registry.getAudit("pd-smoke")?.progress).toEqual({
			completed: 0,
			total: 6,
			status: "running",
		});
		const progress: number[] = [];
		await untilAuditDone(registry, "pd-smoke", progress);
		expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
		const done = registry.getAudit("pd-smoke");
		expect(done?.progress).toEqual({ completed: 6, total: 6, status: "succeeded" });
		expect(done?.report?.runs).toHaveLength(6);
		expect(done?.report?.pairwise.length).toBeGreaterThan(0);
		expect(done?.plan?.replications).toBe(2);
		expect(existsSync(join(registry.auditDir("pd-smoke"), AUDIT_FILE))).toBe(true);
		const hashed = registry.startAudit({ plan: planOf(), replications: 1 });
		expect(hashed.ok).toBe(true);
		if (!hashed.ok) return;
		expect(hashed.value.auditId).toMatch(/^[0-9a-f]{12}$/);
		await untilAuditDone(registry, hashed.value.auditId);
		const reopened = createRunRegistry({ dataDir, logger: silentLogger });
		const listed = reopened.listAudits();
		expect(listed.map((a) => a.auditId)).toEqual([hashed.value.auditId, "pd-smoke"].sort());
		const fromDisk = reopened.getAudit("pd-smoke");
		expect(fromDisk?.progress).toEqual({ completed: 6, total: 6, status: "succeeded" });
		expect(fromDisk?.plan?.axes.map((a) => a.id)).toEqual(["n"]);
		expect(fromDisk?.report?.planHash).toBe(done?.report?.planHash ?? "");
		expect(
			JSON.parse(readFileSync(join(reopened.auditDir("pd-smoke"), AUDIT_FILE), "utf8")),
		).toMatchObject({ planHash: done?.report?.planHash });
		expect(reopened.getAudit("missing")).toBeUndefined();
		expect(reopened.getAudit("../etc")).toBeUndefined();
	});
});
