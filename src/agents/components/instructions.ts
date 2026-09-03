// Instructions component: the scenario's static brief plus, when an intervention targets this
// agent, its one-off instruction; interventions reach agents only through this seam.
// 指令组件：场景的静态说明，外加针对本 agent 的干预指令（若有）；干预只通过这一处触达 agent。

import type { Component } from "../../core/protocols";
import type { JsonObject, JsonValue } from "../../core/types";
import { CONTEXT_KEYS, INTERVENTION_INSTRUCTION_KEY } from "./shared";

const isObject = (v: JsonValue | undefined): v is JsonObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const interventionInstruction = (value: JsonValue | undefined): string | undefined => {
	if (!isObject(value)) return undefined;
	const instruction = value[INTERVENTION_INSTRUCTION_KEY];
	return typeof instruction === "string" && instruction.length > 0 ? instruction : undefined;
};

// Static instructions, followed by an intervention's instruction when one is pending for
// this agent's next observation.
// 静态指令在前，若本 agent 下一次观察有待生效的干预，则把干预指令接在后面。
export const instructions = (text: string): Component => ({
	name: "instructions",
	reads: [],
	writes: [CONTEXT_KEYS.instructions],
	preAct: (_agentId, _view, _t, ctx) => {
		const extra = interventionInstruction(ctx.get(CONTEXT_KEYS.intervention));
		return {
			[CONTEXT_KEYS.instructions]: extra === undefined ? text : `${text}\n\n${extra}`,
		};
	},
	postAct: () => {},
	getState: () => null,
	setState: () => {},
});
