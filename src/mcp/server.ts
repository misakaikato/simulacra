import { dirname, join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	EVENT_KINDS,
	doctor,
	examplePath,
	inspect,
	listExamples,
	loadAuditPlan,
	loadScenario,
	ok,
	parseAuditPlanYaml,
	renderInspect,
	toEntityId,
	toRunId,
	version,
	withRunLog,
	type AuditReport,
	type AuditSummary,
	type Logger,
	type RunId,
	type RunRegistry,
	type RunSummary,
	type StartAuditError,
} from "../index";

export interface McpServerOptions {
	readonly registry: RunRegistry;
	readonly logger: Logger;
}

export const RUN_RESULT_TEMPLATE = "simulacra://runs/{runId}/result";
export const AUDIT_REPORT_TEMPLATE = "simulacra://audits/{auditId}/report";
export const AUDIT_PLAN_FILE = "audit.yaml";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const JSON_MIME = "application/json";

interface Issue {
	readonly path: string;
	readonly message: string;
}

type ToolText = CallToolResult;

const ProviderSchema = z.enum(["mock", "llm"]);
const RunIdSchema = z.string().min(1);

const render = (lines: readonly string[], json: unknown): ToolText => ({
	content: [{ type: "text", text: `${lines.join("\n")}\n\n${JSON.stringify(json, null, "\t")}` }],
});

const failure = (message: string, issues: readonly Issue[] = []): ToolText => ({
	isError: true,
	content: [
		{
			type: "text",
			text: `error: ${message}\n\n${JSON.stringify({ error: message, issues }, null, "\t")}`,
		},
	],
});

const issuesOf = (
	issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
	prefix: string,
): readonly Issue[] =>
	issues.map((i) => ({
		path: [prefix, ...i.path.map(String)].filter((s) => s.length > 0).join("."),
		message: i.message,
	}));

const runUri = (runId: RunId): string => RUN_RESULT_TEMPLATE.replace("{runId}", String(runId));
const auditUri = (auditId: string): string => AUDIT_REPORT_TEMPLATE.replace("{auditId}", auditId);

const runLines = (summary: RunSummary): readonly string[] => {
	const { progress, result } = summary;
	const lines = [
		`run ${summary.runId} ${progress.status} (tick ${progress.tick}/${progress.ticks}, ${summary.agentCount} agents)`,
	];
	if (result === undefined) return lines;
	const i = result.integrity;
	const c = result.cost;
	lines.push(
		`integrity: activated=${i.activated} ok=${i.ok} failed=${i.failed} parseFailures=${i.parseFailures} llmFailures=${i.llmFailures} droppedEffects=${i.droppedEffects} rejectedActions=${i.rejectedActions} complete=${i.complete}`,
		`cost: llmCalls=${c.llmCalls} promptTokens=${c.promptTokens} completionTokens=${c.completionTokens} cachedTokens=${c.cachedTokens} wallMs=${c.wallMs}`,
	);
	const metrics = Object.entries(result.metrics).map(([k, v]) => `${k}=${v}`);
	lines.push(`metrics: ${metrics.length === 0 ? "none" : metrics.join(" ")}`);
	if (result.failure !== undefined)
		lines.push(`failure: ${result.failure.excType}: ${result.failure.message}`);
	lines.push(`resource: ${runUri(summary.runId)}`);
	return lines;
};

const runJson = (summary: RunSummary): unknown => ({
	runId: summary.runId,
	progress: summary.progress,
	agentCount: summary.agentCount,
	...(summary.result === undefined ? {} : { result: summary.result }),
	resource: runUri(summary.runId),
});

const condensedReport = (report: AuditReport): unknown => ({
	planHash: report.planHash,
	evidenceGrade: report.evidenceGrade,
	plan: report.plan,
	options: report.options,
	conditions: report.conditions.map((c) => ({
		conditionId: c.conditionId,
		model: c.model,
		axisValues: c.axisValues,
		...(c.flags === undefined ? {} : { flags: c.flags }),
	})),
	runs: report.runs.length,
	pairwise: report.pairwise,
	directionConsistency: report.directionConsistency,
	sensitivityRank: report.sensitivityRank,
	distributionTests: report.distributionTests,
	crossModel: report.crossModel,
	integritySummary: report.integritySummary,
	costSummary: report.costSummary,
});

