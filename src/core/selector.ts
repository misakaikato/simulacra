// Selector evaluation for interventions and questionnaires: where-predicates on agent rows,
// then seed-derived thinning by fraction and n.
// 干预与问卷使用的 Selector 求值：先按 where 谓词匹配 agent 行，再按 fraction 与 n 做种子派生的抽稀。

import { AGENT_ENTITY } from "./population";
import type { Rng, WorldView } from "./protocols";
import type { EntityId, JsonValue, Scalar, Selector, SelectorPredicate } from "./types";

const isObject = (v: JsonValue): v is { readonly [k: string]: JsonValue } =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const same = (a: Scalar | undefined, b: JsonValue): boolean =>
	a !== undefined && JSON.stringify(a) === JSON.stringify(b);

// An object with in/gt/lt is an operator; any other JSON value is an equality test compared
// by JSON text, so strlist values compare structurally.
// 带 in/gt/lt 的对象是操作符；其它任何 JSON 值都是按 JSON 文本比较的相等测试，strlist 因此按结构比较。
export const matchesPredicate = (
	value: Scalar | undefined,
	predicate: SelectorPredicate,
): boolean => {
	if (isObject(predicate)) {
		if ("in" in predicate && Array.isArray(predicate.in))
			return predicate.in.some((candidate) => same(value, candidate));
		if ("gt" in predicate && typeof predicate.gt === "number")
			return typeof value === "number" && value > predicate.gt;
		if ("lt" in predicate && typeof predicate.lt === "number")
			return typeof value === "number" && value < predicate.lt;
	}
	return same(value, predicate);
};

export const matchesSelector = (
	row: Readonly<Record<string, Scalar>> | undefined,
	where: Selector["where"],
): boolean =>
	row !== undefined &&
	Object.entries(where).every(([column, predicate]) => matchesPredicate(row[column], predicate));

// Rows matching `where`, then thinned by `fraction` and capped by `n`; the thinning is a
// seed-derived shuffle so the same selector and rng pick the same agents.
// 先取匹配 where 的行，再按 fraction 抽稀、按 n 封顶；抽稀是种子派生的洗牌，相同的 selector 与 rng 选出相同的 agent。
export const selectAgents = (
	world: WorldView,
	selector: Selector,
	rng: Rng,
	entity = AGENT_ENTITY,
): readonly EntityId[] => {
	const matched = world
		.ids(entity)
		.filter((id) => matchesSelector(world.row(entity, id), selector.where));
	let count = matched.length;
	if (selector.fraction !== undefined)
		count = Math.min(count, Math.round(selector.fraction * matched.length));
	if (selector.n !== undefined) count = Math.min(count, selector.n);
	if (count >= matched.length) return matched;
	return rng.shuffle(matched).slice(0, count);
};
