// Run a robustness audit from code: load the prisoner's dilemma plan, run three
// replications per condition with the mock provider, print the evidence grade and
// the most sensitive axis, and render the HTML report.
// 从代码发起稳健性审计：加载囚徒困境计划，每个条件用 mock provider 跑三次复制，
// 打印证据等级与最敏感的轴，并渲染 HTML 报告。
//
//   bun examples/programmatic/03-audit.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, kernelRunFn, loadAuditPlan, renderReportHtml, silentLogger } from "../../src/index";

const plan = loadAuditPlan("examples/prisoners_dilemma/audit.yaml");
if (!plan.ok) throw new Error(JSON.stringify(plan.error));

const outDir = mkdtempSync(join(tmpdir(), "simulacra-audit-"));
// kernelRunFn adapts runScenario to the harness's RunFn; replications overrides the plan so the
// example finishes in seconds. Three replications is below the 10 a moderate grade needs, so
// the grade is weak by construction.
// kernelRunFn 把 runScenario 适配成 harness 的 RunFn；replications 覆盖计划，示例几秒内跑完。
// 三次复制低于 moderate 等级所需的 10 次，因此等级注定是 weak。
const report = await audit(plan.value, kernelRunFn({ providerOverride: "mock" }), outDir, {
	logger: silentLogger,
	replications: 3,
	providerOverride: "mock",
});
if (!report.ok) throw new Error(JSON.stringify(report.error));

const r = report.value;
console.log(
	`evidence ${r.evidenceGrade}, ${r.conditions.length} conditions, ${r.runs.length} runs, ${r.pairwise.length} pairwise tests`,
);
const [axis, d] = r.sensitivityRank[0] ?? ["none", 0];
console.log(`most sensitive axis: ${axis} (max |d| = ${d.toFixed(3)})`);
for (const [outcome, share] of Object.entries(r.directionConsistency)) {
	console.log(`direction consistency for ${outcome}: ${(share * 100).toFixed(0)}%`);
}

// The report is one self-contained HTML file; the CLI's `report` command produces the same bytes.
// 报告是一个自包含的 HTML 文件；CLI 的 `report` 命令产出同样的字节。
const html = renderReportHtml(r);
writeFileSync(join(outDir, "report.html"), html);
console.log(`report: ${html.length} bytes of self-contained HTML`);
rmSync(outDir, { recursive: true, force: true });
