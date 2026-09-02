import { z } from "zod";
import type { AuditPlan, AuditReport, EntityId, RunId, RunResult, Scalar } from "../index";

export type RunStatus = "running" | "succeeded" | "failed";

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
}

export interface Example {
	readonly name: string;
	readonly yaml: string;
}

export const ProviderSchema = z.enum(["mock", "llm"]);
export type ProviderChoice = z.infer<typeof ProviderSchema>;

const DocumentSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

export const NewRunSchema = z.object({
	scenario: DocumentSchema,
	seed: z.number().int(),
	ticks: z.number().int().positive().optional(),
	provider: ProviderSchema.optional(),
});
export type NewRun = z.input<typeof NewRunSchema>;

export const NewAuditSchema = z.object({
	plan: DocumentSchema,
	name: z.string().min(1).optional(),
	replications: z.number().int().positive().optional(),
	provider: ProviderSchema.optional(),
});
export type NewAudit = z.input<typeof NewAuditSchema>;

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
