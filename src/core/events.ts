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

export const compareEvents = (a: Event, b: Event): -1 | 0 | 1 => {
	const byTime = compareTime(a.t, b.t);
	if (byTime !== 0) return byTime;
	if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
	return 0;
};

const digestible = (e: Event): Event => {
	if (e.kind !== "failure" || e.payload.stack === undefined) return e;
	const { stack: _stack, ...payload } = e.payload;
	return { ...e, payload };
};

export const canonicalEvent = (e: Event): string => canonicalJson(digestible(e));

export const digestEvents = (sorted: Iterable<Event>): string => {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const e of sorted) hasher.update(`${canonicalEvent(e)}\n`);
	return hasher.digest("hex");
};
