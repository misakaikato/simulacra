// Condition generation for an audit plan (pure): one_at_a_time yields the base plus one
// condition per axis level, full_factorial the base plus the Cartesian product; both are then
// crossed with the model list. Ids and flags are derived deterministically from the plan.
// 审计计划的条件生成（纯函数）：one_at_a_time 产出基线加每轴每取值一个条件，full_factorial
// 产出基线加笛卡尔积；两者再与模型列表叉乘。条件 id 与标志都由计划确定性地导出。

import { ok } from "../core/result";
import { overrideScenario, scenarioHash, type OverrideError } from "../core/scenario";
import type {
	AuditPlan,
	Condition,
	JsonValue,
	PerturbationAxis,
	Result,
	Scenario,
} from "../core/types";

export const BASE_CONDITION_ID = "base";
export const AXIS_SEPARATOR = "|";
export const LEVEL_SEPARATOR = "=";
export const MODEL_SEPARATOR = "@";
export const MODEL_TARGET = "llm.model";

export interface AxisChoice {
	readonly axis: number;
	readonly level: number;
}

export type Assignment = readonly AxisChoice[];

const levelsOf = (axis: PerturbationAxis, index: number): readonly Assignment[] =>
	axis.levels.map((_, level) => [{ axis: index, level }]);

// The empty assignment comes first in both designs: it is the `base` condition every pairwise
// test compares against (appendix F).
// 两种设计里空指派都排在最前：它就是所有成对检验的基线 `base` 条件（附录 F）。
export const assignmentsOf = (
	axes: readonly PerturbationAxis[],
	design: AuditPlan["design"],
): readonly Assignment[] => {
	if (design === "one_at_a_time") return [[], ...axes.flatMap(levelsOf)];
	if (axes.length === 0) return [[]];
	const product = axes.reduce<readonly Assignment[]>(
		(partials, axis, index) =>
			partials.flatMap((partial) =>
				axis.levels.map((_, level): Assignment => [...partial, { axis: index, level }]),
			),
		[[]],
	);
	return [[], ...product];
};

// `@model` is appended only when the plan lists models explicitly, so single-model plans keep
// the short ids (appendix E).
// 只有计划显式列出 models 时才追加 `@model`，单模型计划保留短 id（附录 E）。
export const conditionIdOf = (
	axes: readonly PerturbationAxis[],
	assignment: Assignment,
	model?: string,
): string => {
	const core =
		assignment.length === 0
			? BASE_CONDITION_ID
			: assignment
					.map(({ axis, level }) => `${axes[axis]?.id ?? axis}${LEVEL_SEPARATOR}${level}`)
					.join(AXIS_SEPARATOR);
	return model === undefined ? core : `${core}${MODEL_SEPARATOR}${model}`;
};

export const modelsOf = (plan: AuditPlan): readonly string[] =>
	plan.models.length > 0 ? plan.models : [plan.base.llm.model];

interface Applied {
	readonly scenario: Scenario;
	readonly axisValues: Readonly<Record<string, JsonValue>>;
}

const applyAssignment = (
	plan: AuditPlan,
	assignment: Assignment,
): Result<Applied, OverrideError> => {
	let scenario = plan.base;
	const axisValues: Record<string, JsonValue> = {};
	for (const choice of assignment) {
		const axis = plan.axes[choice.axis];
		const value = axis?.levels[choice.level];
		if (axis === undefined || value === undefined) continue;
		const applied = overrideScenario(scenario, axis.target, value);
		if (!applied.ok) return applied;
		scenario = applied.value;
		axisValues[axis.id] = value;
	}
	return ok({ scenario, axisValues });
};

// `identicalToBase` is judged on the scenario hash before the model override, so a level that
// merely restates the base value is flagged instead of silently doubling the baseline.
// `identicalToBase` 以模型覆盖之前的场景哈希判定，取值恰好等于基线值的条件会被标记，
// 而不是悄悄变成第二个基线。
export const generateConditions = (
	plan: AuditPlan,
): Result<readonly Condition[], OverrideError> => {
	const models = modelsOf(plan);
	const tagModel = plan.models.length > 0;
	const baseHash = scenarioHash(plan.base);
	const conditions: Condition[] = [];
	for (const assignment of assignmentsOf(plan.axes, plan.design)) {
		const applied = applyAssignment(plan, assignment);
		if (!applied.ok) return applied;
		const identical =
			assignment.length > 0 && scenarioHash(applied.value.scenario) === baseHash;
		for (const model of models) {
			const withModel = overrideScenario(applied.value.scenario, MODEL_TARGET, model);
			if (!withModel.ok) return withModel;
			conditions.push({
				conditionId: conditionIdOf(plan.axes, assignment, tagModel ? model : undefined),
				axisValues: applied.value.axisValues,
				model,
				scenario: withModel.value,
				...(identical ? { flags: ["identicalToBase"] } : {}),
			});
		}
	}
	return ok(conditions);
};

export const isBaseCondition = (c: Condition): boolean => Object.keys(c.axisValues).length === 0;

// A condition's baseline is the base condition of the same model; cross-model differences are
// reported in crossModel, never as pairwise tests.
// 条件的基线是同一模型的 base 条件；跨模型差异只进 crossModel，从不做成对检验。
export const baselineOf = (conditions: readonly Condition[], c: Condition): Condition | undefined =>
	conditions.find((b) => isBaseCondition(b) && b.model === c.model);
