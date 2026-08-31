import type { EventLog } from "./protocols";
import { err, ok } from "./result";
import { withRunLog } from "./runDir";
import type { Effect, EntityId, Event, EventId, EventOf, Result } from "./types";

export const PROMPT_PREVIEW_CHARS = 200;

export interface InspectQuery {
	readonly agentId: EntityId;
	readonly tick?: number;
	readonly eventId?: EventId;
}

export interface InspectResult {
	readonly agentId: EntityId;
	readonly tick: number;
	readonly chain: readonly Event[];
	readonly observation?: EventOf<"observation">;
	readonly promptPreview?: string;
	readonly decision?: EventOf<"decision">;
	readonly effects: readonly Effect[];
	readonly failures: readonly EventOf<"failure">[];
}

const anchorOf = (log: EventLog, query: InspectQuery): Result<Event, string> => {
	if (query.eventId !== undefined) {
		const [found] = log.chain(query.eventId).filter((e) => e.eventId === query.eventId);
		return found === undefined ? err(`unknown event ${query.eventId}`) : ok(found);
	}
	const decisions = log.query({
		kind: ["decision", "failure"],
		agentId: query.agentId,
		...(query.tick === undefined ? {} : { tick: query.tick }),
	});
	const decision = decisions.filter((e) => e.kind === "decision").at(-1) ?? decisions.at(-1);
	if (decision === undefined)
		return err(
			`agent ${query.agentId} has no decision${query.tick === undefined ? "" : ` at tick ${query.tick}`}`,
		);
	return ok(decision);
};

export const inspectEvents = (
	log: EventLog,
	query: InspectQuery,
): Result<InspectResult, string> => {
	const anchor = anchorOf(log, query);
	if (!anchor.ok) return anchor;
	const chain = log.chain(anchor.value.eventId);
	const tick = anchor.value.t.tick;
	const observation = chain.find((e): e is EventOf<"observation"> => e.kind === "observation");
	const decision = chain.find((e): e is EventOf<"decision"> => e.kind === "decision");
	const failures = chain.filter((e): e is EventOf<"failure"> => e.kind === "failure");
	const prompt =
		observation === undefined ? undefined : log.getContent(observation.payload.contentSha);
	const effects =
		decision === undefined
			? []
			: log
					.query({ kind: ["effect"], tick })
					.flatMap((e) => (e.kind === "effect" ? e.payload.effects : []))
					.filter((effect) => effect.cause === decision.eventId);
	return ok({
		agentId: query.agentId,
		tick,
		chain,
		...(observation === undefined ? {} : { observation }),
		...(prompt === undefined ? {} : { promptPreview: prompt.slice(0, PROMPT_PREVIEW_CHARS) }),
		...(decision === undefined ? {} : { decision }),
		effects,
		failures,
	});
};

export const inspectRun = (runDir: string, query: InspectQuery): Result<InspectResult, string> =>
	withRunLog(runDir, (log) => inspectEvents(log, query));
