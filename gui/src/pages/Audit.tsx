import { Fragment } from "react";
import type { AuditPlan, AuditReport, Condition } from "../../../src/core/types";
import { api } from "../api";
import { CostList } from "../components/IntegrityPanel";
import { PairwiseTable } from "../components/PairwiseTable";
import { Empty, ErrorBar, Loading, StatusBadge } from "../components/Primitives";
import { num, pct, short } from "../format";
import { useInterval, useLoad } from "../hooks";

const GRADE_RULES: Readonly<Record<AuditReport["evidenceGrade"], string>> = {
	weak: "fewer than 10 replications, or an axis with fewer than 2 levels",
	moderate: "at least 10 replications and every axis has at least 2 levels",
	strong: "at least 30 replications, every axis has at least 3 levels and at least 2 models; policy claims also need axes at the micro, meso and macro levels",
};

const PlanSummary = ({ plan }: { readonly plan: AuditPlan }) => (
	<div className="stack">
		<dl className="kv wide">
			<dt>scenario</dt>
			<dd className="mono">{plan.base.scenarioId}</dd>
			<dt>design</dt>
			<dd>{plan.design}</dd>
			<dt>replications</dt>
			<dd className="mono">{plan.replications}</dd>
			<dt>models</dt>
			<dd className="mono">
				{plan.models.length === 0 ? "scenario default" : plan.models.join(", ")}
			</dd>
			<dt>metrics</dt>
			<dd className="mono">{plan.metrics.join(", ")}</dd>
			<dt>claim type</dt>
			<dd>{plan.claimType}</dd>
			{plan.hypothesis !== undefined && (
				<>
					<dt>hypothesis</dt>
					<dd>
						<span className="mono">{plan.hypothesis.id}</span> {plan.hypothesis.claim}
					</dd>
				</>
			)}
		</dl>
		{plan.axes.length === 0 ? (
			<Empty label="No perturbation axes" small />
		) : (
			<table className="table">
				<thead>
					<tr>
						<th>axis</th>
						<th>level</th>
						<th>kind</th>
						<th>dimension</th>
						<th>target</th>
						<th>levels</th>
					</tr>
				</thead>
				<tbody>
					{plan.axes.map((axis) => (
						<tr key={axis.id}>
							<td className="mono">{axis.id}</td>
							<td>{axis.level}</td>
							<td>{axis.kind}</td>
							<td>{axis.dimension}</td>
							<td className="mono">{axis.target}</td>
							<td className="mono">
								{axis.levels.map((l) => JSON.stringify(l)).join(", ")}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		)}
	</div>
);

const ConditionsTable = ({ conditions }: { readonly conditions: readonly Condition[] }) =>
	conditions.length === 0 ? (
		<Empty label="No conditions" small />
	) : (
		<table className="table">
			<thead>
				<tr>
					<th>condition</th>
					<th>model</th>
					<th>axis values</th>
					<th className="num">seed</th>
				</tr>
			</thead>
			<tbody>
				{conditions.map((c) => (
					<tr key={c.conditionId}>
						<td className="mono">{c.conditionId}</td>
						<td className="mono">{c.model}</td>
						<td className="mono">
							{Object.entries(c.axisValues)
								.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
								.join("  ") || "baseline"}
						</td>
						<td className="num">{c.scenario.seed}</td>
					</tr>
				))}
			</tbody>
		</table>
	);

const SensitivityBars = ({ rank }: { readonly rank: AuditReport["sensitivityRank"] }) => {
	if (rank.length === 0) return <Empty label="No axes" small />;
	const max = rank.reduce((m, [, v]) => Math.max(m, Math.abs(v)), 1e-9);
	const rowH = 24;
	const labelW = 160;
	const barW = 300;
	const valueW = 64;
	const width = labelW + barW + valueW;
	const height = rank.length * rowH;
	return (
		<svg
			className="bars"
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			role="img"
			aria-label="Maximum absolute Cohen d per axis"
		>
			{rank.map(([axis, value], i) => {
				const w = (Math.abs(value) / max) * barW;
				return (
					<g key={axis} transform={`translate(0 ${i * rowH})`}>
						<text
							x={labelW - 8}
							y={rowH / 2}
							textAnchor="end"
							dominantBaseline="middle"
							className="bar-label"
						>
							{axis}
						</text>
						<rect x={labelW} y={5} width={w} height={rowH - 10} className="bar" />
						<text
							x={labelW + w + 6}
							y={rowH / 2}
							dominantBaseline="middle"
							className="bar-value"
						>
							{num(value)}
						</text>
					</g>
				);
			})}
		</svg>
	);
};

const RateTable = ({ rates }: { readonly rates: Readonly<Record<string, number>> }) => {
	const entries = Object.entries(rates).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return <Empty label="No direction data" small />;
	return (
		<dl className="kv">
			{entries.map(([metric, rate]) => (
				<Fragment key={metric}>
					<dt>{metric}</dt>
					<dd className="mono">{pct(rate)}</dd>
				</Fragment>
			))}
		</dl>
	);
};

const CrossModelTable = ({ table }: { readonly table: AuditReport["crossModel"] }) => {
	const rows = Object.keys(table).sort();
	const columns = [...new Set(rows.flatMap((r) => Object.keys(table[r] ?? {})))].sort();
	if (rows.length === 0) return <Empty label="Single model, no cross-model comparison" small />;
	return (
		<table className="table">
			<thead>
				<tr>
					<th>model</th>
					{columns.map((c) => (
						<th key={c} className="num">
							{c}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((r) => (
					<tr key={r}>
						<td className="mono">{r}</td>
						{columns.map((c) => {
							const v = table[r]?.[c];
							return (
								<td key={c} className="num">
									{v === undefined ? "–" : num(v)}
								</td>
							);
						})}
					</tr>
				))}
			</tbody>
		</table>
	);
};

const DistributionTable = ({ tests }: { readonly tests: AuditReport["distributionTests"] }) => (
	<table className="table">
		<thead>
			<tr>
				<th>metric</th>
				<th>a</th>
				<th>b</th>
				<th className="num">W1</th>
				<th className="num">Cliff delta</th>
				<th className="num">TVD</th>
			</tr>
		</thead>
		<tbody>
			{tests.map((t) => (
				<tr key={`${t.metric}|${t.a}|${t.b}`}>
					<td>{t.metric}</td>
					<td className="mono">{t.a}</td>
					<td className="mono">{t.b}</td>
					<td className="num">{num(t.w1)}</td>
					<td className="num">{num(t.cliffDelta)}</td>
					<td className="num">{t.tvd === undefined ? "–" : num(t.tvd)}</td>
				</tr>
			))}
		</tbody>
	</table>
);

const Report = ({ report }: { readonly report: AuditReport }) => (
	<>
		<section className="panel">
			<h3>Conditions</h3>
			<ConditionsTable conditions={report.conditions} />
		</section>
		<section className="panel">
			<h3>Pairwise tests</h3>
			<PairwiseTable tests={report.pairwise} />
		</section>
		<div className="two-col">
			<section className="panel">
				<h3>Sensitivity by axis</h3>
				<SensitivityBars rank={report.sensitivityRank} />
			</section>
			<section className="panel">
				<h3>Direction consistency</h3>
				<RateTable rates={report.directionConsistency} />
			</section>
		</div>
		<section className="panel">
			<h3>Cross-model means</h3>
			<CrossModelTable table={report.crossModel} />
		</section>
		{report.distributionTests.length > 0 && (
			<section className="panel">
				<h3>Distribution tests</h3>
				<DistributionTable tests={report.distributionTests} />
			</section>
		)}
		<div className="two-col">
			<section className="panel">
				<h3>Integrity</h3>
				<dl className="kv">
					{Object.entries(report.integritySummary).map(([k, v]) => (
						<Fragment key={k}>
							<dt>{k}</dt>
							<dd className="mono">{num(v)}</dd>
						</Fragment>
					))}
				</dl>
			</section>
			<section className="panel">
				<h3>Cost</h3>
				<CostList cost={report.costSummary} />
			</section>
		</div>
	</>
);

export const Audit = ({ id }: { readonly id: string }) => {
	const audit = useLoad(() => api.audit(id), [id]);
	const running = audit.data?.progress.status === "running";
	useInterval(audit.reload, running ? 3000 : null);
	if (audit.error !== undefined)
		return (
			<div className="page">
				<ErrorBar message={audit.error} />
			</div>
		);
	if (audit.data === undefined)
		return (
			<div className="page">
				<Loading label="Loading audit" />
			</div>
		);
	const { plan, report, progress } = audit.data;
	return (
		<div className="page">
			<header className="page-header">
				<a href="#/runs" className="link">
					Runs
				</a>
				<span className="muted">/</span>
				<span className="mono">{id}</span>
				<StatusBadge status={progress.status} />
				<span className="mono muted">
					{progress.completed} / {progress.total} runs
				</span>
				{report !== undefined && (
					<a className="button" href={api.reportUrl(id)} target="_blank" rel="noreferrer">
						report.html
					</a>
				)}
			</header>
			<section className="panel">
				<h3>Plan</h3>
				{report !== undefined && (
					<div className="grade">
						<span className={`badge badge-grade-${report.evidenceGrade}`}>
							{report.evidenceGrade}
						</span>
						<span className="muted">{GRADE_RULES[report.evidenceGrade]}</span>
						<span className="mono muted" title={report.planHash}>
							plan {short(report.planHash, 12)}
						</span>
					</div>
				)}
				{plan === undefined ? (
					<Empty label="Plan not available" small />
				) : (
					<PlanSummary plan={plan} />
				)}
			</section>
			{report === undefined ? (
				<Empty label={running ? "Report is produced when all runs finish" : "No report"} />
			) : (
				<Report report={report} />
			)}
		</div>
	);
};
