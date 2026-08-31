import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PD_COLUMNS, register } from "../../examples/prisoners_dilemma/rules";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";
import type { Registry } from "../../src/core/protocols";
import { CHECKPOINTS_DIR, runScenario } from "../../src/core/run";
import { overrideScenario, parseScenarioYaml } from "../../src/core/scenario";
import type { EntityId, Event, Scenario } from "../../src/core/types";
import { restoreWorld } from "../../src/core/world";
import { gatewayFactory } from "../helpers/kernel";
import { builtinRegistry } from "../helpers/registry";

const ROOT = join(import.meta.dir, "../..");
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-examples-"));

const load = (name: string): Scenario => {
	const parsed = parseScenarioYaml(
		readFileSync(join(ROOT, "examples", name, "scenario.yaml"), "utf8"),
	);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};

const pdRegistry = (): Registry => {
	const registry = builtinRegistry();
	const r = register(registry);
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return registry;
};

const digestOf = (dir: string): string => {
	const log = openSqliteEventLog(eventLogPath(dir));
	try {
		return log.digest();
	} finally {
		log.close();
	}
};

const decisionsOf = (dir: string): readonly Extract<Event, { kind: "decision" }>[] => {
	const log = openSqliteEventLog(eventLogPath(dir));
	try {
		return log.query({ kind: ["decision"] }).flatMap((e) => (e.kind === "decision" ? [e] : []));
	} finally {
		log.close();
	}
};

describe("prisoners_dilemma example", () => {
	test("runs under mock with the plugin and two runs share a digest", async () => {
		const scenario = load("prisoners_dilemma");
		const a = tempDir();
		const b = tempDir();
		const opts = { providerOverride: "mock", createGateway: gatewayFactory };
		const ra = await runScenario(scenario, pdRegistry(), a, opts);
		const rb = await runScenario(scenario, pdRegistry(), b, opts);
		expect(ra.ok && ra.value.status).toBe("succeeded");
		expect(rb.ok && rb.value.status).toBe("succeeded");
		if (!ra.ok) return;
		expect(ra.value.integrity).toMatchObject({
			activated: 20,
			ok: 20,
			failed: 0,
			complete: true,
		});
		expect(ra.value.metrics.cooperationRate).toBeGreaterThanOrEqual(0);
		expect(ra.value.metrics.cooperationRate).toBeLessThanOrEqual(1);
		expect(ra.value.metrics.averagePayoff).toBeGreaterThanOrEqual(1);
		expect(digestOf(a)).toBe(digestOf(b));
		const providers = new Set(decisionsOf(a).map((d) => d.payload.provider));
		expect(providers).toEqual(new Set(["player", "opponent"]));
	});

	test("each executor owns one role and the rule opponent plays tit for tat", async () => {
		const mockPlayer = overrideScenario(
			load("prisoners_dilemma"),
			"providers.player.kind",
			"mock",
		);
		expect(mockPlayer.ok).toBe(true);
		if (!mockPlayer.ok) return;
		const out = tempDir();
		const r = await runScenario(mockPlayer.value, pdRegistry(), out, {
			createGateway: gatewayFactory,
		});
		expect(r.ok && r.value.status).toBe("succeeded");
		if (!r.ok) return;
		expect(r.value.integrity).toMatchObject({ activated: 20, ok: 20, failed: 0 });
		const decisions = decisionsOf(out);
		const byAgent = new Map<EntityId, Extract<Event, { kind: "decision" }>[]>();
		for (const d of decisions) {
			if (d.agentId === undefined) continue;
			byAgent.set(d.agentId, [...(byAgent.get(d.agentId) ?? []), d]);
		}
		expect(byAgent.size).toBe(2);
		const agents = [...byAgent.entries()];
		const opponentEntry = agents.find(([, ds]) => ds[0]?.payload.provider === "opponent");
		const playerEntry = agents.find(([, ds]) => ds[0]?.payload.provider === "player");
		expect(opponentEntry).toBeDefined();
		expect(playerEntry).toBeDefined();
		if (opponentEntry === undefined || playerEntry === undefined) return;
		const [, opponent] = opponentEntry;
		const [, player] = playerEntry;
		expect(opponent.every((d) => d.payload.provider === "opponent")).toBe(true);
		expect(player.every((d) => d.payload.provider === "player")).toBe(true);
		expect(opponent[0]?.payload.action).toBe("cooperate");
		for (let tick = 1; tick < 10; tick += 1)
			expect(opponent[tick]?.payload.action).toBe(player[tick - 1]?.payload.action);
		const snapshot = JSON.parse(
			readFileSync(join(out, CHECKPOINTS_DIR, "0", "world.json"), "utf8"),
		) as Parameters<typeof restoreWorld>[0];
		const world = restoreWorld(snapshot);
		expect(world.columns("agent").map((c) => c.name)).toContain(PD_COLUMNS.rounds);
		expect(r.value.metrics.averagePayoff).toBeGreaterThan(0);
	});
});

