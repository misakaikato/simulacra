// Registration entry for the built-in executors: `focal` assembles its component list here so
// component construction errors surface at plugin creation, `cohort` delegates to its factory.
// 内置执行体的注册入口：`focal` 在此组装组件列表，组件构造错误在插件创建时就暴露；
// `cohort` 直接交给自己的工厂。

import { z } from "zod";
import type { Component, DuplicatePlugin, Registry } from "../core/protocols";
import { parseOptions } from "../core/registry";
import { PluginSpecSchema } from "../core/schema";
import type { Result } from "../core/types";
import { COHORT_KIND, createCohortExecutor } from "./cohort";
import { createComponent } from "./components";
import { createFocalExecutor } from "./focal";

export {
	COHORT_KIND,
	CohortOptionsSchema,
	columnStats,
	createCohortExecutor,
	zScore,
} from "./cohort";
export { registerBuiltinTransitions } from "./transitions";
export { WhereSchema, matchesWhere, type Where } from "./where";

const ComponentsOptions = z.object({ components: z.array(PluginSpecSchema).default([]) });

export const registerBuiltinExecutors = (registry: Registry): Result<void, DuplicatePlugin> => {
	const focal = registry.executors.register("focal", (spec, ctx) => {
		const o = parseOptions(registry.executors.slot, spec, ComponentsOptions);
		if (!o.ok) return o;
		const components: Component[] = [];
		for (const componentSpec of o.value.components) {
			const created = createComponent(componentSpec, ctx);
			if (!created.ok) return created;
			components.push(created.value);
		}
		return createFocalExecutor(spec, ctx, components);
	});
	if (!focal.ok) return focal;
	return registry.executors.register(COHORT_KIND, createCohortExecutor);
};
