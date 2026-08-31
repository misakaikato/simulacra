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
