import { describe, expect, test } from "bun:test";
import type { PluginContext } from "../../src/core/protocols";
import { createRegistry } from "../../src/core/registry";
import { rngFromSeed } from "../../src/core/rng";
import { parseScenario } from "../../src/core/scenario";
import { timeAt } from "../../src/core/time";
import type { ColumnDecl, EntityId } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { silentLogger } from "../../src/logging/logger";
import {
	allAgents,
	bernoulli,
	explicit,
	maskTimer,
	profileHourly,
	registerBuiltinPolicies,
} from "../../src/policies";

const decls: ColumnDecl[] = [
	{
		entity: "agent",
		name: "mask",
		dtype: "bool",
		default: false,
		owner: "kernel",
		merge: "last",
	},
	{ entity: "agent", name: "timer", dtype: "i32", default: 0, owner: "kernel", merge: "last" },
	{
		entity: "agent",
		name: "hours",
		dtype: "strlist",
		default: [],
		owner: "kernel",
		merge: "last",
	},
	{ entity: "agent", name: "rate", dtype: "f64", default: 0, owner: "kernel", merge: "last" },
];

const setup = () => {
	const world = createWorld();
	for (const d of decls) {
		const r = world.declare(d);
		if (!r.ok) throw new Error(r.error.message);
	}
	const alwaysOn = Array.from({ length: 24 }, () => "1");
	const nightOnly = Array.from({ length: 24 }, (_, h) => (h >= 22 ? "1" : "0"));
	const ids = world.create(
		"agent",
		[
			{ mask: true, timer: 0, hours: alwaysOn, rate: 1 },
			{ mask: true, timer: 5, hours: nightOnly, rate: 0 },
			{ mask: false, timer: 0, hours: alwaysOn, rate: 1 },
			{ mask: true, timer: 2, hours: [], rate: 0.5 },
		],
		rngFromSeed(1, []),
	);
	return { world, ids: ids as readonly EntityId[] };
};

const activated = (agents: Readonly<Record<EntityId, string>>): readonly string[] =>
	Object.keys(agents);

describe("built-in activation policies", () => {
	test("allAgents activates every agent in llm mode", () => {
		const { world, ids } = setup();
		const activation = allAgents().select(world, timeAt(0), rngFromSeed(1, []));
		expect(activated(activation.agents)).toEqual(ids);
		expect(Object.values(activation.agents)).toEqual(["llm", "llm", "llm", "llm"]);
		expect(
			activated(
				allAgents({ mode: "rule", entity: "ghost" }).select(
					world,
					timeAt(0),
					rngFromSeed(1, []),
				).agents,
			),
		).toEqual([]);
	});

	test("bernoulli is reproducible for the same seed and calibrated in the long run", () => {
		const { world } = setup();
		const policy = bernoulli(0.5);
		const a = policy.select(world, timeAt(3), rngFromSeed(9, [3]));
		const b = policy.select(world, timeAt(3), rngFromSeed(9, [3]));
		expect(activated(a.agents)).toEqual(activated(b.agents));
		expect(activated(bernoulli(0).select(world, timeAt(0), rngFromSeed(1, [])).agents)).toEqual(
			[],
		);
		expect(
			activated(bernoulli(1).select(world, timeAt(0), rngFromSeed(1, [])).agents),
		).toHaveLength(4);
		let total = 0;
		const rng = rngFromSeed(2, []);
		for (let tick = 0; tick < 2000; tick += 1)
			total += activated(
				bernoulli(0.25).select(world, timeAt(tick), rng.fork(tick)).agents,
			).length;
		expect(Math.abs(total / (2000 * 4) - 0.25)).toBeLessThan(0.02);
	});

	test("profileHourly reads the 24-entry profile by hour of tick", () => {
		const { world, ids } = setup();
		const policy = profileHourly("hours");
		const noon = policy.select(world, timeAt(12), rngFromSeed(1, []));
		expect(activated(noon.agents)).toEqual([ids[0]!, ids[2]!]);
		const night = policy.select(world, timeAt(23), rngFromSeed(1, []));
		expect(activated(night.agents)).toEqual([ids[0]!, ids[1]!, ids[2]!]);
		const scaled = profileHourly("hours", { ticksPerHour: 2 }).select(
			world,
			timeAt(47),
			rngFromSeed(1, []),
		);
		expect(activated(scaled.agents)).toEqual([ids[0]!, ids[1]!, ids[2]!]);
		const constant = profileHourly("rate").select(world, timeAt(0), rngFromSeed(1, []));
		expect(activated(constant.agents)).toContain(ids[0]!);
		expect(activated(constant.agents)).not.toContain(ids[1]!);
	});

	test("maskTimer activates masked agents whose timer has elapsed", () => {
		const { world, ids } = setup();
		const policy = maskTimer("mask", "timer");
		expect(activated(policy.select(world, timeAt(0), rngFromSeed(1, [])).agents)).toEqual([
			ids[0]!,
		]);
		expect(activated(policy.select(world, timeAt(2), rngFromSeed(1, [])).agents)).toEqual([
			ids[0]!,
			ids[3]!,
		]);
		expect(activated(policy.select(world, timeAt(9), rngFromSeed(1, [])).agents)).toEqual([
			ids[0]!,
			ids[1]!,
			ids[3]!,
		]);
	});

	test("explicit follows the schedule and is empty elsewhere", () => {
		const { world, ids } = setup();
		const policy = explicit({ "1": [ids[2]!], "3": [ids[0]!, ids[1]!] }, { mode: "manual" });
		expect(policy.select(world, timeAt(0), rngFromSeed(1, [])).agents).toEqual({});
		expect(policy.select(world, timeAt(1), rngFromSeed(1, [])).agents).toEqual({
			[ids[2]!]: "manual",
		});
		expect(activated(policy.select(world, timeAt(3), rngFromSeed(1, [])).agents)).toEqual([
			ids[0]!,
			ids[1]!,
		]);
	});
});

