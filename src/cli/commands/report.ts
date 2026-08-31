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
