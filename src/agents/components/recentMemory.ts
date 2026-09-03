// Recent-memory component: rebuilds the agent's short-term memory from the event log on every
// observation, so memory is derived state that survives checkpoints without being stored twice.
// 近期记忆组件：每次观察都从事件日志重建 agent 的短期记忆，记忆因此是派生状态，
// 跨检查点无需另存一份。

import type { Component, EventLog } from "../../core/protocols";
import type { EntityId, Event, EventKind, JsonValue } from "../../core/types";
import { CONTEXT_KEYS, type MemoryEntrySchema } from "./shared";
import type { z } from "zod";

const RATIONALE_CHARS = 200;

type Entry = z.output<typeof MemoryEntrySchema>;

// A decision is remembered as action + args, flagged when it was a fallback, plus a capped slice
// of the rationale fetched from the content store; the cap bounds prompt growth per entry.
// 一条决策记为动作加参数，兜底决策加标记，再附上从内容库取出并截断的理由；
// 截断上限约束每条记忆对 prompt 的膨胀。
const describeDecision = (
	e: Extract<Event, { readonly kind: "decision" }>,
	log: EventLog,
): string => {
	const base = `${e.payload.action} ${JSON.stringify(e.payload.args)}${e.payload.parseOk ? "" : " (fallback)"}`;
	const rationale =
		e.payload.rationaleSha === undefined ? undefined : log.getContent(e.payload.rationaleSha);
	return rationale === undefined || rationale.length === 0
		? base
		: `${base} because ${rationale.slice(0, RATIONALE_CHARS)}`;
};

export const memoryEntryOf = (e: Event, log: EventLog): Entry | undefined => {
	switch (e.kind) {
		case "decision":
			return { eventId: e.eventId, t: e.t, kind: "decision", text: describeDecision(e, log) };
		case "observation":
			return {
				eventId: e.eventId,
				t: e.t,
				kind: "observation",
				text: e.payload.truncated ? "observed (truncated)" : "observed",
			};
		default:
			return undefined;
	}
};

// The log query is filtered by agentId, which is why interview events without agentId and
// cohort batch events never appear in memory; the tail of the result keeps the newest k.
// 日志按 agentId 查询，因此不带 agentId 的访谈事件与 cohort 批量事件永远进不了记忆；
// 取结果尾部即最新的 k 条。
export const recentEntries = (
	log: EventLog,
	agentId: EntityId,
	k: number,
	kinds: readonly EventKind[],
): readonly Entry[] => {
	const events = log.query({ agentId, kind: kinds });
	const tail = events.slice(Math.max(0, events.length - k));
	return tail.flatMap((e) => {
		const entry = memoryEntryOf(e, log);
		return entry === undefined ? [] : [entry];
	});
};

export interface RecentMemoryOptions {
	readonly k: number;
	readonly kinds?: readonly EventKind[];
}

export const recentMemory = (options: RecentMemoryOptions): Component => {
	const kinds = options.kinds ?? ["decision", "observation"];
	return {
		name: "recentMemory",
		reads: [],
		writes: [CONTEXT_KEYS.memory],
		preAct: (agentId, _view, _t, _ctx, log) => ({
			[CONTEXT_KEYS.memory]: recentEntries(log, agentId, options.k, kinds) as JsonValue,
		}),
		postAct: () => {},
		getState: () => null,
		setState: () => {},
	};
};
