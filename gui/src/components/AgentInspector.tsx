import { Fragment, useEffect, useState } from "react";
import type { Effect, EntityId, Event as SimEvent, EventId } from "../../../src/core/types";
import { api, type AgentRow, type EventQuery } from "../api";
import { compareTime, scalar, short, time } from "../format";
import { useLoad } from "../hooks";
import { Empty, ErrorBar, KindBadge, Loading } from "./Primitives";

const RECENT_TICKS = 8;
const RECENT_LIMIT = 50;
const PERSONA_PREFIX = "persona.";

interface Props {
	readonly runId: string;
	readonly agent: AgentRow | undefined;
	readonly activatedTicks: readonly number[];
	readonly tick: number | undefined;
	readonly version: number;
}

const recentQuery = (
	agent: EntityId,
	tick: number | undefined,
	activated: readonly number[],
): EventQuery => {
	if (tick !== undefined) return { agent, tick, limit: RECENT_LIMIT };
	const fromTick = activated[Math.max(0, activated.length - RECENT_TICKS)];
	const toTick = activated[activated.length - 1];
	return fromTick === undefined || toTick === undefined
		? { agent, limit: RECENT_LIMIT }
		: { agent, fromTick, toTick, limit: RECENT_LIMIT };
};

const summary = (e: SimEvent): string => {
	switch (e.kind) {
		case "decision":
			return `${e.payload.action}${e.payload.parseOk ? "" : " (fallback)"}`;
		case "observation":
			return `prompt ${short(e.payload.contentSha, 8)}${e.payload.truncated ? ", truncated" : ""}`;
		case "observation_batch":
			return `${e.payload.executor}, ${e.payload.count} agents`;
		case "decision_batch":
			return `${e.payload.executor}, ${e.payload.agentIds.length} agents via ${e.payload.provider}${e.payload.parseFailures > 0 ? `, ${e.payload.parseFailures} parse failures` : ""}`;
		case "failure":
			return `${e.payload.excType}: ${e.payload.message}`;
		case "llm_call":
			return `${e.payload.model}, ${e.payload.usage.promptTokens}+${e.payload.usage.completionTokens} tokens`;
		case "effect":
			return `${e.payload.effects.length} effects${e.payload.rejected.length > 0 ? `, ${e.payload.rejected.length} rejected` : ""}`;
		case "activation":
			return `${e.payload.policy}, ${e.payload.agentIds.length} agents`;
		case "measurement":
			return `${e.payload.name} = ${JSON.stringify(e.payload.value)}`;
		case "intervention":
			return `${e.payload.arm}, ${e.payload.targets.length} targets`;
		case "checkpoint":
			return e.payload.path;
		case "module_step":
			return e.payload.module;
	}
};

const effectText = (f: Effect): string => {
	switch (f.op) {
		case "set":
		case "inc":
		case "append":
			return `${f.op} ${f.entity}.${f.column} [${short(f.id, 8)}] ${scalar(f.value)}`;
		case "create":
			return `create ${f.entity} ${short(f.id, 8)} ${JSON.stringify(f.row)}`;
		case "delete":
			return `delete ${f.entity} ${short(f.id, 8)}`;
		case "envSet":
			return `envSet ${f.key} = ${JSON.stringify(f.value)}`;
		case "setColumn":
			return `setColumn ${f.entity}.${f.column} for ${f.ids.length} rows`;
	}
};

const ContentToggle = ({
	runId,
	sha,
	label,
}: {
	readonly runId: string;
	readonly sha: string;
	readonly label: string;
}) => {
	const [open, setOpen] = useState(false);
	const content = useLoad(
		async () => (open ? api.content(runId, sha) : undefined),
		[runId, sha, open],
	);
	return (
		<div className="content-toggle">
			<button type="button" className="link" onClick={() => setOpen((o) => !o)}>
				{open ? `Hide ${label}` : `Show ${label}`}
			</button>
			<span className="mono muted">{short(sha, 12)}</span>
			{open &&
				(content.error !== undefined ? (
					<ErrorBar message={content.error} />
				) : content.loading ? (
					<Loading />
				) : (
					<pre className="content">{content.data}</pre>
				))}
		</div>
	);
};

