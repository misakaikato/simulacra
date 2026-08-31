import { z } from "zod";
import type { Adapter, DuplicatePlugin, PluginFactory, Registry } from "../core/protocols";
import { parseOptions } from "../core/registry";
import { ok } from "../core/result";
import type { Result } from "../core/types";
import { InstrumentSpecSchema } from "../core/schema";
import { OASIS_ADAPTER_KIND, createOasisAdapter } from "./oasis";
import { SCRIPT_ADAPTER_KIND, createScriptAdapter } from "./script";

export {
	OASIS_ADAPTER_KIND,
	OASIS_DB_FILE,
	OASIS_REFRESH,
	OASIS_SCENARIO_ID,
	OASIS_WORLD_FILE,
	OASIS_OUTPUT_FILES,
	createOasisAdapter,
	importOasis,
	oasisAgentId,
	oasisPostId,
	parseInfo,
	tickOf,
	traceEffects,
} from "./oasis";
export type {
	MetricRequest,
	OasisAdapterOptions,
	OasisImportOptions,
	OasisImportSummary,
} from "./oasis";
export {
	SCRIPT_ADAPTER_KIND,
	SCRIPT_CONFIG_FILE,
	SCRIPT_LOG_FILE,
	SCRIPT_RESULT_FILE,
	ScriptResultSchema,
	createScriptAdapter,
	executeScript,
	externalToScenario,
	failedScriptResult,
	readScriptResult,
	runScript,
	scriptArgv,
} from "./script";
export type { ScriptAdapterOptions, ScriptExecution, ScriptResult } from "./script";

const ScriptOptions = z.object({
	argv: z.array(z.string().min(1)).min(1),
	cwd: z.string().min(1).optional(),
	env: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

const OasisOptions = ScriptOptions.extend({
	metrics: z.array(z.union([z.string().min(1), InstrumentSpecSchema])).default([]),
	dbFile: z.string().min(1).optional(),
});

export const registerBuiltinAdapters = (registry: Registry): Result<void, DuplicatePlugin> => {
	const { adapters } = registry;
	const factories: readonly (readonly [string, PluginFactory<Adapter>])[] = [
		[
			SCRIPT_ADAPTER_KIND,
			(spec) => {
				const o = parseOptions(adapters.slot, spec, ScriptOptions);
				if (!o.ok) return o;
				return ok(createScriptAdapter({ ...o.value, name: spec.name ?? spec.kind }));
			},
		],
		[
			OASIS_ADAPTER_KIND,
			(spec, ctx) => {
				const o = parseOptions(adapters.slot, spec, OasisOptions);
				if (!o.ok) return o;
				return ok(
					createOasisAdapter({
						...o.value,
						name: spec.name ?? spec.kind,
						registry: ctx.registry,
						logger: ctx.logger,
					}),
				);
			},
		],
	];
	for (const [kind, factory] of factories) {
		const registered = adapters.register(kind, factory);
		if (!registered.ok) return registered;
	}
	return ok(undefined);
};