describe("echo_chamber example", () => {
	test("runs 15 ticks under mock with checkpoints at 5 and 10 and a stable digest", async () => {
		const scenario = load("echo_chamber");
		const a = tempDir();
		const b = tempDir();
		const opts = { providerOverride: "mock", createGateway: gatewayFactory };
		const ra = await runScenario(scenario, builtinRegistry(), a, opts);
		const rb = await runScenario(scenario, builtinRegistry(), b, opts);
		expect(ra.ok && ra.value.status).toBe("succeeded");
		if (!ra.ok || !rb.ok) return;
		expect(ra.value.integrity.complete).toBe(true);
		expect(ra.value.integrity.failed).toBe(0);
		expect(ra.value.integrity.activated).toBeGreaterThan(300);
		expect(Object.keys(ra.value.metrics).sort()).toEqual([
			"postShare",
			"sameGroupRatio",
			"stanceAssortativity",
		]);
		for (const tick of ["0", "5", "10"])
			expect(existsSync(join(a, CHECKPOINTS_DIR, tick, "meta.json"))).toBe(true);
		expect(existsSync(join(a, CHECKPOINTS_DIR, "15"))).toBe(false);
		expect(digestOf(a)).toBe(digestOf(b));
		expect(ra.value.scenarioHash).toBe(rb.value.scenarioHash);
	});

	test("rejectedActions counts the ActionRejected failures", async () => {
		const out = tempDir();
		const r = await runScenario(load("echo_chamber"), builtinRegistry(), out, {
			providerOverride: "mock",
			ticksOverride: 3,
			createGateway: gatewayFactory,
		});
		expect(r.ok && r.value.status).toBe("succeeded");
		if (!r.ok) return;
		const log = openSqliteEventLog(eventLogPath(out));
		const rejected = log
			.query({ kind: ["failure"] })
			.filter((e) => e.kind === "failure" && e.payload.excType === "ActionRejected").length;
		log.close();
		expect(r.value.integrity.rejectedActions).toBeGreaterThan(0);
		expect(r.value.integrity.rejectedActions).toBe(rejected);
		expect(r.value.integrity.complete).toBe(true);
		expect(r.value.integrity.failed).toBe(0);
		const written = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as {
			integrity: { rejectedActions: number };
		};
		expect(written.integrity.rejectedActions).toBe(rejected);
	});

	test("params drive the module options through $param refs", async () => {
		const high = overrideScenario(load("echo_chamber"), "params.homophily", "high");
		expect(high.ok).toBe(true);
		if (!high.ok) return;
		const out = tempDir();
		const r = await runScenario(high.value, builtinRegistry(), out, {
			providerOverride: "mock",
			ticksOverride: 1,
			createGateway: gatewayFactory,
		});
		expect(r.ok && r.value.status).toBe("succeeded");
		const lines = readFileSync(join(out, "log.jsonl"), "utf8")
			.split("\n")
			.filter((l) => l.includes("homophily band reached"))
			.map((l) => JSON.parse(l) as { data: { band: number[]; homophily: number } });
		expect(lines).toHaveLength(1);
		expect(lines[0]?.data.band).toEqual([0.22, 0.3]);
		expect(lines[0]?.data.homophily).toBeGreaterThanOrEqual(0.22);
	});
});
