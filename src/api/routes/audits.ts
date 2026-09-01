import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
	REPORT_FILE,
	loadScenario,
	ok,
	parseAuditPlan,
	parseAuditPlanYaml,
	type AuditPlan,
	type Result,
	type StartAuditError,
} from "../../index";
import {
	ProviderSchema,
	badRequest,
	conflict,
	exampleDirOf,
	issuesOf,
	notFound,
	readJsonBody,
	type ApiDeps,
	type ApiIssue,
} from "./shared";

const NewAuditSchema = z.object({
	plan: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
	name: z.string().min(1).optional(),
	replications: z.number().int().positive().optional(),
	provider: ProviderSchema.optional(),
});

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
