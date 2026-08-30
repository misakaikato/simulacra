import type { Component } from "../../core/protocols";
import type { JsonValue } from "../../core/types";
import { CONTEXT_KEYS } from "./shared";

const listOf = (v: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(v) ? v : []);

export const neighborhoodObservation = (radius: number): Component => ({
	name: "neighborhoodObservation",
	reads: [],
	writes: [CONTEXT_KEYS.neighbors],
	preAct: (_agentId, _view, _t, ctx) => ({
		[CONTEXT_KEYS.neighbors]: listOf(ctx.get(CONTEXT_KEYS.neighbors)),
		neighborhoodRadius: radius,
	}),
	postAct: () => {},
	getState: () => null,
	setState: () => {},
});
