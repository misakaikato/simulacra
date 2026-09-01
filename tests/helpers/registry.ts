import { registerBuiltinExecutors, registerBuiltinTransitions } from "../../src/agents";
import type { Registry } from "../../src/core/protocols";
import { createRegistry } from "../../src/core/registry";
import { registerBuiltinMetrics } from "../../src/metrics";
import { registerBuiltinModules } from "../../src/modules";
import { registerBuiltinPolicies } from "../../src/policies";
import { registerBuiltinProviders } from "../../src/providers";

export const builtinRegistry = (): Registry => {
	const registry = createRegistry();
	const results = [
		registerBuiltinPolicies(registry),
		registerBuiltinProviders(registry),
		registerBuiltinTransitions(registry),
		registerBuiltinExecutors(registry),
		registerBuiltinModules(registry),
		registerBuiltinMetrics(registry),
	];
	for (const r of results) if (!r.ok) throw new Error(JSON.stringify(r.error));
	return registry;
};
