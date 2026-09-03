// Feed observation component: truncates the feed module's ranked list to the prompt window.
// The list itself comes from the module observation, so `reads` stays empty.
// 信息流观察组件：把 feed 模块排好序的列表截到 prompt 窗口大小。
// 列表本身来自模块观察，因此 `reads` 为空。

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
