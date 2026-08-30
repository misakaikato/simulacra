import { describe, expect, test } from "bun:test";
import { toEntityId, toEventId } from "../../src/core/ids";
import { renderPrompt, type MemoryEntry, type PromptInput } from "../../src/core/prompt";
import { PromptOptionsSchema } from "../../src/core/schema";
import { timeAt } from "../../src/core/time";
import type { PromptOptions } from "../../src/core/types";

const agentId = toEntityId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

const memory = (n: number): readonly MemoryEntry[] =>
	Array.from({ length: n }, (_, i) => ({
		eventId: toEventId(`01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, "0")}`),
		t: timeAt(i),
		kind: "decision",
		text: `did thing ${i} with a fairly long description to consume characters`,
	}));

const input = (overrides: Partial<PromptInput> = {}): PromptInput => ({
	agentId,
	name: "Alice",
	persona: { age: 34, stance: "pro", tags: ["a", "b"] },
	instructions: "Behave like a regular user.",
	memory: memory(3),
	observation: { feed: [{ author: "bob", text: "hi" }] },
	actions: [
		{ name: "post", description: "Publish", schema: { type: "object", properties: {} } },
		{ name: "silent", description: "Nothing", schema: { type: "object", properties: {} } },
	],
	...overrides,
});

const options = (overrides: Partial<PromptOptions> = {}): PromptOptions => ({
	...PromptOptionsSchema.parse({}),
	...overrides,
});

const text = (p: ReturnType<typeof renderPrompt>) => p.messages.map((m) => m.content).join("\n");

describe("renderPrompt", () => {
	test("every option changes the hash and the rendered structure", () => {
		const base = renderPrompt(input(), options());
		const variants: readonly Partial<PromptOptions>[] = [
			{ personaFormat: "bullets" },
			{ personaFormat: "table" },
			{ instructionOrder: "last" },
			{ rolePlacement: "user" },
			{ naming: "name" },
			{ naming: "anonymous" },
			{ memoryRepresentation: "json" },
			{ memoryRepresentation: "bullets" },
			{ contextWindow: 300 },
		];
		const hashes = new Set<string>([base.hash]);
		for (const v of variants) {
			const p = renderPrompt(input(), options(v));
			expect(p.hash).not.toBe(base.hash);
			hashes.add(p.hash);
		}
		expect(hashes.size).toBe(variants.length + 1);

		expect(text(renderPrompt(input(), options({ personaFormat: "table" })))).toContain(
			"| age | 34 |",
		);
		expect(text(renderPrompt(input(), options({ personaFormat: "bullets" })))).toContain(
			"- stance: pro",
		);
		expect(text(base)).toContain("age is 34; stance is pro; tags is a, b");
		const json = renderPrompt(input(), options({ memoryRepresentation: "json" }));
		const user = json.messages[1]?.content ?? "";
		const start = user.indexOf("Memory (JSON):\n") + "Memory (JSON):\n".length;
		const end = user.indexOf("\n\nObservation:");
		const parsed = JSON.parse(user.slice(start, end)) as readonly { eventId: string }[];
		expect(parsed).toHaveLength(3);
		expect(parsed[0]?.eventId).toBe(String(memory(1)[0]?.eventId));
		expect(text(renderPrompt(input(), options({ memoryRepresentation: "bullets" })))).toContain(
			"- (tick 0, decision) did thing 0",
		);
		expect(text(base)).toContain("[tick 0] decision: did thing 0");
	});

	test("naming controls how the agent is addressed", () => {
		expect(text(renderPrompt(input(), options({ naming: "id" })))).toContain(
			`You are agent ${agentId}.`,
		);
		expect(text(renderPrompt(input(), options({ naming: "name" })))).toContain(
			"You are Alice.",
		);
		const anon = text(renderPrompt(input(), options({ naming: "anonymous" })));
		expect(anon).not.toContain(String(agentId));
		expect(anon).not.toContain("Alice");
		expect(anon).toContain("You are a participant.");
		const { name: _name, ...noName } = input();
		expect(text(renderPrompt(noName, options({ naming: "name" })))).toContain(
			`You are agent ${agentId}.`,
		);
	});

	test("rolePlacement and instructionOrder move the role block", () => {
		const sys = renderPrompt(input(), options({ rolePlacement: "system" }));
		expect(sys.system).toContain("Behave like a regular user.");
		expect(sys.messages[0]).toEqual({ role: "system", content: sys.system });
		expect(sys.messages[1]?.content).not.toContain("Behave like a regular user.");
		const usr = renderPrompt(input(), options({ rolePlacement: "user" }));
		expect(usr.system).not.toContain("Behave like a regular user.");
		expect(usr.messages[1]?.content).toContain("Behave like a regular user.");

		const first = renderPrompt(input(), options({ instructionOrder: "first" })).system;
		expect(first.indexOf("Behave like")).toBeLessThan(first.indexOf("You are agent"));
		const last = renderPrompt(input(), options({ instructionOrder: "last" })).system;
		expect(last.indexOf("Behave like")).toBeGreaterThan(last.indexOf("You are agent"));
	});

	test("contextWindow trims memory from the oldest entry and flags truncation", () => {
		const full = renderPrompt(
			input({ memory: memory(10) }),
			options({ contextWindow: 100000 }),
		);
		expect(full.meta.truncated).toBe(false);
		expect(full.meta.droppedMemories).toBe(0);
		const trimmed = renderPrompt(
			input({ memory: memory(10) }),
			options({ contextWindow: 700 }),
		);
		expect(trimmed.meta.truncated).toBe(true);
		expect(trimmed.meta.droppedMemories).toBeGreaterThan(0);
		expect(trimmed.meta.droppedMemories).toBeLessThan(10);
		const body = text(trimmed);
		expect(body).toContain("did thing 9");
		expect(body).not.toContain("did thing 0");
		const tiny = renderPrompt(input({ memory: memory(2) }), options({ contextWindow: 10 }));
		expect(tiny.meta.droppedMemories).toBe(2);
		expect(tiny.meta.truncated).toBe(true);
		expect(text(tiny)).toContain("Observation:");
	});

	test("schema is the action union and the hash covers the messages", () => {
		const p = renderPrompt(input(), options());
		expect(p.schema).toEqual({
			type: "object",
			properties: {
				action: { type: "string", enum: ["post", "silent"] },
				args: { type: "object" },
				rationale: { type: "string" },
			},
			required: ["action", "args", "rationale"],
			additionalProperties: false,
		});
		expect(renderPrompt(input(), options()).hash).toBe(p.hash);
		expect(renderPrompt(input({ observation: { feed: [] } }), options()).hash).not.toBe(p.hash);
		expect(text(p)).toContain("- post: Publish");
	});
});
