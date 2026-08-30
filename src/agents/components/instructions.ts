import type { Component } from "../../core/protocols";
import { CONTEXT_KEYS } from "./shared";

export const instructions = (text: string): Component => ({
	name: "instructions",
	reads: [],
	writes: [CONTEXT_KEYS.instructions],
	preAct: () => ({ [CONTEXT_KEYS.instructions]: text }),
	postAct: () => {},
	getState: () => null,
	setState: () => {},
});
