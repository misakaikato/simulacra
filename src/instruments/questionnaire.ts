// Questionnaire factory: validates the scenario's question list into the core Question shape.
// `entersMemory` decides whether the interview's observation and decision events carry the
// agent's id (and so feed its memory) or stay off its timeline (appendix H).
// 问卷工厂：把场景里的题目列表校验成内核的 Question 形状。`entersMemory` 决定访谈的观察与
// 决策事件是否带 agent id（从而进入其记忆），还是不落在它的时间线上（附录 H）。

import type { PluginContext, PluginError, Questionnaire } from "../core/protocols";
import { toQuestion } from "../core/questionnaire";
import { parseOptions } from "../core/registry";
import { ok } from "../core/result";
import { QuestionnaireOptionsSchema } from "../core/schema";
import type { InstrumentSpec, Result } from "../core/types";

export const QUESTIONNAIRE_KIND = "questionnaire";

export const createQuestionnaire = (
	spec: InstrumentSpec,
	ctx: PluginContext,
): Result<Questionnaire, PluginError> => {
	const options = parseOptions(ctx.registry.instruments.slot, spec, QuestionnaireOptionsSchema);
	if (!options.ok) return options;
	return ok({
		name: spec.name ?? spec.kind,
		questions: options.value.questions.map(toQuestion),
		entersMemory: options.value.entersMemory,
	});
};
