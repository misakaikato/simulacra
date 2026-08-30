import { z } from "zod";
import type { Component, DuplicatePlugin, Registry } from "../core/protocols";
import { parseOptions } from "../core/registry";
import { PluginSpecSchema } from "../core/schema";
import type { Result } from "../core/types";
import { createComponent } from "./components";
import { createFocalExecutor } from "./focal";

const ComponentsOptions = z.object({ components: z.array(PluginSpecSchema).default([]) });

export const registerBuiltinExecutors = (registry: Registry): Result<void, DuplicatePlugin> =>
	registry.executors.register("focal", (spec, ctx) => {
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
