// Registration entry for instruments; the questionnaire is the only built-in. Questionnaires run
// through the agents' own provider with provenance `interview` and write measurement events,
// never world effects.
// 仪器的注册入口；问卷是唯一的内置仪器。问卷经 agent 自己的提供者以 provenance `interview`
// 执行，只写 measurement 事件，从不产生世界效果。

import type { DuplicatePlugin, Registry } from "../core/protocols";
import type { Result } from "../core/types";
import { QUESTIONNAIRE_KIND, createQuestionnaire } from "./questionnaire";

export { QUESTIONNAIRE_KIND, createQuestionnaire } from "./questionnaire";

export const registerBuiltinInstruments = (registry: Registry): Result<void, DuplicatePlugin> =>
	registry.instruments.register(QUESTIONNAIRE_KIND, createQuestionnaire);
