import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	createActionRegistry,
	defineAction,
	toolSchema,
	zodToJsonSchema,
} from "../../src/core/actions";
import { toEntityId, toEventId } from "../../src/core/ids";
import type { ActionCall } from "../../src/core/types";

const post = defineAction({
	name: "post",
	description: "Publish a post",
	params: z.object({
		text: z.string().describe("Body"),
		visibility: z.enum(["public", "followers"]).default("public"),
		tags: z.array(z.string()).optional(),
		score: z.number(),
		count: z.number().int(),
		pinned: z.boolean().optional(),
		kind: z.literal("note"),
	}),
	requiresModules: ["feed"],
	fallback: false,
	resolve: async () => [],
});

const silent = defineAction({
	name: "silent",
	description: "Do nothing",
	params: z.object({}),
	requiresModules: [],
	fallback: true,
	resolve: async () => [],
});

const call = (name: string, args: ActionCall["args"]): ActionCall => ({
	agentId: toEntityId("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
	name,
	args,
	cause: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
});

describe("zodToJsonSchema", () => {
	test("covers object, string, number, integer, boolean, enum, literal, array, optional and default", () => {
		expect(zodToJsonSchema(post.params)).toEqual({
			type: "object",
			properties: {
				text: { type: "string", description: "Body" },
				visibility: { type: "string", enum: ["public", "followers"], default: "public" },
				tags: { type: "array", items: { type: "string" } },
				score: { type: "number" },
				count: { type: "integer" },
				pinned: { type: "boolean" },
				kind: { const: "note" },
			},
			required: ["text", "score", "count", "kind"],
			additionalProperties: false,
		});
	});

	test("required keys agree with zod acceptance", () => {
		const schema = zodToJsonSchema(post.params);
		const required = (schema.required ?? []) as readonly string[];
		const valid = { text: "t", score: 1, count: 2, kind: "note" };
		expect(post.params.safeParse(valid).success).toBe(true);
		for (const key of required) {
			const missing: Record<string, unknown> = { ...valid };
			delete missing[key];
			expect(post.params.safeParse(missing).success).toBe(false);
		}
		expect(post.params.safeParse({ ...valid, tags: ["a"], pinned: true }).success).toBe(true);
	});

	test("rejects unsupported schema types", () => {
		expect(() => zodToJsonSchema(z.object({ when: z.date() }))).toThrow(TypeError);
		expect(() => zodToJsonSchema(z.object({ u: z.union([z.string(), z.number()]) }))).toThrow(
			TypeError,
		);
	});

	test("toolSchema wraps parameters in an OpenAI function tool", () => {
		expect(toolSchema(silent)).toEqual({
			type: "function",
			function: {
				name: "silent",
				description: "Do nothing",
				parameters: {
					type: "object",
					properties: {},
					required: [],
					additionalProperties: false,
				},
			},
		});
	});
});

describe("ActionRegistry", () => {
	test("registers, lists and returns tool schemas in the requested order", () => {
		const registry = createActionRegistry();
		expect(registry.register(post).ok).toBe(true);
		expect(registry.register(silent).ok).toBe(true);
		expect(registry.names()).toEqual(["post", "silent"]);
		expect(registry.get("post")).toBe(post);
		expect(registry.fallback()).toBe(silent);
		expect(registry.toolSchemas(["silent", "post"])).toEqual([
			toolSchema(silent),
			toolSchema(post),
		]);
		expect(() => registry.toolSchemas(["nope"])).toThrow(RangeError);
	});

	test("rejects duplicate names and a second fallback", () => {
		const registry = createActionRegistry();
		registry.register(post);
		expect(registry.register({ ...post })).toEqual({
			ok: false,
			error: { kind: "DuplicateAction", name: "post" },
		});
		registry.register(silent);
		const second = registry.register({ ...silent, name: "idle" });
		expect(second).toEqual({
			ok: false,
			error: { kind: "DuplicateFallback", name: "idle", existing: "silent" },
		});
		expect(registry.names()).toEqual(["post", "silent"]);
	});

	test("params must be an object schema", () => {
		const registry = createActionRegistry();
		expect(() =>
			registry.register({ ...silent, name: "bad", fallback: false, params: z.string() }),
		).toThrow(TypeError);
	});

	test("validate parses args, applies defaults and reports failures", () => {
		const registry = createActionRegistry();
		registry.register(post);
		const ok = registry.validate(
			call("post", { text: "hi", score: 0.5, count: 3, kind: "note" }),
		);
		expect(ok.ok).toBe(true);
		if (ok.ok)
			expect(ok.value.args).toEqual({
				text: "hi",
				score: 0.5,
				count: 3,
				kind: "note",
				visibility: "public",
			});
		const bad = registry.validate(
			call("post", { text: 1, score: "x", count: 1.5, kind: "note" }),
		);
		expect(bad.ok).toBe(false);
		if (!bad.ok && bad.error.kind === "InvalidArgs")
			expect(bad.error.issues.map((i) => i.path)).toEqual(["text", "score", "count"]);
		expect(registry.validate(call("nope", {}))).toEqual({
			ok: false,
			error: { kind: "UnknownAction", name: "nope" },
		});
	});
});
