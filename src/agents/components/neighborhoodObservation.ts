// Neighbourhood observation component: passes the social graph module's neighbour list through
// and records the configured radius so the prompt states how far the view reaches.
// 邻域观察组件：透传社交图模块给出的邻居列表，并记下配置的半径，让 prompt 说明视野范围。

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
