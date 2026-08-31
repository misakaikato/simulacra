import { describe, expect, test } from "bun:test";
import { resolveParamRefs, resolveScenarioParams } from "../../src/core/params";
import { overrideScenario, parseScenario } from "../../src/core/scenario";
import type { Scenario } from "../../src/core/types";

const params = { homophily: "high", p: 0.4, flag: true };

const scenarioOf = (): Scenario => {
	const parsed = parseScenario({
		scenarioId: "params",
		seed: 1,
		params,
		population: { n: 2 },
		modules: [
			{
				kind: "socialGraph",
				options: {
					homophilyBand: {
						$param: "homophily",
						map: { low: [0.02, 0.1], high: [0.22, 0.3] },
					},
					meanDegree: 3,
				},
			},
			{ kind: "calendar" },
		],
		executors: [
			{
				kind: "focal",
				options: {
					provider: "main",
					components: [{ kind: "recentMemory", options: { k: { $param: "p" } } }],
				},
			},
		],
		providers: { main: { kind: "mock", options: { on: { $param: "flag" } } } },
		policy: { kind: "bernoulli", options: { p: { $param: "p" } } },
		instruments: [{ kind: "actionShare", options: { action: { $param: "homophily" } } }],
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};

describe("resolveParamRefs", () => {
	test("replaces $param refs anywhere in a value, with optional map lookup", () => {
		const r = resolveParamRefs(
			{
				a: { $param: "p" },
				b: [1, { $param: "homophily", map: { high: "H" } }],
				c: { nested: { $param: "flag" } },
				d: "plain",
			},
			params,
		);
		expect(r).toEqual({
			ok: true,
			value: { a: 0.4, b: [1, "H"], c: { nested: true }, d: "plain" },
		});
	});

	test("reports unknown params, unmapped values and malformed refs with their path", () => {
		const unknown = resolveParamRefs({ x: { $param: "nope" } }, params);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok)
			expect(unknown.error).toEqual({
				kind: "UnknownParam",
				name: "nope",
				path: "options.x",
			});
		const unmapped = resolveParamRefs({ x: { $param: "homophily", map: { low: 1 } } }, params);
		expect(unmapped.ok).toBe(false);
		if (!unmapped.ok) expect(unmapped.error.kind).toBe("UnmappedParam");
		const malformed = resolveParamRefs([{ $param: 3 }], params);
		expect(malformed.ok).toBe(false);
		if (!malformed.ok)
			expect(malformed.error).toMatchObject({ kind: "InvalidParamRef", path: "options[0]" });
	});
});

describe("resolveScenarioParams", () => {
	test("resolves module, executor, provider, policy and instrument options", () => {
		const resolved = resolveScenarioParams(scenarioOf());
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const s = resolved.value;
		expect(s.modules[0]?.options).toEqual({ homophilyBand: [0.22, 0.3], meanDegree: 3 });
		expect(s.modules[1]).toEqual({ kind: "calendar" });
		expect(s.executors[0]?.options).toEqual({
			provider: "main",
			components: [{ kind: "recentMemory", options: { k: 0.4 } }],
		});
		expect(s.providers.main?.options).toEqual({ on: true });
		expect(s.policy.options).toEqual({ p: 0.4 });
		expect(s.instruments[0]?.options).toEqual({ action: "high" });
		expect(s.params).toEqual(params);
	});

	test("a params override changes what the options resolve to", () => {
		const overridden = overrideScenario(scenarioOf(), "params.homophily", "low");
		expect(overridden.ok).toBe(true);
		if (!overridden.ok) return;
		const resolved = resolveScenarioParams(overridden.value);
		expect(resolved.ok && resolved.value.modules[0]?.options).toEqual({
			homophilyBand: [0.02, 0.1],
			meanDegree: 3,
		});
		const broken = overrideScenario(scenarioOf(), "params.homophily", "medium");
		expect(broken.ok && resolveScenarioParams(broken.value).ok).toBe(false);
	});
});
