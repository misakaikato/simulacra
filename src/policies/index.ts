import { z } from "zod";
import type {
	ActivationPolicy,
	DuplicatePlugin,
	PluginFactory,
	Registry,
	Rng,
	WorldView,
} from "../core/protocols";
import { parseOptions } from "../core/registry";
import { ok } from "../core/result";
import type {
	Activation,
	ActivationMode,
	EntityId,
	LogicalTime,
	Result,
	Scalar,
} from "../core/types";

const MODES: readonly ActivationMode[] = ["llm", "rule", "manual", "interview"];
const ModeSchema = z.enum(MODES);
const HOURS_PER_DAY = 24;

export interface PolicyOptions {
	readonly entity?: string;
	readonly mode?: ActivationMode;
}

const activationOf = (ids: readonly EntityId[], mode: ActivationMode): Activation => {
	const agents: Record<EntityId, ActivationMode> = {};
	for (const id of ids) agents[id] = mode;
	return { agents };
};

export const allAgents = (opts: PolicyOptions = {}): ActivationPolicy => ({
	name: "allAgents",
	select: (world) => activationOf(world.ids(opts.entity ?? "agent"), opts.mode ?? "llm"),
});

export const bernoulli = (p: number, opts: PolicyOptions = {}): ActivationPolicy => ({
	name: "bernoulli",
	select: (world, _t, rng) =>
		activationOf(
			world.ids(opts.entity ?? "agent").filter(() => rng.bernoulli(p)),
			opts.mode ?? "llm",
		),
});

const hourlyProbability = (profile: Scalar, hour: number): number => {
	if (typeof profile === "number") return profile;
	if (Array.isArray(profile)) {
		const p = Number(profile[hour % profile.length] ?? 0);
		return Number.isFinite(p) ? p : 0;
	}
	return 0;
};

export const profileHourly = (
	column: string,
	opts: PolicyOptions & { readonly ticksPerHour?: number } = {},
): ActivationPolicy => ({
	name: "profileHourly",
	select: (world: WorldView, t: LogicalTime, rng: Rng) => {
		const entity = opts.entity ?? "agent";
		const hour = Math.floor(t.tick / (opts.ticksPerHour ?? 1)) % HOURS_PER_DAY;
		const profiles = world.column<Scalar>(entity, column);
		const ids = world
			.ids(entity)
			.filter((_, i) => rng.bernoulli(hourlyProbability(profiles.at(i), hour)));
		return activationOf(ids, opts.mode ?? "llm");
	},
});

export const maskTimer = (
	maskColumn: string,
	timerColumn: string,
	opts: PolicyOptions = {},
): ActivationPolicy => ({
	name: "maskTimer",
	select: (world, t) => {
		const entity = opts.entity ?? "agent";
		const mask = world.column<boolean>(entity, maskColumn);
		const timer = world.column<number>(entity, timerColumn);
		const ids = world.ids(entity).filter((_, i) => mask.at(i) && timer.at(i) <= t.tick);
		return activationOf(ids, opts.mode ?? "llm");
	},
});

export type ExplicitSchedule = Readonly<Record<string, readonly EntityId[]>>;

export const explicit = (
	schedule: ExplicitSchedule,
	opts: PolicyOptions = {},
): ActivationPolicy => ({
	name: "explicit",
	select: (_world, t) => activationOf(schedule[String(t.tick)] ?? [], opts.mode ?? "llm"),
});

const CommonOptions = z.object({
	entity: z.string().min(1).optional(),
	mode: ModeSchema.optional(),
});

const stripUndefined = (o: {
	entity?: string | undefined;
	mode?: ActivationMode | undefined;
}): PolicyOptions => ({
	...(o.entity === undefined ? {} : { entity: o.entity }),
	...(o.mode === undefined ? {} : { mode: o.mode }),
});

export const registerBuiltinPolicies = (registry: Registry): Result<void, DuplicatePlugin> => {
	const { policies } = registry;
	const factories: readonly (readonly [string, PluginFactory<ActivationPolicy>])[] = [
		[
			"allAgents",
			(spec) => {
				const o = parseOptions(policies.slot, spec, CommonOptions);
				return o.ok ? ok(allAgents(stripUndefined(o.value))) : o;
			},
		],
		[
			"bernoulli",
			(spec) => {
				const o = parseOptions(
					policies.slot,
					spec,
					CommonOptions.extend({ p: z.number().min(0).max(1) }),
				);
				return o.ok ? ok(bernoulli(o.value.p, stripUndefined(o.value))) : o;
			},
		],
		[
			"profileHourly",
			(spec) => {
				const o = parseOptions(
					policies.slot,
					spec,
					CommonOptions.extend({
						column: z.string().min(1),
						ticksPerHour: z.number().int().positive().optional(),
					}),
				);
				if (!o.ok) return o;
				const base = stripUndefined(o.value);
				return ok(
					profileHourly(
						o.value.column,
						o.value.ticksPerHour === undefined
							? base
							: { ...base, ticksPerHour: o.value.ticksPerHour },
					),
				);
			},
		],
		[
			"maskTimer",
			(spec) => {
				const o = parseOptions(
					policies.slot,
					spec,
					CommonOptions.extend({
						maskColumn: z.string().min(1),
						timerColumn: z.string().min(1),
					}),
				);
				return o.ok
					? ok(
							maskTimer(
								o.value.maskColumn,
								o.value.timerColumn,
								stripUndefined(o.value),
							),
						)
					: o;
			},
		],
		[
			"explicit",
			(spec) => {
				const o = parseOptions(
					policies.slot,
					spec,
					CommonOptions.extend({ schedule: z.record(z.string(), z.array(z.string())) }),
				);
				if (!o.ok) return o;
				const schedule: Record<string, readonly EntityId[]> = {};
				for (const [tick, ids] of Object.entries(o.value.schedule))
					schedule[tick] = ids.map((id) => id as EntityId);
				return ok(explicit(schedule, stripUndefined(o.value)));
			},
		],
	];
	for (const [kind, factory] of factories) {
		const registered = policies.register(kind, factory);
		if (!registered.ok) return registered;
	}
	return ok(undefined);
};
