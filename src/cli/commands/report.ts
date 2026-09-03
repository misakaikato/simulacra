// `simulacra report`: re-renders report.html from the audit.json of an audit directory, so a
// report can be regenerated after a renderer change without rerunning the audit.
// `simulacra report`：从审计目录的 audit.json 重新渲染 report.html，
// 渲染器变更后无需重跑审计即可再生成报告。

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { REPORT_FILE, readAuditReport, renderReportHtml } from "../../index";
import { fail, print } from "./shared";

export const reportCommand = defineCommand({
	meta: { name: "report", description: "Render report.html from an audit directory" },
	args: {
		auditDir: { type: "positional", description: "audit directory", required: true },
		out: { type: "string", description: "output file (default: <auditDir>/report.html)" },
	},
	run: ({ args }) => {
		const report = readAuditReport(args.auditDir);
		if (!report.ok) return fail(report.error);
		const path = args.out ?? join(args.auditDir, REPORT_FILE);
		writeFileSync(path, renderReportHtml(report.value));
		print(`report: ${path}`);
		print(`evidenceGrade: ${report.value.evidenceGrade}`);
	},
});
