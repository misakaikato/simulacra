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

export const assignmentsOf = (
	axes: readonly PerturbationAxis[],
	design: AuditPlan["design"],
): readonly Assignment[] => {
	if (design === "one_at_a_time") return [[], ...axes.flatMap(levelsOf)];
	return axes.reduce<readonly Assignment[]>(
		(partials, axis, index) =>
			partials.flatMap((partial) =>
				axis.levels.map((_, level): Assignment => [...partial, { axis: index, level }]),
			),
		[[]],
	);
};

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

export const baselineOf = (conditions: readonly Condition[], c: Condition): Condition | undefined =>
	conditions.find((b) => isBaseCondition(b) && b.model === c.model);
