import type {
	AuditReport,
	Condition,
	DistributionTest,
	JsonValue,
	PairwiseTest,
	RunResult,
} from "../core/types";

const ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);

export const formatNumber = (x: number | null | undefined, digits = 4): string => {
	if (typeof x !== "number" || Number.isNaN(x)) return "n/a";
	if (x === Number.POSITIVE_INFINITY) return "inf";
	if (x === Number.NEGATIVE_INFINITY) return "-inf";
	if (Number.isInteger(x)) return String(x);
	if (x !== 0 && Math.abs(x) < 1e-3) return x.toExponential(2);
	return x.toFixed(digits);
};

const json = (v: JsonValue): string => escapeHtml(JSON.stringify(v));

const cell = (text: string, numeric = false): string =>
	numeric ? `<td class="num">${text}</td>` : `<td>${text}</td>`;

const mono = (text: string): string => `<span class="mono">${escapeHtml(text)}</span>`;

const table = (
	headers: readonly (readonly [string, boolean])[],
	rows: readonly string[],
): string =>
	rows.length === 0
		? `<p class="muted">none</p>`
		: `<div class="scroll"><table><thead><tr>${headers
				.map(([h, numeric]) => `<th${numeric ? ' class="num"' : ""}>${escapeHtml(h)}</th>`)
				.join(
					"",
				)}</tr></thead><tbody>${rows.map((r) => `<tr>${r}</tr>`).join("")}</tbody></table></div>`;

const section = (id: string, title: string, body: string, note?: string): string =>
	`<section id="${id}"><h2>${escapeHtml(title)}</h2>${
		note === undefined ? "" : `<p class="muted">${escapeHtml(note)}</p>`
	}${body}</section>`;

const GRADE_NOTE =
	"weak: fewer than 10 replications or an axis with a single level; " +
	"moderate: at least 10 replications and every axis with at least 2 levels; " +
	"strong: at least 30 replications, every axis with at least 3 levels and at least 2 models " +
	"(policy claims also need axes at the micro, meso and macro levels).";

const absOrder = (a: number, b: number): number => {
	const x = Math.abs(a);
	const y = Math.abs(b);
	if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
	if (Number.isNaN(y)) return -1;
	return y - x;
};

interface ConditionSummary {
	readonly condition: Condition;
	readonly runs: number;
	readonly succeeded: number;
	readonly complete: number;
	readonly means: Readonly<Record<string, number>>;
}

const summarizeConditions = (report: AuditReport): readonly ConditionSummary[] =>
	report.conditions.map((condition) => {
		const results: RunResult[] = [];
		report.runIndex.forEach((ref, i) => {
			const result = report.runs[i];
			if (ref.conditionId === condition.conditionId && result !== undefined)
				results.push(result);
		});
		const usable = results.filter(
			(r) =>
				r.status === "succeeded" &&
				(report.options.includeIncomplete || r.integrity.complete),
		);
		const means: Record<string, number> = {};
		for (const metric of report.plan.metrics) {
			const values = usable.flatMap((r) => {
				const v = r.metrics[metric];
				return v === undefined ? [] : [v];
			});
			if (values.length > 0)
				means[metric] = values.reduce((a, b) => a + b, 0) / values.length;
		}
		return {
			condition,
			runs: results.length,
			succeeded: results.filter((r) => r.status === "succeeded").length,
			complete: results.filter((r) => r.integrity.complete).length,
			means,
		};
	});

