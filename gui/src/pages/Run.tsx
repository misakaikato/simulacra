import { useEffect, useMemo, useState } from "react";
import type { EntityId, Event as SimEvent, EventKind } from "../../../src/core/types";
import { allEvents, api, streamRun, type MetricPoint, type MetricSeries } from "../api";
import { AgentInspector } from "../components/AgentInspector";
import { IntegrityPanel } from "../components/IntegrityPanel";
import { MetricChart } from "../components/MetricChart";
import { NetworkCanvas } from "../components/NetworkCanvas";
import { ErrorBar, Loading, StatusBadge } from "../components/Primitives";
import { Timeline } from "../components/Timeline";
import { useInterval, useLoad } from "../hooks";

const TIMELINE_KINDS: readonly EventKind[] = ["activation", "measurement", "failure"];
const POLL_MS = 5000;

const appendPoint = (series: MetricSeries, name: string, point: MetricPoint): MetricSeries => {
	const existing = series[name] ?? [];
	const last = existing[existing.length - 1];
	if (last !== undefined && last.tick >= point.tick) return series;
	return { ...series, [name]: [...existing, point] };
};

export const Run = ({ id }: { readonly id: string }) => {
	const summary = useLoad(() => api.run(id), [id]);
	const [version, setVersion] = useState(0);
	const timelineLoad = useLoad(() => allEvents(id, { kind: TIMELINE_KINDS }), [id, version]);
	const metricsLoad = useLoad(() => api.metrics(id), [id, version]);
	const agents = useLoad(() => api.agents(id), [id, version]);
	const [tick, setTick] = useState<number | undefined>(undefined);
	const graph = useLoad(() => api.graph(id, tick), [id, tick, version]);
	const [selected, setSelected] = useState<EntityId | undefined>(undefined);
	const [timeline, setTimeline] = useState<readonly SimEvent[]>([]);
	const [metrics, setMetrics] = useState<MetricSeries>({});
	const [liveTick, setLiveTick] = useState(0);
	const [streamError, setStreamError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (timelineLoad.data !== undefined) setTimeline(timelineLoad.data);
	}, [timelineLoad.data]);
	useEffect(() => {
		if (metricsLoad.data !== undefined) setMetrics(metricsLoad.data);
	}, [metricsLoad.data]);

	const status = summary.data?.progress.status;
	const reloadSummary = summary.reload;
	useEffect(() => {
		if (status !== "running") return undefined;
		return streamRun(id, {
			onEvent: (e) => {
				setLiveTick((t) => Math.max(t, e.t.tick));
				if (TIMELINE_KINDS.includes(e.kind))
					setTimeline((prev) =>
						prev.some((x) => x.eventId === e.eventId) ? prev : [...prev, e],
					);
				if (e.kind === "measurement" && typeof e.payload.value === "number") {
					const point = { tick: e.t.tick, value: e.payload.value };
					setMetrics((prev) => appendPoint(prev, e.payload.name, point));
				}
			},
			onDone: () => {
				setVersion((v) => v + 1);
				reloadSummary();
			},
			onError: setStreamError,
		});
	}, [id, status, reloadSummary]);
	useInterval(reloadSummary, status === "running" ? POLL_MS : null);

	const agentMap = useMemo(
		() => new Map((agents.data ?? []).map((a) => [a.id, a])),
		[agents.data],
	);
	const selectedAgent = selected === undefined ? undefined : agentMap.get(selected);
	const activatedTicks = useMemo(
		() =>
			selected === undefined
				? []
				: timeline
						.filter(
							(e) => e.kind === "activation" && e.payload.agentIds.includes(selected),
						)
						.map((e) => e.t.tick)
						.sort((a, b) => a - b),
		[timeline, selected],
	);

	if (summary.error !== undefined)
		return (
			<div className="page">
				<ErrorBar message={summary.error} />
			</div>
		);
	if (summary.data === undefined)
		return (
			<div className="page">
				<Loading label="Loading run" />
			</div>
		);
	const run = summary.data;
	const currentTick = Math.max(run.progress.tick, liveTick);
	const errors = [
		timelineLoad.error,
		metricsLoad.error,
		agents.error,
		graph.error,
		streamError,
	].filter((e): e is string => e !== undefined);

	return (
		<div className="run">
			<header className="run-header">
				<a href="#/runs" className="link">
					Runs
				</a>
				<span className="muted">/</span>
				<span className="mono">{run.runId}</span>
				<StatusBadge status={run.progress.status} />
				<span className="mono muted">
					tick {currentTick} / {run.progress.ticks}
				</span>
				<span className="mono muted">{run.agentCount} agents</span>
				{tick !== undefined && <span className="mono muted">viewing tick {tick}</span>}
			</header>
			{errors.length > 0 && (
				<div className="run-errors">
					{errors.map((e) => (
						<ErrorBar key={e} message={e} />
					))}
				</div>
			)}
			<aside className="run-left">
				<Timeline events={timeline} selected={tick} onSelect={setTick} />
			</aside>
			<section className="run-center">
				{agents.data === undefined && agents.loading ? (
					<Loading label="Loading agents" />
				) : (
					<NetworkCanvas
						agents={agents.data ?? []}
						edges={graph.data?.edges ?? []}
						selected={selected}
						onSelect={setSelected}
					/>
				)}
			</section>
			<aside className="run-right">
				<AgentInspector
					runId={id}
					agent={selectedAgent}
					activatedTicks={activatedTicks}
					tick={tick}
					version={version}
				/>
			</aside>
			<section className="run-bottom">
				<div className="metrics-pane">
					<div className="pane-title">Metrics</div>
					<MetricChart series={metrics} marker={tick} />
				</div>
				<IntegrityPanel summary={run} />
			</section>
		</div>
	);
};
