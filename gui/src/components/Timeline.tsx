// Left pane of the run page: one row per tick with the number of activated agents as a bar
// plus measurement and failure counts; clicking a row selects that tick for the graph, chart
// and inspector, clicking it again clears the selection.
// 运行页左栏：每个 tick 一行，激活的 agent 数画成条，另列测量与失败计数；点击某行把该 tick
// 选给图、折线与检视器，再点一次取消选择。

import { useMemo } from "react";
import type { Event as SimEvent } from "../../../src/core/types";
import { Empty } from "./Primitives";

interface TickRow {
	readonly tick: number;
	readonly activated: number;
	readonly measurements: number;
	readonly failures: number;
}

interface Props {
	readonly events: readonly SimEvent[];
	readonly selected: number | undefined;
	readonly onSelect: (tick: number | undefined) => void;
}

// Only activation, measurement and failure events reach the timeline, so counting stays cheap
// even for long runs; the activation bar is scaled to the busiest tick.
// 只有 activation、measurement 与 failure 事件进入时间轴，长运行的计数也很便宜；
// 激活条按最忙的 tick 归一。
const aggregate = (events: readonly SimEvent[]): readonly TickRow[] => {
	const rows = new Map<number, { activated: number; measurements: number; failures: number }>();
	for (const e of events) {
		const row = rows.get(e.t.tick) ?? { activated: 0, measurements: 0, failures: 0 };
		if (e.kind === "activation") row.activated += e.payload.agentIds.length;
		else if (e.kind === "measurement") row.measurements += 1;
		else if (e.kind === "failure") row.failures += 1;
		rows.set(e.t.tick, row);
	}
	return [...rows].map(([tick, row]) => ({ tick, ...row })).sort((a, b) => a.tick - b.tick);
};

export const Timeline = ({ events, selected, onSelect }: Props) => {
	const rows = useMemo(() => aggregate(events), [events]);
	const maxActivated = rows.reduce((m, r) => Math.max(m, r.activated), 0);
	return (
		<div className="timeline">
			<div className="pane-title">
				<span>Ticks</span>
				<button
					type="button"
					className="link"
					disabled={selected === undefined}
					onClick={() => onSelect(undefined)}
				>
					clear
				</button>
			</div>
			<div className="timeline-legend muted">activated / measurements / failures</div>
			{rows.length === 0 ? (
				<Empty label="No ticks yet" small />
			) : (
				<ul className="tick-list">
					{rows.map((r) => (
						<li key={r.tick}>
							<button
								type="button"
								className={`tick-row${r.tick === selected ? " selected" : ""}${r.failures > 0 ? " has-failure" : ""}`}
								onClick={() => onSelect(r.tick === selected ? undefined : r.tick)}
								title={`tick ${r.tick}: ${r.activated} activated, ${r.measurements} measurements, ${r.failures} failures`}
							>
								<span className="mono tick-no">{r.tick}</span>
								<span className="tick-bar-track">
									<span
										className="tick-bar"
										style={{
											width: `${maxActivated === 0 ? 0 : (r.activated / maxActivated) * 100}%`,
										}}
									/>
								</span>
								<span className="mono tick-meas">
									{r.measurements > 0 ? r.measurements : ""}
								</span>
								<span className="mono tick-fail">
									{r.failures > 0 ? r.failures : ""}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
};
