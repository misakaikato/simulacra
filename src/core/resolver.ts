// applyEffects, the only write entry to the world: effects are applied in arrival order through
// the internal handle, rejections are collected rather than thrown, and same-tick conflicts
// are settled by the column's merge rule inside world.ts.
// applyEffects 是世界状态的唯一写入口：效果按到达顺序经内部句柄应用，拒绝被收集而不是抛出，
// 同 tick 冲突由 world.ts 里列的 merge 规则裁决。

import type { World } from "./protocols";
import type { Effect, EffectRejection, EffectReport, LogicalTime, Result } from "./types";
import { internalOf, type WorldInternals } from "./internal/worldInternals";

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

// Effects are independent: a rejected one does not roll back those before it, so the report
// tells callers exactly which changes landed.
// 效果彼此独立：被拒绝的效果不回滚它之前的效果，报告因此精确说明哪些变更落地。
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