const auditLines = (summary: AuditSummary): readonly string[] => {
	const { progress, report } = summary;
	const lines = [
		`audit ${summary.auditId} ${progress.status} (${progress.completed}/${progress.total} runs)`,
	];
	if (report === undefined) return lines;
	const i = report.integritySummary;
	lines.push(
		`evidenceGrade: ${report.evidenceGrade}`,
		`conditions: ${report.conditions.length}`,
		`runs: ${report.runs.length} (failed: ${i.failed ?? 0}, incomplete: ${i.incomplete ?? 0}, excluded: ${i.excluded ?? 0})`,
		`pairwise: ${report.pairwise.length}`,
		`sensitivity: ${report.sensitivityRank.map(([axis, d]) => `${axis}=${d}`).join(" ") || "none"}`,
		`resource: ${auditUri(summary.auditId)}`,
	);
	return lines;
};

const auditJson = (summary: AuditSummary): unknown => ({
	auditId: summary.auditId,
	progress: summary.progress,
	...(summary.report === undefined ? {} : { report: condensedReport(summary.report) }),
	resource: auditUri(summary.auditId),
});

const describeAuditError = (e: StartAuditError): Issue => {
	switch (e.kind) {
		case "AuditExists":
			return { path: "name", message: `audit ${e.auditId} already exists` };
		case "InvalidAuditName":
			return { path: "name", message: `invalid audit name '${e.name}'` };
		case "UnknownOverride":
			return { path: "plan.axes", message: `unknown axis target '${e.path}'` };
		case "InvalidOverride":
			return {
				path: "plan.axes",
				message: `axis target '${e.path}' produces an invalid scenario`,
			};
	}
};

const awaitRun = (registry: RunRegistry, runId: RunId): Promise<RunSummary | undefined> =>
	new Promise((resolve) => {
		const unsubscribe = registry.subscribe(runId, (message) => {
			if (message.kind === "done") resolve(registry.getRun(runId));
		});
		if (unsubscribe === undefined) resolve(registry.getRun(runId));
	});

const awaitAudit = (registry: RunRegistry, auditId: string): Promise<AuditSummary | undefined> =>
	new Promise((resolve) => {
		const unsubscribe = registry.subscribeAudit(auditId, (message) => {
			if (message.kind === "done") resolve(registry.getAudit(auditId));
		});
		if (unsubscribe === undefined) resolve(registry.getAudit(auditId));
	});

