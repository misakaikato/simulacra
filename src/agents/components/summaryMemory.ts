// Summary-memory component: reads the memory list an earlier component produced, replaces entries
// covered by an LLM-written summary and asks the gateway for a new summary once the uncovered
// tail exceeds the threshold. Every call is an llm_call event; a missing gateway is a failure.
// 摘要记忆组件：读取前面组件产出的记忆列表，用 LLM 写的摘要替换已覆盖的条目，
// 未覆盖的尾部超过阈值时向网关请求新摘要。每次调用都是 llm_call 事件；没有网关记为失败。

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

// `upTo` is the logical time of the last entry folded into the summary; entries newer than it
// are still shown verbatim. `covered` counts how many entries the summary chain has absorbed.
// `upTo` 是摘要吸收的最后一条记忆的逻辑时间，比它新的条目仍原样展示；
// `covered` 累计摘要链吸收过的条目数。
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
	readonly gateway?: LLMGateway;
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
	private readonly gateway: LLMGateway | undefined;
	private readonly logger: Logger;
	private summaries = new Map<string, Summary>();
	private readonly pending = new Map<string, readonly Entry[]>();

	constructor(options: SummaryMemoryOptions, deps: SummaryMemoryDeps) {
		this.options = options;
		this.gateway = deps.gateway;
		this.logger = deps.logger.child({ component: "summaryMemory" });
	}

	// The uncovered tail is stashed per agent here and consumed in consolidate, so the decision
	// about whether to summarise is based on exactly what the prompt showed this tick.
	// 未覆盖的尾部按 agent 暂存于此、在 consolidate 中消费，是否摘要的判断因此严格基于本 tick
	// prompt 实际展示的内容。
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

	// The summary's event id is drawn from the consolidate rng before the gateway call and reused
	// as the llm_call event id and the nonce tag, so replays reproduce the same ids and records.
	// 摘要的事件 id 在调网关之前就从 consolidate 的 rng 派生，同时用作 llm_call 事件 id 与
	// nonce 标签，回放因此得到相同的 id 与录制记录。
	async consolidate(agentId: EntityId, log: EventLog, ctx: ConsolidateContext): Promise<void> {
		const recent = this.pending.get(agentId) ?? [];
		this.pending.delete(agentId);
		if (recent.length <= this.options.threshold) return;
		const previous = this.summaries.get(agentId);
		const eventId = newEventId(ctx.rng);
		const fields = {
			eventId,
			runId: ctx.runId,
			t: ctx.t,
			seedPath: ctx.seedPath,
			agentId,
			provenance: "llm" as const,
		};
		if (this.gateway === undefined) {
			this.recordFailure(
				log,
				fields,
				FAILURE_TYPES.gatewayMissing,
				"no gateway available",
				false,
			);
			return;
		}
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
		if (!result.ok) {
			this.recordFailure(
				log,
				fields,
				result.error.excType,
				result.error.message,
				result.error.retryable,
			);
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

	private recordFailure(
		log: EventLog,
		fields: Parameters<typeof makeEvent>[0],
		cause: string,
		message: string,
		retryable: boolean,
	): void {
		log.append(
			makeEvent(fields, {
				kind: "failure",
				payload: {
					stage: PURPOSE,
					excType: FAILURE_TYPES.memorySummaryFailed,
					message: `${cause}: ${message}`,
					retryable,
				},
			}),
		);
		this.logger.error("memory summary failed", {
			agentId: fields.agentId ?? null,
			cause,
			message,
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
