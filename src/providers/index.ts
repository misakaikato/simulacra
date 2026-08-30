import { z } from "zod";
import type {
	DecisionProvider,
	DuplicatePlugin,
	LLMGateway,
	PluginContext,
	PluginFactory,
	Registry,
} from "../core/protocols";
import { parseOptions } from "../core/registry";
import { err, ok } from "../core/result";
import type { PluginSpec, Result } from "../core/types";
import { createGateway } from "../llm/gateway";
import { createLlmProvider } from "./llm";
import { createMockProvider } from "./mock";
import { createRuleProvider, type RuleFn } from "./rule";

export interface ProviderDeps {
	readonly rules?: Readonly<Record<string, RuleFn>>;
}

const LlmOptions = z.object({
	temperature: z.number().min(0).default(0),
	maxTokens: z.number().int().positive().optional(),
	homogeneousGuard: z.boolean().default(true),
	purpose: z.string().min(1).default("decision"),
});

const RuleOptions = z.object({ rule: z.string().min(1) });

const nameOf = (spec: PluginSpec): string => spec.name ?? spec.kind;

const gatewayFor = (ctx: PluginContext): Result<LLMGateway, string> => {
	if (ctx.gateway !== undefined) return ok(ctx.gateway);
	try {
		return ok(createGateway(ctx.scenario.llm, { logger: ctx.logger }));
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
};

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
			"llm",
			(spec, ctx) => {
				const o = parseOptions(providers.slot, spec, LlmOptions);
				if (!o.ok) return o;
				const gateway = gatewayFor(ctx);
				if (!gateway.ok)
					return err({
						reason: "construct_failed",
						slot: providers.slot,
						kind: spec.kind,
						message: gateway.error,
					});
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
						{ gateway: gateway.value, logger: ctx.logger },
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
