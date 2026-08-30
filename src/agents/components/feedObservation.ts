import type { Component } from "../../core/protocols";
import type { JsonValue } from "../../core/types";
import { CONTEXT_KEYS } from "./shared";

const listOf = (v: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(v) ? v : []);

export const feedObservation = (size: number): Component => ({
	name: "feedObservation",
	reads: [],
	writes: [CONTEXT_KEYS.feed],
	preAct: (_agentId, _view, _t, ctx) => ({
		[CONTEXT_KEYS.feed]: listOf(ctx.get(CONTEXT_KEYS.feed)).slice(0, size),
	}),
	postAct: () => {},
	getState: () => null,
	setState: () => {},
});
