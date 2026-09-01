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
