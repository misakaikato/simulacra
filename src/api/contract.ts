// Single definition of the HTTP contract shared by the API, the MCP server and the GUI: the
// envelope types (RunSummary, AuditSummary, GraphSnapshot, AgentRow, MetricSeries) and the zod
// schemas for POST bodies. Types and zod only, no hono import, so gui/src/api.ts can
// `import type` from here instead of redefining anything.
// API、MCP 服务与 GUI 共用的 HTTP 契约的唯一定义：信封类型（RunSummary、AuditSummary、
// GraphSnapshot、AgentRow、MetricSeries）与 POST 请求体的 zod schema。只含类型与 zod、
// 不引 hono，因此 gui/src/api.ts 可以只 `import type`，不再重复定义。

import { z } from "zod";
import type { AuditPlan, AuditReport, EntityId, RunId, RunResult, Scalar } from "../index";

export type RunStatus = "running" | "succeeded" | "failed";

// tick is the last tick that activated agents while running and the total (or the failing
// tick) once finished; a summary's error reports an unreadable result.json without hiding the
// run directory.
// tick 在运行中是最近激活了 agent 的 tick，结束后是总 tick 数（或失败所在的 tick）；
// 摘要里的 error 报告 result.json 不可读，而不是把该运行目录藏起来。
export interface RunProgress {
	readonly tick: number;
	readonly ticks: number;
	readonly status: RunStatus;
}

export interface RunSummary {
	readonly runId: RunId;
	readonly progress: RunProgress;
	readonly agentCount: number;
	readonly result?: RunResult;
	readonly error?: string;
}

export interface AuditProgress {
	readonly completed: number;
	readonly total: number;
	readonly status: RunStatus;
}

export interface AuditSummary {
	readonly auditId: string;
	readonly progress: AuditProgress;
	readonly plan?: AuditPlan;
	readonly report?: AuditReport;
	readonly error?: string;
}

export interface Example {
	readonly name: string;
	readonly yaml: string;
}

export const ProviderSchema = z.enum(["mock", "llm"]);
export type ProviderChoice = z.infer<typeof ProviderSchema>;

// Names become directory segments, so only filename-safe characters are allowed; the registry
// applies the same rule to audit ids.
// 名字会成为目录名的一段，因此只允许文件名安全的字符；注册表对审计 id 套用同一规则。
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const NameSchema = z
	.string()
	.regex(
		NAME_PATTERN,
		"names use letters, digits, '.', '_' and '-' and start with a letter or digit",
	);

// A document is YAML text or an already parsed object; only the shape is checked here, the
// routes validate the content with the scenario and plan parsers.
// 文档是 YAML 文本或已解析的对象；这里只查形状，内容由路由用场景与计划解析器校验。
const DocumentSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

export const NewRunSchema = z.object({
	scenario: DocumentSchema,
	name: NameSchema.optional(),
	seed: z.number().int(),
	ticks: z.number().int().positive().optional(),
	provider: ProviderSchema.optional(),
});
export type NewRun = z.input<typeof NewRunSchema>;

export const NewAuditSchema = z.object({
	plan: DocumentSchema,
	name: NameSchema.optional(),
	replications: z.number().int().positive().optional(),
	provider: ProviderSchema.optional(),
});
export type NewAudit = z.input<typeof NewAuditSchema>;

// columns holds the public persona.* columns plus the derived counters decisions and failures;
// private persona fields never leave the server.
// columns 只含公开的 persona.* 列与派生计数 decisions、failures；私有 persona 字段绝不离开服务器。
export interface AgentRow {
	readonly id: EntityId;
	readonly columns: Readonly<Record<string, Scalar>>;
}

export interface GraphEdge {
	readonly src: EntityId;
	readonly dst: EntityId;
	readonly kind: string;
}

export interface GraphSnapshot {
	readonly tick: number;
	readonly edges: readonly GraphEdge[];
}

export interface MetricPoint {
	readonly tick: number;
	readonly value: number;
}

export type MetricSeries = Readonly<Record<string, readonly MetricPoint[]>>;

export interface ApiIssue {
	readonly path: string;
	readonly message: string;
}

export interface ApiIssuesBody {
	readonly issues: readonly ApiIssue[];
}

export interface ApiErrorBody {
	readonly error: string;
}
