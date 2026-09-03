// Hono routes for audits: list, create, summary and report.html; creation parses the plan with
// the same loaders as the CLI and starts it in the background through the run registry.
// 审计相关的 Hono 路由：列表、创建、摘要与 report.html；创建时用与 CLI 相同的加载器解析计划，
// 经运行注册表在后台启动。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
	NewAuditSchema,
	REPORT_FILE,
	loadScenario,
	ok,
	parseAuditPlan,
	parseAuditPlanYaml,
	type ApiIssue,
	type AuditPlan,
	type Result,
	type StartAuditError,
} from "../../index";
import {
	badRequest,
	conflict,
	exampleDirOf,
	issuesOf,
	notFound,
	readJsonBody,
	type ApiDeps,
} from "./shared";

// YAML text gets the example-directory lookup so a shipped audit.yaml resolves its base
// scenario path; objects resolve against the server cwd.
// YAML 文本走示例目录查找，随包的 audit.yaml 才能解析到其基础场景路径；对象按服务进程的 cwd 解析。
const planOf = (raw: string | Record<string, unknown>): Result<AuditPlan, readonly ApiIssue[]> => {
	const parsed =
		typeof raw === "string"
			? parseAuditPlanYaml(raw, {
					baseDir: exampleDirOf(raw, "audit.yaml") ?? process.cwd(),
					loadScenario,
				})
			: parseAuditPlan(raw, { baseDir: process.cwd(), loadScenario });
	return parsed.ok ? ok(parsed.value) : { ok: false, error: issuesOf(parsed.error, "plan") };
};

const describeStartError = (e: StartAuditError): ApiIssue => {
	switch (e.kind) {
		case "AuditExists":
			return { path: "name", message: `audit ${e.auditId} already exists` };
		case "InvalidAuditName":
			return {
				path: "name",
				message:
					"audit names use letters, digits, '.', '_' and '-' and start with a letter or digit",
			};
		case "UnknownOverride":
			return { path: "plan.axes", message: `unknown axis target '${e.path}'` };
		case "InvalidOverride":
			return {
				path: "plan.axes",
				message: `axis target '${e.path}' produces an invalid scenario: ${e.issues
					.map((i) => `${i.path.join(".")} ${i.message}`)
					.join("; ")}`,
			};
	}
};

export const auditRoutes = (deps: ApiDeps): Hono => {
	const { registry } = deps;
	const app = new Hono();

	app.get("/", (c) => c.json(registry.listAudits()));

	app.post("/", async (c) => {
		const body = await readJsonBody(c);
		if (!body.ok) return badRequest(c, body.error);
		const parsed = NewAuditSchema.safeParse(body.value);
		if (!parsed.success) return badRequest(c, issuesOf(parsed.error.issues));
		const plan = planOf(parsed.data.plan);
		if (!plan.ok) return badRequest(c, plan.error);
		const started = registry.startAudit({
			plan: plan.value,
			...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
			...(parsed.data.replications === undefined
				? {}
				: { replications: parsed.data.replications }),
			...(parsed.data.provider === undefined ? {} : { provider: parsed.data.provider }),
		});
		// Only AuditExists is a 409; name and axis problems are 400 with the issue pointing at the
		// body field, mirroring how zod failures are reported.
		// 只有 AuditExists 是 409；名字与轴的问题是 400，issue 指向请求体字段，与 zod 失败的报法一致。
		if (started.ok) return c.json({ auditId: started.value.auditId }, 201);
		const issue = describeStartError(started.error);
		return started.error.kind === "AuditExists"
			? conflict(c, issue.message)
			: badRequest(c, [issue]);
	});

	app.get("/:id", (c) => {
		const summary = registry.getAudit(c.req.param("id"));
		return summary === undefined
			? notFound(c, `unknown audit ${c.req.param("id")}`)
			: c.json(summary);
	});

	app.get("/:id/report.html", (c) => {
		const id = c.req.param("id");
		const summary = registry.getAudit(id);
		if (summary === undefined) return notFound(c, `unknown audit ${id}`);
		const path = join(registry.auditDir(id), REPORT_FILE);
		if (!existsSync(path)) return notFound(c, `audit ${id} has no report yet`);
		return c.html(readFileSync(path, "utf8"));
	});

	return app;
};