export const createMcpServer = (opts: McpServerOptions): McpServer => {
	const { registry } = opts;
	const logger = opts.logger.child({ component: "mcp" });
	const server = new McpServer({ name: "simulacra", version });
	const variable = (value: string | string[] | undefined): string => {
		const raw = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
		try {
			return decodeURIComponent(raw);
		} catch (e) {
			logger.warn("resource variable is not valid percent-encoding, using it verbatim", {
				raw,
				error: e instanceof Error ? e.message : String(e),
			});
			return raw;
		}
	};

	server.registerTool(
		"list_examples",
		{
			description: "List the built-in example scenarios (name and scenario.yaml path)",
			inputSchema: {},
		},
		() => {
			const examples = listExamples().map((name) => ({
				name,
				path: examplePath(name),
				hasAuditPlan: Bun.file(join(dirname(examplePath(name)), AUDIT_PLAN_FILE)).size > 0,
			}));
			return render(
				examples.map((e) => `${e.name}\t${e.path}`),
				examples,
			);
		},
	);

	server.registerTool(
		"run_scenario",
		{
			description:
				"Run a scenario to completion and return its runId with the RunResult summary. Pass either scenarioYaml (YAML text) or example (a built-in example name).",
			inputSchema: {
				scenarioYaml: z.string().min(1).optional(),
				example: z.string().min(1).optional(),
				seed: z.number().int(),
				ticks: z.number().int().positive().optional(),
				provider: ProviderSchema.optional(),
			},
		},
		async (args) => {
			if ((args.scenarioYaml === undefined) === (args.example === undefined))
				return failure("provide exactly one of scenarioYaml or example", [
					{
						path: "scenarioYaml",
						message: "exactly one of scenarioYaml or example is required",
					},
				]);
			if (args.example !== undefined && !listExamples().includes(args.example))
				return failure(`unknown example '${args.example}'`, [
					{ path: "example", message: `known examples: ${listExamples().join(", ")}` },
				]);
			const loaded = loadScenario(
				args.example === undefined ? (args.scenarioYaml ?? "") : examplePath(args.example),
			);
			if (!loaded.ok)
				return failure("invalid scenario", issuesOf(loaded.error, "scenarioYaml"));
			const started = registry.startRun({
				scenario: loaded.value,
				seed: args.seed,
				...(args.ticks === undefined ? {} : { ticks: args.ticks }),
				...(args.provider === undefined ? {} : { provider: args.provider }),
			});
			if (!started.ok)
				return failure(`run ${started.error.runId} already exists`, [
					{
						path: "scenarioYaml",
						message: "change scenarioId or use a fresh data directory",
					},
				]);
			logger.info("run started", { runId: started.value.runId });
			const summary = await awaitRun(registry, started.value.runId);
			if (summary === undefined) return failure(`run ${started.value.runId} vanished`);
			return render(runLines(summary), runJson(summary));
		},
	);

	server.registerTool(
		"get_run",
		{
			description: "Progress and RunResult of a run by runId",
			inputSchema: { runId: RunIdSchema },
		},
		(args) => {
			const summary = registry.getRun(toRunId(args.runId));
			if (summary === undefined) return failure(`unknown run ${args.runId}`);
			return render(runLines(summary), runJson(summary));
		},
	);

	server.registerTool(
		"query_events",
		{
			description:
				"Events of a run in time order, filtered by kind, agentId and tick (default 200, at most 1000)",
			inputSchema: {
				runId: RunIdSchema,
				kind: z.enum(EVENT_KINDS).optional(),
				agentId: z.string().min(1).optional(),
				tick: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().optional(),
			},
		},
		(args) => {
			const runId = toRunId(args.runId);
			if (registry.getRun(runId) === undefined) return failure(`unknown run ${args.runId}`);
			const events = withRunLog(registry.runDir(runId), (log) =>
				ok(
					log.query({
						...(args.kind === undefined ? {} : { kind: [args.kind] }),
						...(args.agentId === undefined
							? {}
							: { agentId: toEntityId(args.agentId) }),
						...(args.tick === undefined ? {} : { tick: args.tick }),
						limit: Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
					}),
				),
			);
			if (!events.ok) return failure(events.error);
			return render([`${events.value.length} events of run ${args.runId}`], events.value);
		},
	);

	server.registerTool(
		"get_agent_trace",
		{
			description:
				"Readable causal chain of one agent's decision (observation, prompt preview, decision, effects, failures); tick defaults to the latest decision",
			inputSchema: {
				runId: RunIdSchema,
				agentId: z.string().min(1),
				tick: z.number().int().nonnegative().optional(),
			},
		},
		(args) => {
			const runId = toRunId(args.runId);
			if (registry.getRun(runId) === undefined) return failure(`unknown run ${args.runId}`);
			const trace = inspect(registry.runDir(runId), {
				agentId: toEntityId(args.agentId),
				...(args.tick === undefined ? {} : { tick: args.tick }),
			});
			if (!trace.ok) return failure(trace.error);
			return render(renderInspect(trace.value), trace.value);
		},
	);

	server.registerTool(
		"run_audit",
		{
			description:
				"Run a robustness audit plan to completion and return the report summary. Pass either planYaml (YAML text) or examplePlan (a built-in example name whose audit.yaml is used).",
			inputSchema: {
				planYaml: z.string().min(1).optional(),
				examplePlan: z.string().min(1).optional(),
				name: z.string().min(1).optional(),
				replications: z.number().int().positive().optional(),
				provider: ProviderSchema.optional(),
			},
		},
		async (args) => {
			if ((args.planYaml === undefined) === (args.examplePlan === undefined))
				return failure("provide exactly one of planYaml or examplePlan", [
					{
						path: "planYaml",
						message: "exactly one of planYaml or examplePlan is required",
					},
				]);
			if (args.examplePlan !== undefined && !listExamples().includes(args.examplePlan))
				return failure(`unknown example '${args.examplePlan}'`, [
					{
						path: "examplePlan",
						message: `known examples: ${listExamples().join(", ")}`,
					},
				]);
			const plan =
				args.examplePlan === undefined
					? parseAuditPlanYaml(args.planYaml ?? "", {
							baseDir: process.cwd(),
							loadScenario,
						})
					: loadAuditPlan(join(dirname(examplePath(args.examplePlan)), AUDIT_PLAN_FILE));
			if (!plan.ok) return failure("invalid audit plan", issuesOf(plan.error, "planYaml"));
			const started = registry.startAudit({
				plan: plan.value,
				...(args.name === undefined ? {} : { name: args.name }),
				...(args.replications === undefined ? {} : { replications: args.replications }),
				...(args.provider === undefined ? {} : { provider: args.provider }),
			});
			if (!started.ok) {
				const issue = describeAuditError(started.error);
				return failure(issue.message, [issue]);
			}
			logger.info("audit started", { auditId: started.value.auditId });
			const summary = await awaitAudit(registry, started.value.auditId);
			if (summary === undefined) return failure(`audit ${started.value.auditId} vanished`);
			return render(auditLines(summary), auditJson(summary));
		},
	);

	server.registerTool(
		"get_audit",
		{
			description: "Progress and report summary of an audit by auditId",
			inputSchema: { auditId: z.string().min(1) },
		},
		(args) => {
			const summary = registry.getAudit(args.auditId);
			if (summary === undefined) return failure(`unknown audit ${args.auditId}`);
			return render(auditLines(summary), auditJson(summary));
		},
	);

	server.registerTool(
		"doctor",
		{
			description:
				"Check the environment; with llm=true also probe the configured LLM endpoint (at most 6 calls)",
			inputSchema: { llm: z.boolean().optional() },
		},
		async (args) => {
			const checks = await doctor({ llm: args.llm === true });
			if (!checks.ok) return failure(checks.error);
			return render(
				checks.value.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`),
				checks.value,
			);
		},
	);

	server.registerResource(
		"run-result",
		new ResourceTemplate(RUN_RESULT_TEMPLATE, {
			list: () => ({
				resources: registry.listRuns().map((r) => ({
					uri: runUri(r.runId),
					name: String(r.runId),
					mimeType: JSON_MIME,
				})),
			}),
		}),
		{ description: "Progress and RunResult of a run", mimeType: JSON_MIME },
		(uri, variables) => {
			const summary = registry.getRun(toRunId(variable(variables.runId)));
			if (summary === undefined) throw new Error(`unknown run ${variable(variables.runId)}`);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: JSON_MIME,
						text: JSON.stringify(runJson(summary), null, "\t"),
					},
				],
			};
		},
	);

	server.registerResource(
		"audit-report",
		new ResourceTemplate(AUDIT_REPORT_TEMPLATE, {
			list: () => ({
				resources: registry.listAudits().map((a) => ({
					uri: auditUri(a.auditId),
					name: a.auditId,
					mimeType: JSON_MIME,
				})),
			}),
		}),
		{ description: "Full AuditReport of an audit", mimeType: JSON_MIME },
		(uri, variables) => {
			const summary = registry.getAudit(variable(variables.auditId));
			if (summary === undefined)
				throw new Error(`unknown audit ${variable(variables.auditId)}`);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: JSON_MIME,
						text: JSON.stringify(
							{
								auditId: summary.auditId,
								progress: summary.progress,
								report: summary.report ?? null,
							},
							null,
							"\t",
						),
					},
				],
			};
		},
	);

	return server;
};
