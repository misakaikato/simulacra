// Event construction and canonical form: the closed kind list, makeEvent, the total order
// events are digested in, and the digest itself.
// 事件的构造与规范形式：封闭的 kind 列表、makeEvent、事件 digest 时采用的全序，以及 digest 本身。

import { canonicalJson } from "./hash";
import { compareTime } from "./time";
import type {
	BatchEventKind,
	EntityId,
	Event,
	EventId,
	EventKind,
	EventOf,
	EventPayload,
	LogicalTime,
	Provenance,
	RunId,
} from "./types";

export const EVENT_KINDS: readonly EventKind[] = [
	"activation",
	"observation",
	"decision",
	"observation_batch",
	"decision_batch",
	"llm_call",
	"effect",
	"intervention",
	"measurement",
	"failure",
	"checkpoint",
	"module_step",
];

export const BATCH_EVENT_KINDS: readonly BatchEventKind[] = ["observation_batch", "decision_batch"];

export const isEventKind = (s: string): s is EventKind =>
	(EVENT_KINDS as readonly string[]).includes(s);

export const isBatchEvent = (e: Event): e is EventOf<BatchEventKind> =>
	e.kind === "observation_batch" || e.kind === "decision_batch";

export interface EventFields {
	readonly eventId: EventId;
	readonly runId: RunId;
	readonly t: LogicalTime;
	readonly seedPath: readonly number[];
	readonly agentId?: EntityId;
	readonly parent?: EventId;
	readonly provenance?: Provenance;
}

export type EventInit = {
	[K in EventKind]: { readonly kind: K; readonly payload: EventPayload<K> };
}[EventKind];

// Optional fields are spread in only when present so an event's canonical JSON never
// contains explicit undefined keys.
// 可选字段只在存在时展开进去，事件的规范化 JSON 里因此不会出现显式的 undefined 键。
export const makeEvent = (fields: EventFields, init: EventInit): Event => ({
	eventId: fields.eventId,
	runId: fields.runId,
	t: fields.t,
	seedPath: fields.seedPath,
	...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
	...(fields.parent === undefined ? {} : { parent: fields.parent }),
	...(fields.provenance === undefined ? {} : { provenance: fields.provenance }),
	...init,
});

// Total order for digest and replay: logical time, then eventId. ULIDs from one rng are
// monotonic, so ties within a time break by creation order.
// digest 与回放共用的全序：先逻辑时间，再 eventId。同一 rng 产出的 ULID 单调，同一时间内按创建
// 顺序排列。
export const compareEvents = (a: Event, b: Event): -1 | 0 | 1 => {
	const byTime = compareTime(a.t, b.t);
	if (byTime !== 0) return byTime;
	if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
	return 0;
};

// Stack text is not deterministic (paths, line numbers), so failure stacks are excluded from
// the digest but kept on the stored event for inspect.
// 栈文本不确定（路径、行号），failure 的 stack 不进 digest，但事件本身保留它供 inspect 使用。
const digestible = (e: Event): Event => {
	if (e.kind !== "failure" || e.payload.stack === undefined) return e;
	const { stack: _stack, ...payload } = e.payload;
	return { ...e, payload };
};

export const canonicalEvent = (e: Event): string => canonicalJson(digestible(e));

// One canonical line per event in sorted order, so two logs holding the same events in a
// different storage order agree.
// 按排序后的顺序每事件一行规范化文本，存储顺序不同但事件相同的两个日志 digest 相等。
export const digestEvents = (sorted: Iterable<Event>): string => {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const e of sorted) hasher.update(`${canonicalEvent(e)}\n`);
	return hasher.digest("hex");
};
