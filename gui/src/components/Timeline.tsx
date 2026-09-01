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
