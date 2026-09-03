// Agent-centric view over the event log behind `simulacra inspect` and the MCP trace tool:
// anchor on the agent's decision (or failure) at a tick, walk the causal chain, and collect
// the prompt text, effects and failures that belong to it.
// `simulacra inspect` 与 MCP 追踪工具背后以 agent 为中心的事件日志视图：以该 agent 在某 tick 的决策
//（或失败）为锚点，沿因果链遍历，收集属于它的 prompt 文本、效果与失败。

import { compareEvents } from "./events";
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

// Agents of batch executors have no per-agent observation or decision events; the batch
// events that list them fill observationBatch and decisionBatch instead.
// 批量执行体的 agent 没有逐 agent 的 observation 与 decision 事件；列出它们的批量事件填入 observationBatch 与 decisionBatch。
export interface InspectResult {
	readonly agentId: EntityId;
	readonly tick: number;
	readonly chain: readonly Event[];
	readonly observation?: EventOf<"observation">;
	readonly observationBatch?: EventOf<"observation_batch">;
	readonly promptPreview?: string;
	readonly decision?: EventOf<"decision">;
	readonly decisionBatch?: EventOf<"decision_batch">;
	readonly effects: readonly Effect[];
	readonly failures: readonly EventOf<"failure">[];
}

const touches = (effect: Effect, agentId: EntityId): boolean =>
	effect.op === "setColumn"
		? effect.ids.includes(agentId)
		: effect.op !== "envSet" && effect.id === agentId;

// The anchor is the latest decision at the tick, per-agent or batch; a failure anchors only
// when no decision exists, so a fallback decision still anchors its chain.
// 锚点是该 tick 最晚的决策，逐 agent 或批量皆可；只有不存在决策时才以 failure 为锚，
// 回退产生的决策因此仍能锚定它的因果链。
const anchorOf = (log: EventLog, query: InspectQuery): Result<Event, string> => {
	if (query.eventId !== undefined) {
		const [found] = log.chain(query.eventId).filter((e) => e.eventId === query.eventId);
		return found === undefined ? err(`unknown event ${query.eventId}`) : ok(found);
	}
	const at = query.tick === undefined ? {} : { tick: query.tick };
	const decisions = [
		...log.query({ kind: ["decision"], agentId: query.agentId, ...at }),
		...log.batchesOf(query.agentId, { kind: ["decision_batch"], ...at }),
	].sort(compareEvents);
	const anchor =
		decisions.at(-1) ?? log.query({ kind: ["failure"], agentId: query.agentId, ...at }).at(-1);
	if (anchor === undefined)
		return err(
			`agent ${query.agentId} has no decision${query.tick === undefined ? "" : ` at tick ${query.tick}`}`,
		);
	return ok(anchor);
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
	const observationBatch = chain.find(
		(e): e is EventOf<"observation_batch"> => e.kind === "observation_batch",
	);
	const decision = chain.find((e): e is EventOf<"decision"> => e.kind === "decision");
	const decisionBatch = chain.find(
		(e): e is EventOf<"decision_batch"> => e.kind === "decision_batch",
	);
	// Batch failures hang off the observation batch, one per agent, so the chain of the
	// decision batch does not reach them; the agent's own failures at the tick do.
	// 批量失败挂在 observation batch 下、每 agent 一条，decision batch 的因果链够不到它们；改取该 agent 在本 tick 的失败事件。
	const failures =
		decisionBatch === undefined
			? chain.filter((e): e is EventOf<"failure"> => e.kind === "failure")
			: log
					.query({ kind: ["failure"], agentId: query.agentId, tick })
					.filter((e): e is EventOf<"failure"> => e.kind === "failure");
	const prompt =
		observation === undefined ? undefined : log.getContent(observation.payload.contentSha);
	const cause = decision?.eventId ?? decisionBatch?.eventId;
	const effects =
		cause === undefined
			? []
			: log
					.query({ kind: ["effect"], tick })
					.flatMap((e) => (e.kind === "effect" ? e.payload.effects : []))
					.filter(
						(effect) =>
							effect.cause === cause &&
							(decisionBatch === undefined || touches(effect, query.agentId)),
					);
	return ok({
		agentId: query.agentId,
		tick,
		chain,
		...(observation === undefined ? {} : { observation }),
		...(observationBatch === undefined ? {} : { observationBatch }),
		...(prompt === undefined ? {} : { promptPreview: prompt.slice(0, PROMPT_PREVIEW_CHARS) }),
		...(decision === undefined ? {} : { decision }),
		...(decisionBatch === undefined ? {} : { decisionBatch }),
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

// The agent's own value inside a column-wide write
// 整列写入中属于该 agent 的那个值
const describeEffectFor = (e: Effect, agentId: EntityId): string => {
	const text = describeEffect(e);
	if (e.op !== "setColumn") return text;
	const i = e.ids.indexOf(agentId);
	return i < 0 ? text : `${text}, [${agentId}] = ${JSON.stringify(e.values[i])}`;
};

const observationLine = (r: InspectResult): string => {
	if (r.observation !== undefined)
		return `  ${r.observation.eventId} t=${timeOf(r.observation.t)} contentSha=${r.observation.payload.contentSha} promptHash=${r.observation.payload.promptHash ?? "-"} truncated=${r.observation.payload.truncated}`;
	if (r.observationBatch !== undefined)
		return `  ${r.observationBatch.eventId} t=${timeOf(r.observationBatch.t)} batch executor=${r.observationBatch.payload.executor} agents=${r.observationBatch.payload.count} featuresSha=${r.observationBatch.payload.featuresSha ?? "-"}`;
	return "  none";
};

const decisionLine = (r: InspectResult): string => {
	if (r.decision !== undefined)
		return `  ${r.decision.eventId} t=${timeOf(r.decision.t)} action=${r.decision.payload.action} args=${JSON.stringify(r.decision.payload.args)} provider=${r.decision.payload.provider} parseOk=${r.decision.payload.parseOk}`;
	if (r.decisionBatch !== undefined) {
		const p = r.decisionBatch.payload;
		const action = p.actions[p.agentIds.indexOf(r.agentId)] ?? "-";
		return `  ${r.decisionBatch.eventId} t=${timeOf(r.decisionBatch.t)} batch action=${action} provider=${p.provider} provenance=${p.provenance} agents=${p.agentIds.length} parseFailures=${p.parseFailures}`;
	}
	return "  none";
};

export const renderInspect = (r: InspectResult): readonly string[] => {
	const lines: string[] = [`agent ${r.agentId} tick ${r.tick}`];
	lines.push("observation:");
	lines.push(observationLine(r));
	lines.push("prompt:");
	lines.push(
		r.promptPreview === undefined
			? "  none"
			: `  ${r.promptPreview.replace(/\s+/g, " ").trim()}`,
	);
	lines.push("decision:");
	lines.push(decisionLine(r));
	lines.push(`effects: ${r.effects.length}`);
	for (const e of r.effects) lines.push(`  ${describeEffectFor(e, r.agentId)}`);
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
