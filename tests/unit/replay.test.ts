import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";
import { parseScenario } from "../../src/core/scenario";
import { remainingSteps, resumeRun, runScenario } from "../../src/core/run";
import { CHECKPOINTS_DIR, SCENARIO_FILE, readRunScenario } from "../../src/core/runDir";
import { replayRun } from "../../src/core/replay";
import { inspectRun } from "../../src/core/inspect";
import type { EntityId, JsonObject, Scenario, Step } from "../../src/core/types";
import { gatewayFactory } from "../helpers/kernel";
import { builtinRegistry } from "../helpers/registry";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-replay-"));

const scenarioOf = (overrides: JsonObject = {}): Scenario => {
	const parsed = parseScenario({
		scenarioId: "replay",
		seed: 3,
		population: {
			n: 20,
			fields: [
				{ name: "stance", dtype: "f64", sampling: { kind: "range", min: -2, max: 2 } },
			],
		},
		modules: [
			{
				kind: "socialGraph",
				options: {
					meanDegree: 3,
					stanceColumn: "persona.stance",
					hubAssignment: "mixed",
					hubCount: 2,
				},
			},
			{ kind: "feed", options: { size: 3, recommender: "followingFirst" } },
			{ kind: "calendar", options: { events: { "1": "news" } } },
		],
		executors: [
			{
				kind: "focal",
				name: "people",
				options: {
					provider: "main",
					components: [
						{ kind: "persona" },
						{ kind: "recentMemory", options: { k: 2 } },
						{ kind: "feedObservation", options: { size: 3 } },
					],
				},
			},
		],
		providers: { main: { kind: "mock" } },
		policy: { kind: "bernoulli", options: { p: 0.6 } },
		instruments: [{ kind: "actionShare", name: "postShare", options: { action: "post" } }],
		steps: [
			{ kind: "run", ticks: 3 },
			{ kind: "checkpoint" },
			{ kind: "run", ticks: 3 },
			{ kind: "checkpoint" },
		],
		...overrides,
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};

const worldHashAt = (dir: string, tick: number): string =>
	(
		JSON.parse(readFileSync(join(dir, CHECKPOINTS_DIR, String(tick), "meta.json"), "utf8")) as {
			worldHash: string;
		}
	).worldHash;

const digestOf = (dir: string): string => {
	const log = openSqliteEventLog(eventLogPath(dir));
	try {
		return log.digest();
	} finally {
		log.close();
	}
};

const opts = { createGateway: gatewayFactory };

describe("replayRun", () => {
	test("folding recorded effects from the tick 0 checkpoint reproduces later checkpoint hashes", async () => {
		const dir = tempDir();
		const r = await runScenario(scenarioOf(), builtinRegistry(), dir, opts);
		expect(r.ok && r.value.status).toBe("succeeded");
		expect(existsSync(join(dir, SCENARIO_FILE))).toBe(true);
		expect(readRunScenario(dir).ok).toBe(true);
		const at3 = replayRun(dir, 3);
		expect(at3.ok).toBe(true);
		if (at3.ok) {
			expect(at3.value.worldHash).toBe(worldHashAt(dir, 3));
			expect(at3.value.tick).toBe(3);
			expect(at3.value.folded).toBeGreaterThan(0);
		}
		const at6 = replayRun(dir, 6);
		expect(at6.ok && at6.value.worldHash).toBe(worldHashAt(dir, 6));
		const all = replayRun(dir);
		expect(all.ok && all.value.worldHash).toBe(worldHashAt(dir, 6));
		expect(all.ok && all.value.tick).toBe(6);
		const at0 = replayRun(dir, 0);
		expect(at0.ok && at0.value.worldHash).toBe(worldHashAt(dir, 0));
		expect(at0.ok && at0.value.folded).toBe(0);
		expect(at0.ok && at0.value.fromTick).toBe(0);
		const beyond = replayRun(dir, 99);
		expect(beyond.ok && beyond.value.tick).toBe(6);
		expect(beyond.ok && beyond.value.worldHash).toBe(worldHashAt(dir, 6));
		const negative = replayRun(dir, -1);
		expect(negative.ok).toBe(false);
		if (!negative.ok) expect(negative.error).toContain("non-negative");
	});

	test("starts from the earliest checkpoint not later than the target, so resumed runs replay too", async () => {
		const direct = tempDir();
		await runScenario(scenarioOf(), builtinRegistry(), direct, opts);
		const resumed = tempDir();
		const rr = await resumeRun(
			join(direct, CHECKPOINTS_DIR, "3"),
			3,
			builtinRegistry(),
			resumed,
			opts,
		);
		expect(rr.ok && rr.value.status).toBe("succeeded");
		expect(existsSync(join(resumed, CHECKPOINTS_DIR, "0"))).toBe(false);
		const at6 = replayRun(resumed, 6);
		expect(at6.ok).toBe(true);
		if (at6.ok) {
			expect(at6.value.worldHash).toBe(worldHashAt(direct, 6));
			expect(at6.value.fromTick).toBe(3);
			expect(at6.value.tick).toBe(6);
		}
		const all = replayRun(resumed);
		expect(all.ok && all.value.worldHash).toBe(worldHashAt(direct, 6));
		const tooEarly = replayRun(resumed, 2);
		expect(tooEarly.ok).toBe(false);
		if (!tooEarly.ok) expect(tooEarly.error).toContain("no checkpoint at or before tick 2");
	});

	test("fails typed on a directory without a run", () => {
		const missing = replayRun(tempDir(), 1);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain(SCENARIO_FILE);
	});
});

describe("resumeRun", () => {
	test("continues from a checkpoint with the same world hash and digest as the direct run", async () => {
		const direct = tempDir();
		const r = await runScenario(scenarioOf(), builtinRegistry(), direct, opts);
		expect(r.ok && r.value.status).toBe("succeeded");
		const resumed = tempDir();
		const rr = await resumeRun(
			join(direct, CHECKPOINTS_DIR, "3"),
			3,
			builtinRegistry(),
			resumed,
			opts,
		);
		expect(rr.ok && rr.value.status).toBe("succeeded");
		if (!rr.ok || !r.ok) return;
		expect(rr.value.scenarioHash).toBe(r.value.scenarioHash);
		expect(worldHashAt(resumed, 6)).toBe(worldHashAt(direct, 6));
		expect(worldHashAt(resumed, 3)).toBe(worldHashAt(direct, 3));
		expect(digestOf(resumed)).toBe(digestOf(direct));
		expect(rr.value.integrity.complete).toBe(true);
		expect(rr.value.metrics.postShare).toBe(r.value.metrics.postShare);
		const log = openSqliteEventLog(eventLogPath(resumed));
		expect(log.query({ kind: ["checkpoint"] }).map((e) => e.t.tick)).toEqual([0, 3, 6]);
		expect(log.query({ tick: 2 }).length).toBeGreaterThan(0);
		log.close();
	});

	test("resuming from tick 0 and beyond the scenario end both work", async () => {
		const direct = tempDir();
		await runScenario(scenarioOf(), builtinRegistry(), direct, opts);
		const fromZero = tempDir();
		const r0 = await resumeRun(
			join(direct, CHECKPOINTS_DIR, "0"),
			6,
			builtinRegistry(),
			fromZero,
			opts,
		);
		expect(r0.ok && r0.value.status).toBe("succeeded");
		expect(worldHashAt(fromZero, 6)).toBe(worldHashAt(direct, 6));
		expect(digestOf(fromZero)).toBe(digestOf(direct));
		const beyond = tempDir();
		const r6 = await resumeRun(
			join(direct, CHECKPOINTS_DIR, "6"),
			2,
			builtinRegistry(),
			beyond,
			{ ...opts, checkpointEvery: 1 },
		);
		expect(r6.ok && r6.value.status).toBe("succeeded");
		expect(existsSync(join(beyond, CHECKPOINTS_DIR, "8"))).toBe(true);
		expect(r6.ok && r6.value.integrity.activated).toBeGreaterThan(0);
	});

	test("a drifted scenario.json is ConfigDrift and a missing run dir is typed", async () => {
		const direct = tempDir();
		await runScenario(scenarioOf(), builtinRegistry(), direct, opts);
		const drifted = JSON.parse(readFileSync(join(direct, SCENARIO_FILE), "utf8")) as {
			seed: number;
		};
		drifted.seed = 99;
		writeFileSync(join(direct, SCENARIO_FILE), JSON.stringify(drifted));
		const rr = await resumeRun(
			join(direct, CHECKPOINTS_DIR, "3"),
			1,
			builtinRegistry(),
			tempDir(),
			opts,
		);
		expect(rr.ok).toBe(false);
		if (!rr.ok) expect(rr.error.excType).toBe("ConfigDrift");
		const missing = await resumeRun(
			join(tempDir(), "checkpoints", "0"),
			1,
			builtinRegistry(),
			tempDir(),
			opts,
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.excType).toBe("RunDirUnreadable");
	});

	test("remainingSteps skips what the checkpoint already covered", () => {
		const steps: readonly Step[] = [
			{ kind: "run", ticks: 5 },
			{ kind: "checkpoint" },
			{ kind: "run", ticks: 5 },
			{ kind: "checkpoint" },
			{ kind: "run", ticks: 5 },
		];
		expect(remainingSteps(steps, 5)).toEqual([
			{ kind: "run", ticks: 5 },
			{ kind: "checkpoint" },
			{ kind: "run", ticks: 5 },
		]);
		expect(remainingSteps(steps, 7)).toEqual([
			{ kind: "run", ticks: 3 },
			{ kind: "checkpoint" },
			{ kind: "run", ticks: 5 },
		]);
		expect(remainingSteps(steps, 0)).toEqual(steps);
		expect(remainingSteps(steps, 15)).toEqual([]);
	});
});

describe("checkpointEvery and inspect", () => {
	test("checkpoint-every writes on multiples and never twice at one tick", async () => {
		const dir = tempDir();
		const r = await runScenario(
			scenarioOf({
				steps: [
					{ kind: "run", ticks: 2 },
					{ kind: "checkpoint" },
					{ kind: "run", ticks: 3 },
				],
			}),
			builtinRegistry(),
			dir,
			{ ...opts, checkpointEvery: 2 },
		);
		expect(r.ok && r.value.status).toBe("succeeded");
		const log = openSqliteEventLog(eventLogPath(dir));
		expect(log.query({ kind: ["checkpoint"] }).map((e) => e.t.tick)).toEqual([0, 2, 4]);
		log.close();
		for (const tick of ["0", "2", "4"])
			expect(existsSync(join(dir, CHECKPOINTS_DIR, tick))).toBe(true);
	});

	test("inspect returns observation, prompt preview, decision and caused effects", async () => {
		const dir = tempDir();
		await runScenario(
			scenarioOf({ policy: { kind: "allAgents" }, steps: [{ kind: "run", ticks: 2 }] }),
			builtinRegistry(),
			dir,
			opts,
		);
		const log = openSqliteEventLog(eventLogPath(dir));
		const post = log
			.query({ kind: ["decision"] })
			.find((e) => e.kind === "decision" && e.payload.action === "post");
		log.close();
		expect(post).toBeDefined();
		if (post === undefined || post.agentId === undefined) return;
		const byTick = inspectRun(dir, { agentId: post.agentId, tick: post.t.tick });
		expect(byTick.ok).toBe(true);
		if (!byTick.ok) return;
		expect(byTick.value.decision?.eventId).toBe(post.eventId);
		expect(byTick.value.observation?.kind).toBe("observation");
		expect(byTick.value.promptPreview?.length).toBeGreaterThan(0);
		expect(byTick.value.promptPreview?.length).toBeLessThanOrEqual(200);
		expect(byTick.value.effects).toHaveLength(1);
		expect(byTick.value.effects[0]?.op).toBe("create");
		expect(byTick.value.chain.map((e) => e.kind)).toEqual(["observation", "decision"]);
		const byEvent = inspectRun(dir, { agentId: post.agentId, eventId: post.eventId });
		expect(byEvent.ok && byEvent.value.decision?.eventId).toBe(post.eventId);
		const latest = inspectRun(dir, { agentId: post.agentId });
		expect(latest.ok && latest.value.tick).toBe(1);
		const unknown = inspectRun(dir, { agentId: "nobody" as EntityId });
		expect(unknown.ok).toBe(false);
	});
});
