import { z } from "zod";
import type { DecisionProvider, DuplicatePlugin, PluginFactory, Registry } from "../core/protocols";
import { parseOptions } from "../core/registry";
import { err, ok } from "../core/result";
import type { PluginSpec, Result } from "../core/types";
import { createLlmProvider } from "./llm";
import { createMockProvider } from "./mock";
import { createRuleProvider, thresholdRule, type RuleFn } from "./rule";

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
	];
	for (const [kind, factory] of factories) {
		const registered = providers.register(kind, factory);
		if (!registered.ok) return registered;
	}
	return ok(undefined);
};
