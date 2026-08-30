import type { Component, EventLog } from "../../core/protocols";
import type { EntityId, Event, EventKind, JsonValue } from "../../core/types";
import { CONTEXT_KEYS, type MemoryEntrySchema } from "./shared";
import type { z } from "zod";

const RATIONALE_CHARS = 200;

type Entry = z.output<typeof MemoryEntrySchema>;

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
