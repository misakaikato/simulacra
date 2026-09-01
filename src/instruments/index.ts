import type { DuplicatePlugin, Registry } from "../core/protocols";
import type { Result } from "../core/types";
import { QUESTIONNAIRE_KIND, createQuestionnaire } from "./questionnaire";

export { QUESTIONNAIRE_KIND, createQuestionnaire } from "./questionnaire";

export const registerBuiltinInstruments = (registry: Registry): Result<void, DuplicatePlugin> =>
	registry.instruments.register(QUESTIONNAIRE_KIND, createQuestionnaire);
