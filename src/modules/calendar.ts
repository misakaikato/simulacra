// Calendar module: publishes the scheduled event for the coming tick into the environment under
// a single key, so prompts can mention "what is happening today" without a table or an action.
// 日历模块：把下一 tick 的预定事件以单个键写进环境，prompt 无需表或动作就能提到"今天发生了什么"。

import { z } from "zod";
import { ZERO_EVENT_ID } from "../core/ids";
import type {
	ActionDef,
	Module,
	PluginContext,
	PluginError,
	Rng,
	WorldView,
} from "../core/protocols";
import { parseOptions } from "../core/registry";
import { ok } from "../core/result";
import { JsonValueSchema } from "../core/schema";
import type { Effect, EntityId, JsonValue, LogicalTime, ModuleSpec, Result } from "../core/types";

export const CALENDAR_KIND = "calendar";
export const CALENDAR_KEY = "calendar.current";

export const CalendarOptionsSchema = z.object({
	events: z.record(z.string(), JsonValueSchema).default({}),
	key: z.string().min(1).default(CALENDAR_KEY),
});

export type CalendarOptions = z.output<typeof CalendarOptionsSchema>;

class CalendarModule implements Module {
	readonly name: string;
	readonly concurrencySafe = true;
	private readonly options: CalendarOptions;

	constructor(name: string, options: CalendarOptions) {
		this.name = name;
		this.options = options;
	}

	declare(): Result<void, never> {
		return ok(undefined);
	}

	actions(): readonly ActionDef[] {
		return [];
	}

	// initialize writes tick 0's entry and step writes tick t+1's, so agents observing at tick t
	// always see the entry scheduled for t; ticks without an entry clear the key to null.
	// initialize 写入 tick 0 的条目，step 写入 tick t+1 的，agent 在 tick t 观察时看到的总是
	// 为 t 安排的条目；没有条目的 tick 把键清为 null。
	async initialize(_world: WorldView, _rng: Rng): Promise<readonly Effect[]> {
		return [this.inject(0)];
	}

	observe(): Readonly<Record<EntityId, JsonValue>> {
		return {};
	}

	async step(_view: WorldView, t: LogicalTime, _rng: Rng): Promise<readonly Effect[]> {
		return [this.inject(t.tick + 1)];
	}

	getState(): JsonValue {
		return null;
	}

	setState(_s: JsonValue): void {}

	private inject(tick: number): Effect {
		return {
			op: "envSet",
			key: this.options.key,
			value: this.options.events[String(tick)] ?? null,
			cause: ZERO_EVENT_ID,
		};
	}
}

export const createCalendarModule = (
	spec: ModuleSpec,
	ctx: PluginContext,
): Result<Module, PluginError> => {
	const options = parseOptions(ctx.registry.modules.slot, spec, CalendarOptionsSchema);
	if (!options.ok) return options;
	return ok(new CalendarModule(spec.name ?? spec.kind, options.value));
};
