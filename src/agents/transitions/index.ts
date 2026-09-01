import type { DuplicatePlugin, PluginFactory, Registry, Transition } from "../../core/protocols";
import { parseOptions } from "../../core/registry";
import { ok } from "../../core/result";
import type { Result } from "../../core/types";
import {
	OPINION_DYNAMICS_KIND,
	OpinionDynamicsOptionsSchema,
	opinionDynamics,
} from "./opinionDynamics";

export {
	OPINION_DYNAMICS_KIND,
	OpinionDynamicsOptionsSchema,
	opinionDynamics,
	type OpinionDynamicsOptions,
} from "./opinionDynamics";

export const registerBuiltinTransitions = (registry: Registry): Result<void, DuplicatePlugin> => {
	const { transitions } = registry;
	const factories: readonly (readonly [string, PluginFactory<Transition>])[] = [
		[
			OPINION_DYNAMICS_KIND,
			(spec) => {
				const o = parseOptions(transitions.slot, spec, OpinionDynamicsOptionsSchema);
				return o.ok ? ok(opinionDynamics(o.value)) : o;
			},
		],
	];
	for (const [kind, factory] of factories) {
		const registered = transitions.register(kind, factory);
		if (!registered.ok) return registered;
	}
	return ok(undefined);
};