describe("registerBuiltinPolicies", () => {
	test("registers the five kinds and builds them from spec options", () => {
		const registry = createRegistry();
		registerBuiltinPolicies(registry);
		expect(registry.policies.kinds()).toEqual([
			"allAgents",
			"bernoulli",
			"profileHourly",
			"maskTimer",
			"explicit",
		]);
		const parsed = parseScenario({ scenarioId: "s", seed: 1, population: { n: 1 } });
		if (!parsed.ok) throw new Error("scenario");
		const ctx: PluginContext = { scenario: parsed.value, registry, logger: silentLogger };
		const { world, ids } = setup();
		const built = registry.policies.create(
			{ kind: "bernoulli", options: { p: 1, mode: "rule" } },
			ctx,
		);
		expect(built.ok).toBe(true);
		if (built.ok) {
			const activation = built.value.select(world, timeAt(0), rngFromSeed(1, []));
			expect(Object.values(activation.agents)).toEqual(["rule", "rule", "rule", "rule"]);
		}
		const bad = registry.policies.create({ kind: "bernoulli", options: { p: 2 } }, ctx);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error.reason).toBe("invalid_options");
		const timer = registry.policies.create(
			{ kind: "maskTimer", options: { maskColumn: "mask", timerColumn: "timer" } },
			ctx,
		);
		expect(
			timer.ok && activated(timer.value.select(world, timeAt(0), rngFromSeed(1, [])).agents),
		).toEqual([ids[0]!]);
		const sched = registry.policies.create(
			{ kind: "explicit", options: { schedule: { "2": [ids[1]!] } } },
			ctx,
		);
		expect(
			sched.ok && activated(sched.value.select(world, timeAt(2), rngFromSeed(1, [])).agents),
		).toEqual([ids[1]!]);
		const hourly = registry.policies.create(
			{ kind: "profileHourly", options: { column: "hours", ticksPerHour: 2 } },
			ctx,
		);
		expect(hourly.ok).toBe(true);
		expect(registry.policies.create({ kind: "allAgents" }, ctx).ok).toBe(true);
	});
});
