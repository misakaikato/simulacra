// Run page: four panes (timeline, network canvas, agent inspector, metrics with integrity) fed
// by the initial REST loads and, while the run is running, by incremental SSE updates to the
// timeline and metric series; when the stream reports done every pane reloads once.
// 运行页：四栏（时间轴、网络画布、agent 检视、指标与完整性），先由 REST 初始加载，
// 运行中再由 SSE 增量更新时间轴与指标序列；流报告 done 后各栏整体重载一次。

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

// Points arrive in tick order; one at or before the last tick is the REST load overlapping
// the stream and is dropped.
// 点按 tick 顺序到达；不晚于最后一个 tick 的点是 REST 加载与流重叠所致，直接丢弃。
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
	// The stream is opened only while the status is running. Event ids dedupe timeline entries
	// because the REST load and the stream may overlap; onDone bumps version so agents, graph,
	// metrics and the inspector refetch the final state.
	// 只在状态为 running 时打开流。时间轴条目按事件 id 去重，因为 REST 加载与流可能重叠；
	// onDone 递增 version，让 agent、图、指标与检视器重新拉取最终状态。
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
	// A 5 s summary poll backs up the stream so the header tick still advances when SSE is
	// held back by a proxy.
	// 每 5 秒轮询一次摘要给流兜底，SSE 被代理拦住时页头的 tick 仍会前进。
	useInterval(reloadSummary, status === "running" ? POLL_MS : null);

	const agentMap = useMemo(
		() => new Map((agents.data ?? []).map((a) => [a.id, a])),
		[agents.data],
	);
	const selectedAgent = selected === undefined ? undefined : agentMap.get(selected);
	// Ticks in which the selected agent was activated drive the inspector's recent window.
	// 所选 agent 被激活的 tick 决定检视器的最近事件窗口。
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
