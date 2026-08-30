import { z } from "zod";
import { makeEvent } from "../../core/events";
import { FAILURE_TYPES } from "../../core/failures";
import { newEventId } from "../../core/ids";
import type {
	Component,
	ConsolidateContext,
	EventLog,
	LLMGateway,
	WorldView,
} from "../../core/protocols";
import { LogicalTimeSchema } from "../../core/schema";
import { compareTime } from "../../core/time";
import type { EntityId, JsonObject, JsonValue, LogicalTime } from "../../core/types";
import type { Logger } from "../../logging/logger";
import { CONTEXT_KEYS, memoryEntriesOf, type MemoryEntrySchema } from "./shared";

type Entry = z.output<typeof MemoryEntrySchema>;

const SummarySchema = z.object({
	text: z.string(),
	eventId: z.string().min(1),
	t: LogicalTimeSchema,
	upTo: LogicalTimeSchema,
	covered: z.number().int().nonnegative(),
});
const StateSchema = z.object({ summaries: z.record(z.string(), SummarySchema) });

type Summary = z.output<typeof SummarySchema>;

export interface SummaryMemoryOptions {
	readonly threshold: number;
	readonly maxTokens?: number;
}

export interface SummaryMemoryDeps {
	readonly gateway: LLMGateway;
	readonly logger: Logger;
}

const SYSTEM = "You compress an agent's memory into a short first-person summary.";
const MAX_TOKENS = 256;
const PURPOSE = "memory_summary";

const newerThan = (entries: readonly Entry[], t: LogicalTime | undefined): readonly Entry[] =>
	t === undefined ? entries : entries.filter((e) => compareTime(e.t, t) > 0);

const summaryEntry = (s: Summary): Entry => ({
	eventId: s.eventId,
	t: s.t,
	kind: "summary",
	text: s.text,
});

const summaryPrompt = (previous: Summary | undefined, entries: readonly Entry[]): string =>
	[
		previous === undefined ? "" : `Earlier summary:\n${previous.text}\n`,
		"New memory entries:",
		...entries.map((e) => `- [tick ${e.t.tick}] ${e.kind}: ${e.text}`),
		"",
		"Write one paragraph (at most 120 words) that preserves what matters for future decisions.",
	].join("\n");

class SummaryMemory implements Component {
	readonly name = "summaryMemory";
	readonly reads = [CONTEXT_KEYS.memory];
	readonly writes = [CONTEXT_KEYS.memory];
	private readonly options: SummaryMemoryOptions;
	private readonly gateway: LLMGateway;
	private readonly logger: Logger;
	private summaries = new Map<string, Summary>();
	private readonly pending = new Map<string, readonly Entry[]>();

	constructor(options: SummaryMemoryOptions, deps: SummaryMemoryDeps) {
		this.options = options;
		this.gateway = deps.gateway;
		this.logger = deps.logger.child({ component: "summaryMemory" });
	}

	preAct(
		agentId: EntityId,
		_view: WorldView,
		_t: LogicalTime,
		ctx: ReadonlyMap<string, JsonValue>,
	): JsonObject {
		const entries = memoryEntriesOf(ctx.get(CONTEXT_KEYS.memory));
		const summary = this.summaries.get(agentId);
		const recent = newerThan(entries, summary?.upTo);
		this.pending.set(agentId, recent);
		const memory = summary === undefined ? recent : [summaryEntry(summary), ...recent];
		return { [CONTEXT_KEYS.memory]: memory as JsonValue };
	}

	postAct(): void {}

	async consolidate(agentId: EntityId, log: EventLog, ctx: ConsolidateContext): Promise<void> {
		const recent = this.pending.get(agentId) ?? [];
		this.pending.delete(agentId);
		if (recent.length <= this.options.threshold) return;
		const previous = this.summaries.get(agentId);
		const eventId = newEventId(ctx.rng);
		const result = await this.gateway.complete({
			messages: [
				{ role: "system", content: SYSTEM },
				{ role: "user", content: summaryPrompt(previous, recent) },
			],
			temperature: 0,
			maxTokens: this.options.maxTokens ?? MAX_TOKENS,
			tags: { purpose: PURPOSE, eventId, agentId },
			homogeneousGuard: true,
		});
		const fields = {
			eventId,
			runId: ctx.runId,
			t: ctx.t,
			seedPath: ctx.seedPath,
			agentId,
			provenance: "llm" as const,
		};
		if (!result.ok) {
			log.append(
				makeEvent(fields, {
					kind: "failure",
					payload: {
						stage: PURPOSE,
						excType: FAILURE_TYPES.memorySummaryFailed,
						message: `${result.error.excType}: ${result.error.message}`,
						retryable: result.error.retryable,
					},
				}),
			);
			this.logger.error("memory summary failed", {
				agentId,
				excType: result.error.excType,
				message: result.error.message,
			});
			return;
		}
		log.putContent(result.value.text);
		log.append(
			makeEvent(fields, {
				kind: "llm_call",
				payload: {
					promptHash: result.value.promptHash,
					responseSha: result.value.responseSha,
					model: result.value.model,
					params: { temperature: 0, maxTokens: this.options.maxTokens ?? MAX_TOKENS },
					usage: result.value.usage,
					latencyMs: result.value.latencyMs,
					recorded: result.value.recorded,
				},
			}),
		);
		const last = recent[recent.length - 1];
		this.summaries.set(agentId, {
			text: result.value.text.trim(),
			eventId,
			t: ctx.t,
			upTo: last === undefined ? ctx.t : last.t,
			covered: (previous?.covered ?? 0) + recent.length,
		});
	}

	getState(): JsonValue {
		const summaries: Record<string, Summary> = {};
		for (const [id, s] of this.summaries) summaries[id] = s;
		return { summaries };
	}

	setState(s: JsonValue): void {
		const parsed = StateSchema.safeParse(s);
		if (!parsed.success) return;
		this.summaries = new Map(Object.entries(parsed.data.summaries));
	}
}

export const summaryMemory = (options: SummaryMemoryOptions, deps: SummaryMemoryDeps): Component =>
	new SummaryMemory(options, deps);
