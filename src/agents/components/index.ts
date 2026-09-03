// Factory for the built-in focal components: parses each component's options and injects what
// only the plugin context knows (private persona fields, the LLM gateway, the logger).
// 内置 focal 组件的工厂：解析各组件选项，并注入只有插件上下文才知道的东西
// （私有人设字段、LLM 网关、日志器）。

import { z } from "zod";
import type { Component, PluginContext, PluginError } from "../../core/protocols";
import { PERSONA_PREFIX } from "../../core/population";
import { parseOptions } from "../../core/registry";
import { err, ok } from "../../core/result";
import type { PluginSpec, Result } from "../../core/types";
import { feedObservation } from "./feedObservation";
import { instructions } from "./instructions";
import { neighborhoodObservation } from "./neighborhoodObservation";
import { persona } from "./persona";
import { recentMemory } from "./recentMemory";
import { summaryMemory } from "./summaryMemory";

export {
	feedObservation,
	instructions,
	neighborhoodObservation,
	persona,
	recentMemory,
	summaryMemory,
};
export { CONTEXT_KEYS } from "./shared";

const SLOT = "components";

const PersonaOptions = z.object({
	entity: z.string().min(1).default("agent"),
	nameField: z.string().min(1).default("name"),
});
const InstructionsOptions = z.object({ text: z.string() });
const RecentMemoryOptions = z.object({ k: z.number().int().positive().default(10) });
const SummaryMemoryOptions = z.object({
	threshold: z.number().int().positive().default(10),
	maxTokens: z.number().int().positive().optional(),
});
const FeedOptions = z.object({ size: z.number().int().positive().default(10) });
const NeighborhoodOptions = z.object({ radius: z.number().int().positive().default(1) });

export const createComponent = (
	spec: PluginSpec,
	ctx: PluginContext,
): Result<Component, PluginError> => {
	switch (spec.kind) {
		// Private population fields are hidden at construction time so the prompt can never leak
		// them, whatever columns the persona component later sees.
		// 私有人口字段在构造时就被隐藏，之后无论 persona 组件看到哪些列，prompt 都不可能泄露它们。
		case "persona": {
			const o = parseOptions(SLOT, spec, PersonaOptions);
			if (!o.ok) return o;
			return ok(
				persona({
					entity: o.value.entity,
					prefix: PERSONA_PREFIX,
					nameField: o.value.nameField,
					privateFields: ctx.scenario.population.fields
						.filter((f) => f.private === true)
						.map((f) => f.name),
				}),
			);
		}
		case "instructions": {
			const o = parseOptions(SLOT, spec, InstructionsOptions);
			return o.ok ? ok(instructions(o.value.text)) : o;
		}
		case "recentMemory": {
			const o = parseOptions(SLOT, spec, RecentMemoryOptions);
			return o.ok ? ok(recentMemory({ k: o.value.k })) : o;
		}
		case "summaryMemory": {
			const o = parseOptions(SLOT, spec, SummaryMemoryOptions);
			if (!o.ok) return o;
			return ok(
				summaryMemory(
					{
						threshold: o.value.threshold,
						...(o.value.maxTokens === undefined
							? {}
							: { maxTokens: o.value.maxTokens }),
					},
					{
						...(ctx.gateway === undefined ? {} : { gateway: ctx.gateway }),
						logger: ctx.logger,
					},
				),
			);
		}
		case "feedObservation": {
			const o = parseOptions(SLOT, spec, FeedOptions);
			return o.ok ? ok(feedObservation(o.value.size)) : o;
		}
		case "neighborhoodObservation": {
			const o = parseOptions(SLOT, spec, NeighborhoodOptions);
			return o.ok ? ok(neighborhoodObservation(o.value.radius)) : o;
		}
		default:
			return err({ reason: "unknown_kind", slot: SLOT, kind: spec.kind });
	}
};