const EventDetail = ({ runId, event }: { readonly runId: string; readonly event: SimEvent }) => {
	switch (event.kind) {
		case "observation":
			return (
				<div className="detail">
					<div>
						{event.payload.refs.length} refs
						{event.payload.truncated ? ", truncated" : ""}
						{event.payload.promptHash !== undefined && (
							<>
								, prompt hash{" "}
								<span className="mono">{short(event.payload.promptHash, 12)}</span>
							</>
						)}
					</div>
					<ContentToggle runId={runId} sha={event.payload.contentSha} label="prompt" />
				</div>
			);
		case "decision":
			return (
				<div className="detail">
					<div>
						<strong>{event.payload.action}</strong> via {event.payload.provider}
						{event.payload.parseOk ? "" : ", parse failed, fallback"}
					</div>
					<pre className="json">{JSON.stringify(event.payload.args, null, 2)}</pre>
					{event.payload.soft !== undefined && (
						<pre className="json">{JSON.stringify(event.payload.soft, null, 2)}</pre>
					)}
					{event.payload.rationaleSha !== undefined && (
						<ContentToggle
							runId={runId}
							sha={event.payload.rationaleSha}
							label="rationale"
						/>
					)}
				</div>
			);
		case "llm_call":
			return (
				<div className="detail">
					<div>
						{event.payload.model}, {event.payload.usage.promptTokens} prompt,{" "}
						{event.payload.usage.completionTokens} completion,{" "}
						{event.payload.usage.cachedTokens} cached, {event.payload.latencyMs} ms
						{event.payload.recorded ? ", recorded" : ""}
					</div>
					<pre className="json">{JSON.stringify(event.payload.params)}</pre>
					<ContentToggle runId={runId} sha={event.payload.responseSha} label="response" />
				</div>
			);
		case "effect":
			return (
				<div className="detail">
					<ul className="effects mono">
						{event.payload.effects.map((f, i) => (
							<li key={i}>{effectText(f)}</li>
						))}
					</ul>
					{event.payload.rejected.length > 0 && (
						<ul className="effects mono danger">
							{event.payload.rejected.map((r, i) => (
								<li key={i}>
									rejected {effectText(r.effect)}: {r.reason}
								</li>
							))}
						</ul>
					)}
				</div>
			);
		case "activation":
			return (
				<div className="detail">
					{event.payload.policy}, {event.payload.agentIds.length} agents activated
				</div>
			);
		case "failure":
			return (
				<div className="detail">
					<div className="danger">
						{event.payload.stage}, {event.payload.excType}: {event.payload.message}
						{event.payload.retryable ? " (retryable)" : ""}
					</div>
					{event.payload.stack !== undefined && (
						<pre className="json">{event.payload.stack}</pre>
					)}
				</div>
			);
		default:
			return <pre className="json">{JSON.stringify(event.payload, null, 2)}</pre>;
	}
};

const ChainView = ({ runId, eventId }: { readonly runId: string; readonly eventId: EventId }) => {
	const chain = useLoad(() => api.chain(runId, eventId), [runId, eventId]);
	const sorted = [...(chain.data ?? [])].sort((a, b) => compareTime(a.t, b.t));
	return (
		<section>
			<h4>Causal chain</h4>
			{chain.error !== undefined && <ErrorBar message={chain.error} />}
			{chain.loading && chain.data === undefined ? (
				<Loading />
			) : sorted.length === 0 ? (
				<Empty label="No chain" small />
			) : (
				<ol className="chain">
					{sorted.map((e) => (
						<li key={e.eventId} className={e.eventId === eventId ? "anchor" : ""}>
							<div className="chain-head">
								<KindBadge kind={e.kind} />
								<span className="mono">{time(e.t)}</span>
								<span className="mono muted">{short(e.eventId, 12)}</span>
								{e.provenance !== undefined && (
									<span className="muted">{e.provenance}</span>
								)}
							</div>
							<EventDetail runId={runId} event={e} />
						</li>
					))}
				</ol>
			)}
		</section>
	);
};

const Fields = ({ entries }: { readonly entries: readonly (readonly [string, string])[] }) => (
	<dl className="kv">
		{entries.map(([k, v]) => (
			<Fragment key={k}>
				<dt>{k}</dt>
				<dd className="mono">{v}</dd>
			</Fragment>
		))}
	</dl>
);

export const AgentInspector = ({ runId, agent, activatedTicks, tick, version }: Props) => {
	const [eventId, setEventId] = useState<EventId | undefined>(undefined);
	const agentId = agent?.id;
	const events = useLoad(
		async () =>
			agentId === undefined
				? []
				: api.events(runId, recentQuery(agentId, tick, activatedTicks)),
		[runId, agentId, tick, activatedTicks, version],
	);
	useEffect(() => setEventId(undefined), [agentId]);

	if (agent === undefined)
		return (
			<div className="inspector">
				<div className="pane-title">Agent</div>
				<Empty label="Select a node to inspect an agent" />
			</div>
		);

	const entries = Object.entries(agent.columns).map(([k, v]) => [k, scalar(v)] as const);
	const persona = entries
		.filter(([k]) => k.startsWith(PERSONA_PREFIX))
		.map(([k, v]) => [k.slice(PERSONA_PREFIX.length), v] as const);
	const derived = entries.filter(([k]) => !k.startsWith(PERSONA_PREFIX));
	const sorted = [...(events.data ?? [])].sort((a, b) => compareTime(b.t, a.t));

	return (
		<div className="inspector">
			<div className="pane-title">
				<span>
					Agent <span className="mono">{agent.id}</span>
				</span>
			</div>
			<section>
				<h4>Persona</h4>
				{persona.length === 0 ? (
					<Empty label="No public persona fields" small />
				) : (
					<Fields entries={persona} />
				)}
			</section>
			{derived.length > 0 && (
				<section>
					<h4>Derived</h4>
					<Fields entries={derived} />
				</section>
			)}
			<section>
				<h4>Recent events{tick !== undefined ? ` at tick ${tick}` : ""}</h4>
				{events.error !== undefined && <ErrorBar message={events.error} />}
				{events.loading && events.data === undefined ? (
					<Loading />
				) : sorted.length === 0 ? (
					<Empty label="No events" small />
				) : (
					<ul className="event-list">
						{sorted.map((e) => (
							<li key={e.eventId}>
								<button
									type="button"
									className={`event-row${e.eventId === eventId ? " selected" : ""}`}
									onClick={() =>
										setEventId(e.eventId === eventId ? undefined : e.eventId)
									}
								>
									<span className="mono time">{time(e.t)}</span>
									<KindBadge kind={e.kind} />
									<span className="event-summary">{summary(e)}</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
			{eventId !== undefined && <ChainView runId={runId} eventId={eventId} />}
		</div>
	);
};
