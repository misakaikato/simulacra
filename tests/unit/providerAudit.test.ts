import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";
import { RESULT_FILE, runScenario } from "../../src/core/run";
import { PROVIDER_INSTRUMENT_PREFIX, PROVIDER_METRIC_PREFIX } from "../../src/core/simulation";
import type { Event, JsonObject, RunResult, Scenario } from "../../src/core/types";
import { gatewayFactory, kernelRegistry, kernelScenario } from "../helpers/kernel";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-provider-audit-"));
const TICKS = 3;

type Measurement = Extract<Event, { kind: "measurement" }>;

const population: JsonObject = {
	n: 12,
	fields: [
		{ name: "group", dtype: "str", sampling: { kind: "choice", choices: ["a", "b", "c"] } },
		{ name: "mood", dtype: "f64", sampling: { kind: "range", min: 0, max: 1 } },
	],
};

const scenario = (providers: JsonObject, provider: string, overrides: JsonObject = {}): Scenario =>
	kernelScenario({
		population,
		executors: [
			{
				kind: "focal",
				name: "people",
				options: { provider, components: [{ kind: "persona" }] },
			},
		],
		providers,
		steps: [{ kind: "run", ticks: TICKS }],
		...overrides,
	});

const providerMeasurements = (dir: string): readonly Measurement[] => {
	const log = openSqliteEventLog(eventLogPath(dir));
	try {
		return log
			.query({ kind: ["measurement"] })
			.flatMap((e) =>
				e.kind === "measurement" &&
				e.payload.instrument.startsWith(PROVIDER_INSTRUMENT_PREFIX)
					? [e]
					: [],
			);
	} finally {
		log.close();
	}
};

const lastValue = (s: readonly Measurement[]): number | undefined => {
	const v = s.at(-1)?.payload.value;
	return typeof v === "number" ? v : undefined;
};

const readResult = (dir: string): RunResult =>
	JSON.parse(readFileSync(join(dir, RESULT_FILE), "utf8")) as RunResult;

const run = (s: Scenario, out: string) =>
	runScenario(s, kernelRegistry().registry, out, { createGateway: gatewayFactory });

describe("provider audit measurements", () => {
	test("archetype over cache over mock: each participant reports every tick and metrics keep the last value", async () => {
		const out = tempDir();
		const r = await run(
			scenario(
				{
					arch: {
						kind: "archetype",
						options: { downstream: "cached", groupOn: ["persona.group"], nArch: 2 },
					},
					cached: { kind: "cache", options: { downstream: "main" } },
					main: { kind: "mock" },
					idle: { kind: "cache", options: { downstream: "main" } },
				},
				"arch",
			),
			out,
		);
		expect(r.ok && r.value.status).toBe("succeeded");
		if (!r.ok) return;
		expect(r.value.integrity.complete).toBe(true);
		const events = providerMeasurements(out);
		expect(new Set(events.map((e) => e.payload.instrument))).toEqual(
			new Set([`${PROVIDER_INSTRUMENT_PREFIX}arch`, `${PROVIDER_INSTRUMENT_PREFIX}cached`]),
		);
		const series = (instrument: string, name: string): readonly Measurement[] =>
			events.filter(
				(e) =>
					e.payload.instrument === `${PROVIDER_INSTRUMENT_PREFIX}${instrument}` &&
					e.payload.name === name,
			);
		for (const [instrument, name] of [
			["cached", "hitRate"],
			["cached", "hits"],
			["cached", "misses"],
			["arch", "calls"],
			["arch", "groups"],
		] as const) {
			const s = series(instrument, name);
			expect(s.map((e) => e.t.tick)).toEqual([0, 1, 2]);
			expect(s.every((e) => typeof e.payload.value === "number")).toBe(true);
		}
		expect(events.every((e) => e.provenance === "kernel" && e.parent !== undefined)).toBe(true);

		const metrics = r.value.metrics;
		const hitRate = metrics[`${PROVIDER_METRIC_PREFIX}cached.hitRate`];
		expect(hitRate).toBeGreaterThan(0);
		expect(hitRate).toBeLessThanOrEqual(1);
		const lastHitRate = lastValue(series("cached", "hitRate"));
		expect(hitRate).toBe(lastHitRate);
		expect(metrics[`${PROVIDER_METRIC_PREFIX}arch.calls`]).toBe(
			lastValue(series("arch", "calls")),
		);
		expect(metrics[`${PROVIDER_METRIC_PREFIX}arch.groups`]).toBeGreaterThanOrEqual(1);
		expect(metrics[`${PROVIDER_METRIC_PREFIX}arch.groups`]).toBeLessThanOrEqual(3);
		expect(
			Object.keys(metrics).some((k) => k.startsWith(`${PROVIDER_METRIC_PREFIX}idle.`)),
		).toBe(false);
		expect(metrics.scoreSum).toBeDefined();
		expect(readResult(out).metrics[`${PROVIDER_METRIC_PREFIX}cached.hitRate`]).toBe(hitRate);
	});

	test("a provider without audit() adds nothing, and a tick without decisions audits nobody", async () => {
		const plain = tempDir();
		const r = await run(scenario({ main: { kind: "mock" } }, "main"), plain);
		expect(r.ok && r.value.status).toBe("succeeded");
		expect(providerMeasurements(plain)).toHaveLength(0);
		if (r.ok)
			expect(
				Object.keys(r.value.metrics).filter((k) => k.startsWith(PROVIDER_METRIC_PREFIX)),
			).toEqual([]);

		const nobody = tempDir();
		const idle = await run(
			scenario(
				{
					cached: { kind: "cache", options: { downstream: "main" } },
					main: { kind: "mock" },
				},
				"cached",
				{ policy: { kind: "bernoulli", options: { p: 0 } } },
			),
			nobody,
		);
		expect(idle.ok && idle.value.status).toBe("succeeded");
		expect(idle.ok && idle.value.integrity.activated).toBe(0);
		expect(providerMeasurements(nobody)).toHaveLength(0);
	});
});
