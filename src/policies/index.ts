// Built-in activation policies: each tick they decide which agents act and in which mode
// (llm/rule/manual/interview) from the world and the tick rng alone, so activation is
// reproducible and the kernel can override it per step without touching the policy.
// 内置激活策略：每 tick 只凭世界状态与本 tick 的 rng 决定哪些 agent 行动、以何种模式
// （llm/rule/manual/interview），激活因此可复现，内核也能按步覆盖而不必改策略。

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

// A profile cell is either one probability for every hour or a list indexed by the hour of
// the logical day (modulo its length); anything else activates nobody rather than everybody.
// 人口列的一个单元要么是所有小时共用的概率，要么是按逻辑日小时（对长度取模）索引的列表；
// 其它形态一律不激活任何人，而不是激活所有人。
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

// maskTimer activates rows whose mask is set and whose timer has come due, letting a module or
// intervention schedule agents by writing two columns instead of a policy.
// maskTimer 激活掩码为真且计时器到期的行，模块或干预只需写两列就能调度 agent，无需自定义策略。
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

// Factories strip undefined option keys so the policies' `opts` objects satisfy
// exactOptionalPropertyTypes and default resolution stays in one place (`?? "agent"`, `?? "llm"`).
// 工厂剔除值为 undefined 的选项键，策略的 `opts` 满足 exactOptionalPropertyTypes，
// 默认值解析只留在一处（`?? "agent"`、`?? "llm"`）。
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
