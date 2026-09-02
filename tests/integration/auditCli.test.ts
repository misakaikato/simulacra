import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";
import { readRunScenario } from "../../src/core/runDir";
import type { AuditReport } from "../../src/core/types";
import { loadAuditPlan } from "../../src/index";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/index.ts");
const PD_AUDIT = join(ROOT, "examples/prisoners_dilemma/audit.yaml");
const ECHO_AUDIT = join(ROOT, "examples/echo_chamber/audit.yaml");
const FIXTURE_SQL = join(ROOT, "tests/fixtures/oasis_min.sql");
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-audit-cli-"));

interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const cli = (args: readonly string[]): Ran => {
	const proc = Bun.spawnSync(["bun", CLI, ...args], {
		cwd: ROOT,
		env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode,
		stdout: new TextDecoder().decode(proc.stdout),
		stderr: new TextDecoder().decode(proc.stderr),
	};
};

const lineValue = (out: string, key: string): string | undefined =>
	out
		.split("\n")
		.find((l) => l.startsWith(`${key}: `))
		?.slice(key.length + 2);

const readReport = (dir: string): AuditReport =>
	JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")) as AuditReport;

describe("example audit plans", () => {
	test("prisoners_dilemma/audit.yaml declares three representation axes and loads its plugin", () => {
		const plan = loadAuditPlan(PD_AUDIT);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.axes.map((a) => [a.id, a.target, a.levels.length])).toEqual([
			["personaFormat", "prompt.personaFormat", 3],
			["framing", "params.framing", 3],
			["memoryRepresentation", "prompt.memoryRepresentation", 3],
		]);
		expect(plan.value.replications).toBe(30);
		expect(plan.value.design).toBe("one_at_a_time");
		expect(plan.value.claimType).toBe("mechanism");
		expect(plan.value.metrics).toEqual(["cooperationRate", "averagePayoff"]);
		expect(plan.value.base.plugins).toEqual([
			join(ROOT, "examples/prisoners_dilemma/rules.ts"),
		]);
		expect(plan.value.hypothesis?.outcomes.map((o) => o.metric)).toEqual([
			"cooperationRate",
			"averagePayoff",
		]);
	});

	test("echo_chamber/audit.yaml declares five design axes", () => {
		const plan = loadAuditPlan(ECHO_AUDIT);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.axes.map((a) => [a.id, a.levels.length])).toEqual([
			["homophily", 3],
			["hub", 4],
			["activation", 2],
			["memoryWindow", 2],
			["feedSize", 2],
		]);
		expect(plan.value.claimType).toBe("exploratory");
		expect(plan.value.replications).toBe(30);
		expect(plan.value.metrics).toEqual(["stanceAssortativity", "sameGroupRatio"]);
	});
});

