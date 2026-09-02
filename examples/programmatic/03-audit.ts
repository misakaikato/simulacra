// Run a robustness audit from code: load the prisoner's dilemma plan, run three
// replications per condition with the mock provider, print the evidence grade and
// the most sensitive axis, and render the HTML report.
//
//   bun examples/programmatic/03-audit.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, kernelRunFn, loadAuditPlan, renderReportHtml, silentLogger } from "../../src/index";

const plan = loadAuditPlan("examples/prisoners_dilemma/audit.yaml");
if (!plan.ok) throw new Error(JSON.stringify(plan.error));

const outDir = mkdtempSync(join(tmpdir(), "simulacra-audit-"));
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

const html = renderReportHtml(r);
writeFileSync(join(outDir, "report.html"), html);
console.log(`report: ${html.length} bytes of self-contained HTML`);
rmSync(outDir, { recursive: true, force: true });
