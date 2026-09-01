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

const timeOf = (t: { readonly tick: number; readonly substep: number; readonly seq: number }) =>
	`${t.tick}.${t.substep}.${t.seq}`;

export const describeEffect = (e: Effect): string => {
	switch (e.op) {
		case "set":
		case "inc":
		case "append":
			return `${e.op} ${e.entity}[${e.id}].${e.column} = ${JSON.stringify(e.value)}`;
		case "create":
			return `create ${e.entity}[${e.id}] ${JSON.stringify(e.row)}`;
		case "delete":
			return `delete ${e.entity}[${e.id}]`;
		case "envSet":
			return `envSet ${e.key} = ${JSON.stringify(e.value)}`;
		case "setColumn":
			return `setColumn ${e.entity}.${e.column} on ${e.ids.length} rows`;
	}
};

export const renderInspect = (r: InspectResult): readonly string[] => {
	const lines: string[] = [`agent ${r.agentId} tick ${r.tick}`];
	lines.push("observation:");
	lines.push(
		r.observation === undefined
			? "  none"
			: `  ${r.observation.eventId} t=${timeOf(r.observation.t)} contentSha=${r.observation.payload.contentSha} promptHash=${r.observation.payload.promptHash ?? "-"} truncated=${r.observation.payload.truncated}`,
	);
	lines.push("prompt:");
	lines.push(
		r.promptPreview === undefined
			? "  none"
			: `  ${r.promptPreview.replace(/\s+/g, " ").trim()}`,
	);
	lines.push("decision:");
	lines.push(
		r.decision === undefined
			? "  none"
			: `  ${r.decision.eventId} t=${timeOf(r.decision.t)} action=${r.decision.payload.action} args=${JSON.stringify(r.decision.payload.args)} provider=${r.decision.payload.provider} parseOk=${r.decision.payload.parseOk}`,
	);
	lines.push(`effects: ${r.effects.length}`);
	for (const e of r.effects) lines.push(`  ${describeEffect(e)}`);
	if (r.failures.length > 0) {
		lines.push(`failures: ${r.failures.length}`);
		for (const f of r.failures)
			lines.push(
				`  ${f.eventId} ${f.payload.stage} ${f.payload.excType}: ${f.payload.message}`,
			);
	}
	lines.push(`chain: ${r.chain.map((e) => `${e.kind}@${timeOf(e.t)}`).join(" -> ")}`);
	return lines;
};
