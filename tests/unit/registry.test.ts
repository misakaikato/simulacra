import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Metric, PluginContext } from "../../src/core/protocols";
import { createRegistry, parseOptions } from "../../src/core/registry";
import { ok } from "../../src/core/result";
import { parseScenario } from "../../src/core/scenario";
import { silentLogger } from "../../src/logging/logger";

const scenario = () => {
	const r = parseScenario({ scenarioId: "s", seed: 1, population: { n: 1 } });
	if (!r.ok) throw new Error("scenario");
	return r.value;
};

const constantMetric = (value: number): Metric => ({ name: "constant", compute: () => value });

describe("Registry", () => {
	test("createRegistry exposes every slot with its name", () => {
		const registry = createRegistry();
		expect(registry.executors.slot).toBe("executors");
		expect(registry.modules.slot).toBe("modules");
		expect(registry.providers.slot).toBe("providers");
		expect(registry.policies.slot).toBe("policies");
		expect(registry.metrics.slot).toBe("metrics");
		expect(registry.adapters.slot).toBe("adapters");
		expect(registry.actions.names()).toEqual([]);
	});

	test("registers factories by kind and creates instances from specs", () => {
		const registry = createRegistry();
		const ctx: PluginContext = { scenario: scenario(), registry, logger: silentLogger };
		const Options = z.object({ value: z.number().default(1) });
		const registered = registry.metrics.register("constant", (spec) => {
			const o = parseOptions("metrics", spec, Options);
			return o.ok ? ok(constantMetric(o.value.value)) : o;
		});
		expect(registered.ok).toBe(true);
		expect(registry.metrics.has("constant")).toBe(true);
		expect(registry.metrics.kinds()).toEqual(["constant"]);
		expect(typeof registry.metrics.get("constant")).toBe("function");
		const created = registry.metrics.create({ kind: "constant", options: { value: 4 } }, ctx);
		expect(created.ok).toBe(true);
		if (created.ok) expect(created.value.compute).toBeDefined();
		const defaulted = registry.metrics.create({ kind: "constant" }, ctx);
		expect(defaulted.ok).toBe(true);
	});

	test("reports duplicate kinds, unknown kinds and invalid options", () => {
		const registry = createRegistry();
		const ctx: PluginContext = { scenario: scenario(), registry, logger: silentLogger };
		registry.metrics.register("m", () => ok(constantMetric(0)));
		expect(registry.metrics.register("m", () => ok(constantMetric(1)))).toEqual({
			ok: false,
			error: { kind: "DuplicatePlugin", slot: "metrics", pluginKind: "m" },
		});
		expect(registry.metrics.create({ kind: "ghost" }, ctx)).toEqual({
			ok: false,
			error: { reason: "unknown_kind", slot: "metrics", kind: "ghost" },
		});
		const invalid = parseOptions(
			"metrics",
			{ kind: "m", options: { value: "x" } },
			z.object({ value: z.number() }),
		);
		expect(invalid.ok).toBe(false);
		if (!invalid.ok && invalid.error.reason === "invalid_options") {
			expect(invalid.error.kind).toBe("m");
			expect(invalid.error.issues[0]).toMatch(/^value: /);
		}
	});
});
