// Pairwise test table of the audit page: filter by metric, rows sorted by |Cohen d| descending,
// Holm-corrected p below 0.05 highlighted and direction flips flagged.
// 审计页的成对检验表：按指标过滤，行按 |Cohen d| 降序，Holm 校正 p 低于 0.05 高亮，
// 并标出方向翻转。

import { useMemo, useState } from "react";
import type { PairwiseTest } from "../../../src/core/types";
import { num, pval } from "../format";
import { Empty } from "./Primitives";

const SIGNIFICANCE = 0.05;

export const PairwiseTable = ({ tests }: { readonly tests: readonly PairwiseTest[] }) => {
	const metrics = useMemo(() => [...new Set(tests.map((t) => t.metric))].sort(), [tests]);
	const [metric, setMetric] = useState("");
	const rows = useMemo(
		() =>
			tests
				.filter((t) => metric === "" || t.metric === metric)
				.sort((a, b) => Math.abs(b.cohenD) - Math.abs(a.cohenD)),
		[tests, metric],
	);
	if (tests.length === 0) return <Empty label="No pairwise tests" />;
	return (
		<div>
			<div className="toolbar">
				<label>
					Metric
					<select value={metric} onChange={(e) => setMetric(e.target.value)}>
						<option value="">all</option>
						{metrics.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
				</label>
				<span className="muted">
					{rows.length} tests sorted by |d|; Holm p below {SIGNIFICANCE} is highlighted
				</span>
			</div>
			<div className="scroll-x">
				<table className="table">
					<thead>
						<tr>
							<th>metric</th>
							<th>a</th>
							<th>b</th>
							<th className="num">nA</th>
							<th className="num">nB</th>
							<th className="num">mean a</th>
							<th className="num">mean b</th>
							<th className="num">diff</th>
							<th className="num">95% CI</th>
							<th className="num">d</th>
							<th className="num">MWU p</th>
							<th className="num">Holm p</th>
							<th>flip</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((t) => (
							<tr
								key={`${t.metric}|${t.a}|${t.b}`}
								className={t.holmP < SIGNIFICANCE ? "sig" : ""}
							>
								<td>{t.metric}</td>
								<td className="mono">{t.a}</td>
								<td className="mono">{t.b}</td>
								<td className="num">{t.nA}</td>
								<td className="num">{t.nB}</td>
								<td className="num">{num(t.meanA)}</td>
								<td className="num">{num(t.meanB)}</td>
								<td className="num">{num(t.meanDiff)}</td>
								<td className="num">
									[{num(t.ci95[0])}, {num(t.ci95[1])}]
								</td>
								<td className="num">{num(t.cohenD)}</td>
								<td className="num">{pval(t.mwuP)}</td>
								<td className="num">{pval(t.holmP)}</td>
								<td>{t.directionFlip ? <span className="flag">flip</span> : ""}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
};