const summaryBlock = (report: AuditReport): string => {
	const i = report.integritySummary;
	const items: readonly (readonly [string, string])[] = [
		["scenario", mono(report.plan.scenarioId)],
		["design", escapeHtml(report.plan.design)],
		["claim type", escapeHtml(report.plan.claimType)],
		["replications", mono(String(report.plan.replications))],
		["conditions", mono(String(report.conditions.length))],
		["runs", mono(String(i.runs ?? report.runs.length))],
		["failed runs", mono(String(i.failed ?? 0))],
		["incomplete runs", mono(String(i.incomplete ?? 0))],
		["excluded from statistics", mono(String(i.excluded ?? 0))],
		[
			"models",
			mono(
				report.plan.models.length === 0 ? "base model only" : report.plan.models.join(", "),
			),
		],
		["metrics", mono(report.plan.metrics.join(", "))],
		["provider override", mono(report.options.providerOverride ?? "none")],
	];
	return `<dl class="facts">${items
		.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`)
		.join("")}</dl>`;
};

const axesTable = (report: AuditReport): string =>
	table(
		[
			["axis", false],
			["level", false],
			["kind", false],
			["dimension", false],
			["target", false],
			["levels", false],
		],
		report.plan.axes.map(
			(axis) =>
				cell(mono(axis.id)) +
				cell(escapeHtml(axis.level)) +
				cell(escapeHtml(axis.kind)) +
				cell(escapeHtml(axis.dimension)) +
				cell(mono(axis.target)) +
				cell(`<span class="mono">${axis.levels.map(json).join(", ")}</span>`),
		),
	);

const conditionsTable = (report: AuditReport): string => {
	const metrics = report.plan.metrics;
	return table(
		[
			["condition", false],
			["model", false],
			["axis values", false],
			["flags", false],
			["runs", true],
			["succeeded", true],
			["complete", true],
			...metrics.map((m): readonly [string, boolean] => [`mean ${m}`, true]),
		],
		summarizeConditions(report).map(
			(s) =>
				cell(mono(s.condition.conditionId)) +
				cell(mono(s.condition.model)) +
				cell(`<span class="mono">${json(s.condition.axisValues)}</span>`) +
				cell(escapeHtml((s.condition.flags ?? []).join(", "))) +
				cell(mono(String(s.runs)), true) +
				cell(mono(String(s.succeeded)), true) +
				cell(mono(String(s.complete)), true) +
				metrics.map((m) => cell(mono(formatNumber(s.means[m])), true)).join(""),
		),
	);
};

const pairwiseRow = (t: PairwiseTest): string =>
	cell(mono(t.b)) +
	cell(mono(t.a)) +
	cell(mono(`${t.nA} / ${t.nB}`), true) +
	cell(mono(formatNumber(t.meanA)), true) +
	cell(mono(formatNumber(t.meanB)), true) +
	cell(mono(formatNumber(t.meanDiff)), true) +
	cell(mono(`[${formatNumber(t.ci95[0])}, ${formatNumber(t.ci95[1])}]`), true) +
	cell(mono(formatNumber(t.cohenD)), true) +
	cell(mono(formatNumber(t.mwuP)), true) +
	cell(mono(formatNumber(t.holmP)), true) +
	cell(t.directionFlip ? `<span class="flag">flip</span>` : "");

const pairwiseSection = (report: AuditReport): string => {
	const metrics = [...new Set(report.pairwise.map((t) => t.metric))];
	if (metrics.length === 0)
		return `<p class="muted">no pairwise tests (fewer than 2 usable replications per condition)</p>`;
	return metrics
		.map((metric) => {
			const rows = [...report.pairwise.filter((t) => t.metric === metric)]
				.sort((x, y) => absOrder(x.cohenD, y.cohenD) || x.b.localeCompare(y.b))
				.map(pairwiseRow);
			return `<h3>${mono(metric)}</h3>${table(
				[
					["condition", false],
					["baseline", false],
					["n base / n cond", true],
					["mean base", true],
					["mean cond", true],
					["diff", true],
					["95% CI (bootstrap)", true],
					["Cohen d", true],
					["MWU p", true],
					["Holm p", true],
					["direction", false],
				],
				rows,
			)}`;
		})
		.join("");
};

const sensitivitySvg = (report: AuditReport): string => {
	const rows = report.sensitivityRank;
	if (rows.length === 0) return `<p class="muted">none</p>`;
	const finite = rows.map(([, v]) => v).filter((v) => Number.isFinite(v));
	const max = Math.max(1e-12, ...finite);
	const rowHeight = 26;
	const labelWidth = 220;
	const barWidth = 420;
	const height = rows.length * rowHeight + 8;
	const bars = rows
		.map(([axis, value], i) => {
			const y = i * rowHeight + 4;
			const width = Number.isFinite(value) ? (value / max) * barWidth : barWidth;
			return (
				`<text x="${labelWidth - 8}" y="${y + 17}" text-anchor="end" class="mono">${escapeHtml(axis)}</text>` +
				`<rect x="${labelWidth}" y="${y + 4}" width="${width.toFixed(1)}" height="${rowHeight - 8}" rx="2" class="bar"></rect>` +
				`<text x="${labelWidth + width + 6}" y="${y + 17}" class="mono">${formatNumber(value, 3)}</text>`
			);
		})
		.join("");
	const total = labelWidth + barWidth + 90;
	return `<div class="scroll"><svg viewBox="0 0 ${total} ${height}" width="${total}" height="${height}" role="img" aria-label="sensitivity by axis">${bars}</svg></div>`;
};

const directionTable = (report: AuditReport): string =>
	table(
		[
			["metric", false],
			["direction consistency", true],
		],
		Object.entries(report.directionConsistency).map(
			([metric, value]) => cell(mono(metric)) + cell(mono(formatNumber(value)), true),
		),
	);

const crossModelTable = (report: AuditReport): string => {
	const metrics = report.plan.metrics;
	return table(
		[["model", false], ...metrics.map((m): readonly [string, boolean] => [m, true])],
		Object.entries(report.crossModel).map(
			([model, row]) =>
				cell(mono(model)) +
				metrics.map((m) => cell(mono(formatNumber(row[m])), true)).join(""),
		),
	);
};

const distributionRow = (t: DistributionTest): string =>
	cell(mono(t.metric)) +
	cell(mono(t.b)) +
	cell(mono(t.a)) +
	cell(mono(formatNumber(t.w1)), true) +
	cell(mono(formatNumber(t.cliffDelta)), true) +
	cell(mono(t.tvd === undefined ? "n/a" : formatNumber(t.tvd)), true) +
	cell(mono(t.tvdBase === undefined ? "n/a" : formatNumber(t.tvdBase)), true);

const distributionTable = (report: AuditReport): string =>
	table(
		[
			["metric", false],
			["condition", false],
			["baseline", false],
			["W1", true],
			["Cliff delta", true],
			["normalised TVD (cond)", true],
			["normalised TVD (base)", true],
		],
		report.distributionTests.map(distributionRow),
	);

const integrityTable = (report: AuditReport): string => {
	const c = report.costSummary;
	const rows = Object.entries(report.integritySummary).map(
		([k, v]) => cell(escapeHtml(k)) + cell(mono(String(v)), true),
	);
	const cost = [
		["llm calls", c.llmCalls],
		["prompt tokens", c.promptTokens],
		["completion tokens", c.completionTokens],
		["cached tokens", c.cachedTokens],
		["wall ms", c.wallMs],
	] as const;
	return `<div class="columns"><div><h3>integrity</h3>${table(
		[
			["counter", false],
			["value", true],
		],
		rows,
	)}</div><div><h3>cost</h3>${table(
		[
			["counter", false],
			["value", true],
		],
		cost.map(([k, v]) => cell(escapeHtml(k)) + cell(mono(String(v)), true)),
	)}</div></div>`;
};

const STYLE = `
:root { color-scheme: light dark; --bg: #f5f6f8; --fg: #1e2329; --muted: #5f6b78; --line: #d5dbe2; --card: #ffffff; --accent: #0e7c89; --accent-soft: #d6ecef; --flag: #9a4b12; }
@media (prefers-color-scheme: dark) { :root { --bg: #141719; --fg: #e4e8ec; --muted: #98a3ae; --line: #2b3239; --card: #1b2024; --accent: #46b8c4; --accent-soft: #163a3f; --flag: #e0a15a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.45; }
main { max-width: 1120px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.75rem 1.25rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.6rem; margin: 0; }
h2 { font-size: 1.15rem; margin: 2rem 0 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 0.95rem; margin: 1rem 0 0.4rem; }
.mono, code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-variant-numeric: tabular-nums; font-size: 0.92em; }
.muted { color: var(--muted); }
.grade { display: inline-block; padding: 0.15rem 0.7rem; border-radius: 999px; font-weight: 600; background: var(--accent-soft); color: var(--accent); }
.flag { color: var(--flag); font-weight: 600; }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.5rem 1rem; margin: 0; }
.facts div { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 0.5rem 0.75rem; }
.facts dt { color: var(--muted); font-size: 0.8rem; }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.88rem; background: var(--card); }
th, td { border-bottom: 1px solid var(--line); padding: 0.4rem 0.55rem; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
th.num, td.num { text-align: right; white-space: nowrap; }
.columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
svg text { fill: var(--fg); font-size: 12px; }
svg .bar { fill: var(--accent); }
`;

export const renderReportHtml = (report: AuditReport): string =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Robustness audit ${escapeHtml(report.plan.scenarioId)}</title><style>${STYLE}</style></head><body><main>` +
	`<header><h1>Robustness audit</h1><span class="grade">${escapeHtml(report.evidenceGrade)}</span><span class="mono muted">plan ${escapeHtml(report.planHash)}</span></header>` +
	section("summary", "Plan summary", summaryBlock(report), GRADE_NOTE) +
	section("axes", "Perturbation axes", axesTable(report)) +
	section("conditions", "Conditions", conditionsTable(report)) +
	section(
		"pairwise",
		"Pairwise tests against the baseline",
		pairwiseSection(report),
		"Grouped by metric, ordered by |Cohen d|. Holm correction is applied within each metric; the bootstrap CI is seeded from the plan hash.",
	) +
	section(
		"sensitivity",
		"Sensitivity by axis",
		sensitivitySvg(report),
		"Largest |Cohen d| observed for any level of the axis across all metrics.",
	) +
	section(
		"direction",
		"Direction consistency",
		directionTable(report),
		"Share of conditions whose mean moves in the direction the hypothesis expects.",
	) +
	section("cross-model", "Cross-model means", crossModelTable(report)) +
	section(
		"distributions",
		"Distribution tests",
		distributionTable(report),
		"Pooled per-run distributions: W1 between baseline and condition, Cliff delta of condition over baseline, TVD to the target normalised by the target's TVD to uniform.",
	) +
	section("integrity", "Integrity and cost", integrityTable(report)) +
	`</main></body></html>`;
