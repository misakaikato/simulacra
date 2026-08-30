import { z } from "zod";
import { LogicalTimeSchema } from "../../core/schema";
import type { JsonValue } from "../../core/types";

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
} as const;
