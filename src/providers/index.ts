// Registration entry for the built-in decision providers: parses each provider's options,
// resolves composite providers' downstreams by name through the plugin context (which detects
// cycles at assembly time) and injects scenario-level defaults such as the token budget.
// 内置决策提供者的注册入口：解析各提供者选项，组合器的下游按名字经插件上下文解析
// （装配期在那里检测循环引用），并注入 token 预算等场景级默认值。

import { z } from "zod";
import { PERSONA_PREFIX } from "../core/population";
import type {
	DecisionProvider,
	DuplicatePlugin,
	PluginContext,
	PluginError,
	PluginFactory,
	Registry,
} from "../core/protocols";
import { parseOptions } from "../core/registry";
import { err, ok } from "../core/result";
import type { PluginSpec, Result } from "../core/types";
import { ARCHETYPE_KIND, ArchetypeOptionsSchema, createArchetypeProvider } from "./archetype";
import { CACHE_KIND, CacheOptionsSchema, createCacheProvider } from "./cache";
import { createLlmProvider } from "./llm";
import { createMockProvider } from "./mock";
import { APS_KIND, ApsOptionsSchema, createApsProvider } from "./routers/aps";
import { TOPO_KIND, TopoOptionsSchema, createTopoProvider } from "./routers/topo";
import { createRuleProvider, thresholdRule, type RuleFn } from "./rule";
import { SURROGATE_KIND, SurrogateOptionsSchema, createSurrogateProvider } from "./surrogate";

export interface ProviderDeps {
	readonly rules?: Readonly<Record<string, RuleFn>>;
}

export const COHORT_RULE_KIND = "cohortRule";

const LlmOptions = z.object({
	temperature: z.number().min(0).default(0),
	maxTokens: z.number().int().positive().optional(),
	homogeneousGuard: z.boolean().default(true),
	purpose: z.string().min(1).default("decision"),
});

const RuleOptions = z.object({ rule: z.string().min(1) });

export const CohortRuleOptionsSchema = z.object({
	feature: z.number().int().nonnegative().default(0),
	threshold: z.number().default(0),
	above: z.string().min(1).default("post"),
	below: z.string().min(1).default("silent"),
});

const nameOf = (spec: PluginSpec): string => spec.name ?? spec.kind;

// Composite providers hold their downstream by name and resolve it through the context.
// 组合器只持有下游的名字，通过上下文解析成实例。
export const downstreamOf = (
	slot: string,
	spec: PluginSpec,
	ctx: PluginContext,
	name: string,
): Result<DecisionProvider, PluginError> => {
	if (ctx.provider === undefined)
		return err({
			reason: "construct_failed",
			slot,
			kind: spec.kind,
			message: `provider '${nameOf(spec)}' needs a provider resolver to reach downstream '${name}'`,
		});
	return ctx.provider(name);
};

// groupOn is checked against the population's declared fields at construction so a misspelt
// column fails assembly once instead of failing every decision round.
// groupOn 在构造时就对照人口声明的字段校验，拼错的列名在装配期失败一次，
// 而不是每轮决策都失败。
const personaColumnsMissing = (
	columns: readonly string[],
	ctx: PluginContext,
): readonly string[] => {
	const declared = new Set(
		ctx.scenario.population.fields.map((f) => `${PERSONA_PREFIX}${f.name}`),
	);
	return columns.filter((c) => c.startsWith(PERSONA_PREFIX) && !declared.has(c));
};

