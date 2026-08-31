import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OASIS_WORLD_FILE,
	createOasisAdapter,
	createScriptAdapter,
	importOasis,
	registerBuiltinAdapters,
	tickOf,
	traceEffects,
} from "../../src/adapters";
import { SCRIPT_LOG_FILE, externalToScenario } from "../../src/adapters/script";
import { toEntityId, toEventId } from "../../src/core/ids";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";
import { createRegistry } from "../../src/core/registry";
import { RESULT_FILE } from "../../src/core/run";
import { parseScenario } from "../../src/core/scenario";
import type { RunResult, Scenario, WorldSnapshot } from "../../src/core/types";
import { restoreWorld } from "../../src/core/world";
import { silentLogger } from "../../src/logging/logger";
import { registerBuiltinMetrics } from "../../src/metrics";
import { POST_COLUMNS, POST_ENTITY } from "../../src/modules/posts";
import { EDGE_ENTITY } from "../../src/modules/socialGraph";

const ROOT = join(import.meta.dir, "../..");
const FIXTURE_SQL = join(ROOT, "tests/fixtures/oasis_min.sql");
const SCRIPT = join(ROOT, "tests/fixtures/script_adapter.ts");
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-adapters-"));

const scenario = (params: Record<string, string> = {}): Scenario => {
	const parsed = parseScenario({ scenarioId: "ext", seed: 3, population: { n: 2 }, params });
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};

const fixtureDb = (): string => {
	const path = join(tempDir(), "oasis_min.db");
	const db = new Database(path);
	db.exec(readFileSync(FIXTURE_SQL, "utf8"));
	db.close();
	return path;
};

const metricsRegistry = () => {
	const registry = createRegistry();
	const r = registerBuiltinMetrics(registry);
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return registry;
};

describe("script adapter", () => {
	const adapter = createScriptAdapter({ argv: ["bun", SCRIPT] });

	test("runs the subprocess, reads a partial result.json and keeps the script log", async () => {
		const out = tempDir();
		const r = await adapter.run(scenario(), 7, out);
		expect(r.status).toBe("succeeded");
		expect(String(r.runId)).toBe("ext:0");
		expect(r.seed).toBe(7);
		expect(r.metrics).toEqual({ seedTimesTwo: 14, n: 2 });
		expect(r.distributions).toEqual({ d: [7, 8] });
		expect(r.integrity).toMatchObject({ activated: 4, ok: 4, failed: 0, complete: true });
		expect(r.cost.wallMs).toBeGreaterThan(0);
		expect(r.logPath).toBe(join(out, SCRIPT_LOG_FILE));
		expect(readFileSync(join(out, SCRIPT_LOG_FILE), "utf8")).toContain(
			"script mode=result seed=7",
		);
		expect(JSON.parse(readFileSync(join(out, "config.json"), "utf8"))).toMatchObject({
			scenarioId: "ext",
			seed: 7,
		});
	});

	test("non-zero exit codes become a FailureInfo at stage run", async () => {
		const out = tempDir();
		const r = await adapter.run(scenario({ mode: "fail" }), 1, out);
		expect(r.status).toBe("failed");
		expect(r.failure).toMatchObject({ stage: "run", excType: "NonZeroExit" });
		expect(r.failure?.message).toContain("exited with code 3");
		expect(r.failure?.message).toContain("scripted failure");
		expect(r.integrity.complete).toBe(false);
		expect(existsSync(join(out, SCRIPT_LOG_FILE))).toBe(true);
		expect(readFileSync(join(out, SCRIPT_LOG_FILE), "utf8")).toContain("[stderr]");
	});

	test("a missing result.json and an unknown executable are typed failures", async () => {
		const silent = await adapter.run(scenario({ mode: "silent" }), 1, tempDir());
		expect(silent.status).toBe("failed");
		expect(silent.failure).toMatchObject({ stage: "extract", excType: "MissingResult" });
		const missing = createScriptAdapter({ argv: ["/nonexistent/simulacra-script"] });
		const r = await missing.run(scenario(), 1, tempDir());
		expect(r.status).toBe("failed");
		expect(r.failure?.stage).toBe("instantiate");
	});

	test("toScenario accepts a Scenario or wraps unknown configuration into params.external", () => {
		const direct = externalToScenario("s", { scenarioId: "x", seed: 1, population: { n: 1 } });
		expect(direct.ok && direct.value.scenarioId).toBe("x");
		const wrapped = adapter.toScenario({ agents: 5, platform: "twitter" });
		expect(wrapped.ok).toBe(true);
		if (wrapped.ok) {
			expect(wrapped.value.scenarioId).toBe("script");
			expect(wrapped.value.params).toEqual({ external: { agents: 5, platform: "twitter" } });
		}
		const scalar = adapter.toScenario("config.yaml");
		expect(scalar.ok && scalar.value.params).toEqual({ external: "config.yaml" });
	});
});

