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