// `llm` falls back to the scenario's maxCompletionTokens budget when no maxTokens is given, so a
// provider can never ask for more than the run is allowed to spend per call.
// `llm` 未指定 maxTokens 时回退到场景的 maxCompletionTokens 预算，
// 提供者单次调用永远不会超出运行允许的上限。
export const registerBuiltinProviders = (
	registry: Registry,
	deps: ProviderDeps = {},
): Result<void, DuplicatePlugin> => {
	const { providers } = registry;
	const factories: readonly (readonly [string, PluginFactory<DecisionProvider>])[] = [
		["mock", (spec) => ok(createMockProvider(registry.actions, nameOf(spec)))],
		[
			"rule",
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, RuleOptions);
				if (!o.ok) return o;
				const rule = deps.rules?.[o.value.rule];
				if (rule === undefined)
					return err({
						reason: "construct_failed",
						slot: providers.slot,
						kind: spec.kind,
						message: `rule '${o.value.rule}' is not registered`,
					});
				return ok(
					createRuleProvider({ name: nameOf(spec), seed: ctx.scenario.seed, rule }),
				);
			},
		],
		[
			COHORT_RULE_KIND,
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, CohortRuleOptionsSchema);
				if (!o.ok) return o;
				return ok(
					createRuleProvider({
						name: nameOf(spec),
						seed: ctx.scenario.seed,
						rule: thresholdRule(o.value),
					}),
				);
			},
		],
		[
			"llm",
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, LlmOptions);
				if (!o.ok) return o;
				return ok(
					createLlmProvider(
						{
							name: nameOf(spec),
							seed: ctx.scenario.seed,
							temperature: o.value.temperature,
							maxTokens:
								o.value.maxTokens ?? ctx.scenario.llm.budget.maxCompletionTokens,
							homogeneousGuard: o.value.homogeneousGuard,
							purpose: o.value.purpose,
						},
						{
							...(ctx.gateway === undefined ? {} : { gateway: ctx.gateway }),
							logger: ctx.logger,
						},
					),
				);
			},
		],
		[
			ARCHETYPE_KIND,
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, ArchetypeOptionsSchema);
				if (!o.ok) return o;
				const missing = personaColumnsMissing(o.value.groupOn, ctx);
				if (missing.length > 0)
					return err({
						reason: "invalid_options",
						slot: providers.slot,
						kind: spec.kind,
						issues: [`groupOn: unknown persona column(s) ${missing.join(", ")}`],
					});
				const downstream = downstreamOf(providers.slot, spec, ctx, o.value.downstream);
				if (!downstream.ok) return downstream;
				return ok(
					createArchetypeProvider(
						{
							name: nameOf(spec),
							seed: ctx.scenario.seed,
							groupOn: o.value.groupOn,
							nArch: o.value.nArch,
							privateFields: ctx.scenario.population.fields
								.filter((f) => f.private === true)
								.map((f) => f.name),
						},
						downstream.value,
						ctx.logger,
					),
				);
			},
		],
		[
			SURROGATE_KIND,
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, SurrogateOptionsSchema);
				if (!o.ok) return o;
				return ok(
					createSurrogateProvider({
						name: nameOf(spec),
						seed: ctx.scenario.seed,
						...o.value,
					}),
				);
			},
		],
		[
			CACHE_KIND,
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, CacheOptionsSchema);
				if (!o.ok) return o;
				const downstream = downstreamOf(providers.slot, spec, ctx, o.value.downstream);
				if (!downstream.ok) return downstream;
				return ok(
					createCacheProvider(
						{
							name: nameOf(spec),
							...(o.value.keyFields === undefined
								? {}
								: { keyFields: o.value.keyFields }),
						},
						downstream.value,
					),
				);
			},
		],
		[
			TOPO_KIND,
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, TopoOptionsSchema);
				if (!o.ok) return o;
				const downstream = downstreamOf(providers.slot, spec, ctx, o.value.downstream);
				if (!downstream.ok) return downstream;
				const { downstream: _name, stubbornnessColumn, ...rest } = o.value;
				return ok(
					createTopoProvider(
						{
							name: nameOf(spec),
							...rest,
							...(stubbornnessColumn === undefined ? {} : { stubbornnessColumn }),
						},
						downstream.value,
						ctx.logger,
					),
				);
			},
		],
		[
			APS_KIND,
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, ApsOptionsSchema);
				if (!o.ok) return o;
				const downstream = downstreamOf(providers.slot, spec, ctx, o.value.downstream);
				if (!downstream.ok) return downstream;
				const { downstream: _name, ...rest } = o.value;
				return ok(
					createApsProvider(
						{ name: nameOf(spec), seed: ctx.scenario.seed, ...rest },
						downstream.value,
						ctx.logger,
					),
				);
			},
		],
	];
	for (const [kind, factory] of factories) {
		const registered = providers.register(kind, factory);
		if (!registered.ok) return registered;
	}
	return ok(undefined);
};