describe("importOasis", () => {
	test("maps REFRESH to observations and other actions to decisions with effects", () => {
		const out = tempDir();
		const db = fixtureDb();
		const r = importOasis(
			db,
			out,
			[
				"cooperationRate",
				{
					kind: "actionShare",
					name: "createPostShare",
					options: { action: "create_post" },
				},
			],
			metricsRegistry(),
			{ logger: silentLogger },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value).toMatchObject({
			agents: 3,
			posts: 5,
			edges: 1,
			observations: 4,
			decisions: 6,
			parseFailures: 0,
		});
		expect(r.value.result.metrics.createPostShare).toBeCloseTo(4 / 6, 12);
		expect(r.value.result.metrics.cooperationRate).toBe(0);
		expect(r.value.result.integrity).toMatchObject({ activated: 6, ok: 6, complete: true });
		expect(r.value.result.status).toBe("succeeded");
		const log = openSqliteEventLog(eventLogPath(out));
		try {
			expect(log.query({ kind: ["observation"] })).toHaveLength(4);
			const decisions = log.query({ kind: ["decision"] });
			expect(decisions).toHaveLength(6);
			expect(log.query({ kind: ["effect"] })).toHaveLength(6);
			expect(log.count()).toBe(16);
			const first = decisions[0];
			expect(first?.kind === "decision" && first.payload.action).toBe("create_post");
			expect(first?.kind === "decision" && first.payload.provider).toBe("oasis");
			expect(first?.provenance).toBe("llm");
			expect(first?.agentId).toBe(toEntityId("oasis:1"));
			expect(first?.t).toEqual({ tick: 1, substep: 0, seq: 1 });
			const chain = log.chain(first?.eventId ?? toEventId("x"));
			expect(chain.map((e) => e.kind)).toEqual(["decision", "effect"]);
			const like = decisions.find(
				(d) => d.kind === "decision" && d.payload.action === "like_post",
			);
			const likeEffect = log
				.query({ kind: ["effect"] })
				.find((e) => e.parent === like?.eventId);
			expect(likeEffect?.kind === "effect" && likeEffect.payload.effects[0]).toMatchObject({
				op: "inc",
				entity: POST_ENTITY,
				id: "oasis:post:1",
				column: POST_COLUMNS.likes,
			});
			const refresh = log.query({ kind: ["observation"] })[0];
			expect(
				refresh?.kind === "observation" && log.getContent(refresh.payload.contentSha),
			).toBe('{"posts": []}');
		} finally {
			log.close();
		}
		const world = restoreWorld(
			JSON.parse(readFileSync(join(out, OASIS_WORLD_FILE), "utf8")) as WorldSnapshot,
		);
		expect(world.count("agent")).toBe(3);
		expect(world.count(POST_ENTITY)).toBe(5);
		expect(world.count(EDGE_ENTITY)).toBe(1);
		expect(world.row("agent", toEntityId("oasis:2"))).toMatchObject({
			"persona.name": "Ben",
			"persona.bio": "Likes birds",
		});
		expect(world.row(POST_ENTITY, toEntityId("oasis:post:5"))).toMatchObject({
			[POST_COLUMNS.author]: "oasis:2",
			[POST_COLUMNS.parent]: "oasis:post:1",
			[POST_COLUMNS.t]: 3,
		});
		expect(world.row(POST_ENTITY, toEntityId("oasis:post:1"))?.[POST_COLUMNS.likes]).toBe(1);
		const written = JSON.parse(readFileSync(join(out, RESULT_FILE), "utf8")) as RunResult;
		expect(written.metrics).toEqual(r.value.result.metrics);
		expect(existsSync(join(out, "scenario.json"))).toBe(true);
	});

	test("is deterministic, guards the output directory and reports bad inputs", () => {
		const db = fixtureDb();
		const a = tempDir();
		const b = tempDir();
		expect(importOasis(db, a, [], metricsRegistry()).ok).toBe(true);
		expect(importOasis(db, b, [], metricsRegistry()).ok).toBe(true);
		const digest = (dir: string) => {
			const log = openSqliteEventLog(eventLogPath(dir));
			try {
				return log.digest();
			} finally {
				log.close();
			}
		};
		expect(digest(a)).toBe(digest(b));
		const again = importOasis(db, a, [], metricsRegistry());
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error).toContain("not empty");
		expect(importOasis(db, a, [], metricsRegistry(), { overwrite: true }).ok).toBe(true);
		const missing = importOasis(join(tempDir(), "nope.db"), tempDir(), [], metricsRegistry());
		expect(missing.ok).toBe(false);
		const unknownMetric = importOasis(db, tempDir(), ["nope"], metricsRegistry());
		expect(unknownMetric.ok).toBe(false);
		if (!unknownMetric.ok) expect(unknownMetric.error).toContain("metric 'nope'");
		const empty = join(tempDir(), "empty.db");
		new Database(empty).close();
		const noTables = importOasis(empty, tempDir(), [], metricsRegistry());
		expect(noTables.ok).toBe(false);
		if (!noTables.ok) expect(noTables.error).toContain("table 'user' is missing");
	});

	test("ticks come from integer created_at or from row order, and unknown actions map to empty effects", () => {
		expect(tickOf(4, 9)).toBe(4);
		expect(tickOf("12", 9)).toBe(12);
		expect(tickOf("2024-01-01 10:00:00", 9)).toBe(9);
		expect(tickOf(null, 9)).toBe(9);
		const cause = toEventId("00000000000000000000000000");
		expect(traceEffects("DO_NOTHING", toEntityId("oasis:1"), {}, 0, 0, cause)).toEqual([]);
		expect(traceEffects("LIKE_POST", toEntityId("oasis:1"), {}, 0, 0, cause)).toEqual([]);
		const follow = traceEffects(
			"FOLLOW",
			toEntityId("oasis:1"),
			{ followee_id: 2 },
			0,
			3,
			cause,
		);
		expect(follow[0]).toMatchObject({
			op: "create",
			entity: EDGE_ENTITY,
			id: "oasis:edge:trace:3",
		});
	});
});

