// Vocabulary shared by focal components: the memory entry shape that memory components exchange
// through the context and the context keys the executor and prompt renderer agree on.
// focal 组件共享的词汇表：记忆组件通过上下文交换的记忆条目形状，
// 以及执行体与 prompt 渲染器约定的上下文键名。

import { z } from "zod";
import { LogicalTimeSchema } from "../../core/schema";
import type { JsonValue } from "../../core/types";

// Every memory entry carries the id of the event it came from so the prompt can cite it and a
// consumer can walk back to the log; `kind` distinguishes decisions, observations and summaries.
// 每条记忆都带来源事件的 id，prompt 可以引用、消费方可以回溯到日志；
// `kind` 区分决策、观察与摘要。
export const MemoryEntrySchema = z.object({
	eventId: z.string().min(1),
	t: LogicalTimeSchema,
	kind: z.string(),
	text: z.string(),
});

export const MemoryListSchema = z.array(MemoryEntrySchema);

export const memoryEntriesOf = (
	value: JsonValue | undefined,
): z.output<typeof MemoryListSchema> => {
	const parsed = MemoryListSchema.safeParse(value ?? []);
	return parsed.success ? parsed.data : [];
};

export const CONTEXT_KEYS = {
	persona: "persona",
	name: "name",
	instructions: "instructions",
	memory: "memory",
	feed: "feed",
	neighbors: "neighbors",
	intervention: "intervention",
} as const;

export const INTERVENTION_INSTRUCTION_KEY = "instruction";