describe("simulacra audit and report", () => {
	test("prisoners_dilemma with 5 mock replications produces audit.json and an offline report.html", () => {
		const out = tempDir();
		const r = cli([
			"audit",
			PD_AUDIT,
			"--replications",
			"5",
			"--provider",
			"mock",
			"--out",
			out,
		]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(lineValue(r.stdout, "conditions")).toBe("10");
		expect(lineValue(r.stdout, "runs")).toBe("50 (failed: 0, incomplete: 0, excluded: 0)");
		expect(lineValue(r.stdout, "evidenceGrade")).toBe("weak");
		expect(lineValue(r.stdout, "audit")).toBe(join(out, "audit.json"));
		expect(lineValue(r.stdout, "report")).toBe(join(out, "report.html"));
		const report = readReport(out);
		expect(report.evidenceGrade).toBe("weak");
		expect(report.plan.replications).toBe(5);
		expect(report.conditions).toHaveLength(10);
		expect(report.runs).toHaveLength(50);
		expect(report.runs.every((run) => run.status === "succeeded")).toBe(true);
		expect(report.pairwise.length).toBeGreaterThan(0);
		expect(report.pairwise.every((t) => typeof t.holmP === "number")).toBe(true);
		expect(new Set(report.pairwise.map((t) => t.metric))).toEqual(
			new Set(["cooperationRate", "averagePayoff"]),
		);
		expect(report.sensitivityRank.map(([axis]) => axis).sort()).toEqual([
			"framing",
			"memoryRepresentation",
			"personaFormat",
		]);
		const identical = report.conditions.filter((c) => c.flags?.includes("identicalToBase"));
		expect(identical.map((c) => c.conditionId)).toEqual([
			"personaFormat=0",
			"framing=0",
			"memoryRepresentation=0",
		]);
		expect(existsSync(join(out, "runs", "base", "0", "result.json"))).toBe(true);
		expect(existsSync(join(out, "runs", "framing-2", "4", "events.sqlite"))).toBe(true);
		const html = readFileSync(join(out, "report.html"), "utf8");
		expect(html.includes("http")).toBe(false);
		expect(html).toContain("cooperationRate");
		const again = cli(["report", out, "--out", join(out, "again.html")]);
		expect(again.code).toBe(0);
		expect(readFileSync(join(out, "again.html"), "utf8")).toBe(html);
		const nonEmpty = cli([
			"audit",
			PD_AUDIT,
			"--replications",
			"1",
			"--provider",
			"mock",
			"--out",
			out,
		]);
		expect(nonEmpty.code).toBe(1);
		expect(nonEmpty.stderr).toContain("not empty");
	}, 120000);

	test("echo_chamber with 2 mock replications runs all fourteen conditions", () => {
		const out = tempDir();
		const r = cli([
			"audit",
			ECHO_AUDIT,
			"--replications",
			"2",
			"--provider",
			"mock",
			"--concurrency",
			"4",
			"--out",
			out,
		]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(lineValue(r.stdout, "conditions")).toBe("14");
		expect(lineValue(r.stdout, "runs")).toBe("28 (failed: 0, incomplete: 0, excluded: 0)");
		const report = readReport(out);
		expect(report.pairwise.length).toBeGreaterThan(0);
		expect(report.evidenceGrade).toBe("weak");
		expect(report.integritySummary.rejectedActions).toBeGreaterThanOrEqual(0);
		expect(report.conditions.find((c) => c.conditionId === "hub=1")?.scenario.params.hub).toBe(
			"pro",
		);
	}, 240000);

	test("audit reports unknown axis targets without creating the output directory", () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, "bad.yaml"),
			`baseScenario: ${PD_AUDIT.replace("audit.yaml", "scenario.yaml")}\nmetrics: [cooperationRate]\naxes:\n  - { id: x, level: micro, kind: design, dimension: d, target: params.nope, levels: [1] }\n`,
		);
		const out = join(dir, "out");
		const r = cli(["audit", join(dir, "bad.yaml"), "--out", out]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("unknown axis target 'params.nope'");
		expect(existsSync(out)).toBe(false);
		const missing = cli(["audit", join(dir, "nope.yaml"), "--out", out]);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("file not found");
		const noReport = cli(["report", dir]);
		expect(noReport.code).toBe(1);
		expect(noReport.stderr).toContain("audit.json does not exist");
	});
});

describe("simulacra import-oasis", () => {
	test("imports the fixture database with REFRESH and action counts", () => {
		const dir = tempDir();
		const dbPath = join(dir, "oasis_min.db");
		const db = new Database(dbPath);
		db.exec(readFileSync(FIXTURE_SQL, "utf8"));
		db.close();
		const out = join(dir, "run");
		const r = cli([
			"import-oasis",
			dbPath,
			"--out",
			out,
			"--metrics",
			"cooperationRate,averagePayoff",
		]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(lineValue(r.stdout, "observations")).toBe("4");
		expect(lineValue(r.stdout, "decisions")).toBe("6");
		expect(lineValue(r.stdout, "agents")).toBe("3 posts: 5 edges: 1");
		expect(r.stdout).toContain("cooperationRate=0");
		const log = openSqliteEventLog(eventLogPath(out));
		try {
			expect(log.query({ kind: ["observation"] })).toHaveLength(4);
			expect(log.query({ kind: ["decision"] })).toHaveLength(6);
		} finally {
			log.close();
		}
		expect(existsSync(join(out, "result.json"))).toBe(true);
		const unknown = cli([
			"import-oasis",
			dbPath,
			"--out",
			join(dir, "run2"),
			"--metrics",
			"nope",
		]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("metric 'nope'");
	});
});

describe("simulacra audit --llm-mode", () => {
	test("reaches every run's scenario.json", () => {
		const out = tempDir();
		const r = cli([
			"audit",
			PD_AUDIT,
			"--replications",
			"1",
			"--provider",
			"mock",
			"--llm-mode",
			"replay",
			"--out",
			out,
		]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		for (const condition of ["base", "framing-2"]) {
			const written = readRunScenario(join(out, "runs", condition, "0"));
			expect(written.ok).toBe(true);
			if (!written.ok) continue;
			expect(written.value.llm.mode).toBe("replay");
			expect(written.value.llm.recordDir).toBe(
				join(ROOT, "examples/prisoners_dilemma/recordings"),
			);
		}
	}, 60000);
});