describe("oasis adapter over the script contract", () => {
	test("runs the script, imports the produced database and registers through the registry", async () => {
		const registry = metricsRegistry();
		const adapter = createOasisAdapter({
			argv: ["bun", SCRIPT],
			metrics: [{ kind: "actionShare", name: "likes", options: { action: "like_post" } }],
			registry,
		});
		const out = tempDir();
		const r = await adapter.run(scenario({ mode: "oasis", sql: FIXTURE_SQL }), 5, out);
		expect(r.status).toBe("succeeded");
		expect(String(r.runId)).toBe("ext:0");
		expect(r.seed).toBe(5);
		expect(r.metrics.likes).toBeCloseTo(1 / 6, 12);
		expect(r.integrity.activated).toBe(6);
		expect(existsSync(join(out, SCRIPT_LOG_FILE))).toBe(true);
		expect(existsSync(join(out, "oasis.db"))).toBe(true);
		expect(existsSync(eventLogPath(out))).toBe(true);
		const failed = await adapter.run(scenario({ mode: "fail" }), 5, tempDir());
		expect(failed.status).toBe("failed");
		expect(failed.failure?.excType).toBe("NonZeroExit");
		const noDb = await adapter.run(scenario({ mode: "silent" }), 5, tempDir());
		expect(noDb.status).toBe("failed");
		expect(noDb.failure?.excType).toBe("OasisImport");
		expect(noDb.failure?.message).toContain("file not found");
		expect(registerBuiltinAdapters(registry).ok).toBe(true);
		expect([...registry.adapters.kinds()].sort()).toEqual(["oasis", "script"]);
		const ctx = { scenario: scenario(), registry, logger: silentLogger };
		const created = registry.adapters.create(
			{ kind: "oasis", options: { argv: ["bun", SCRIPT], metrics: ["actionShare"] } },
			ctx,
		);
		expect(created.ok).toBe(true);
		const bad = registry.adapters.create({ kind: "script", options: { argv: [] } }, ctx);
		expect(bad.ok).toBe(false);
		expect(registerBuiltinAdapters(registry).ok).toBe(false);
	});
});
