import type { World } from "./protocols";
import type { Effect, EffectRejection, EffectReport, LogicalTime, Result } from "./types";
import { internalOf, type WorldInternals } from "./world";

const applyOne = (w: WorldInternals, effect: Effect, tick: number): Result<void, string> => {
	switch (effect.op) {
		case "set":
			return w.setCell(effect.entity, effect.id, effect.column, effect.value, tick);
		case "inc":
			return w.incCell(effect.entity, effect.id, effect.column, effect.value, tick);
		case "append":
			return w.appendCell(effect.entity, effect.id, effect.column, effect.value, tick);
		case "create":
			return w.insertRow(effect.entity, effect.id, effect.row);
		case "delete":
			return w.deleteRow(effect.entity, effect.id);
		case "envSet":
			w.setEnv(effect.key, effect.value);
			return { ok: true, value: undefined };
		case "setColumn":
			return w.setCells(effect.entity, effect.column, effect.ids, effect.values, tick);
	}
};

export const applyEffects = (
	world: World,
	effects: readonly Effect[],
	t: LogicalTime,
): EffectReport => {
	const w = internalOf(world);
	let applied = 0;
	const rejected: EffectRejection[] = [];
	for (const effect of effects) {
		const r = applyOne(w, effect, t.tick);
		if (r.ok) applied += 1;
		else rejected.push({ effect, reason: r.error });
	}
	return { applied, rejected };
};
