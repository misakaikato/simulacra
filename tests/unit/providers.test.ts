import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineAction } from "../../src/core/actions";
import { FAILURE_TYPES } from "../../src/core/failures";
import { makeRunId, toEntityId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import { renderPrompt } from "../../src/core/prompt";
import type { PluginContext } from "../../src/core/protocols";
import { createRegistry } from "../../src/core/registry";
import { parseScenario } from "../../src/core/scenario";
import { LLMSpecSchema, PromptOptionsSchema } from "../../src/core/schema";
import { timeAt } from "../../src/core/time";
import type { Decision, DecisionRequest, JsonObject, RoundContext } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { createGateway } from "../../src/llm/gateway";
import { silentLogger } from "../../src/logging/logger";
import { registerBuiltinProviders } from "../../src/providers";
import { createLlmProvider } from "../../src/providers/llm";
import { createMockProvider, exampleFromJsonSchema } from "../../src/providers/mock";
import { createRuleProvider } from "../../src/providers/rule";

process.env.NO_PROXY ??= "127.0.0.1,localhost";

const agentA = toEntityId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const agentB = toEntityId("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const obsEvent = toEventId("01ARZ3NDEKTSV4RRFFQ69G5FC0");

const registryWithActions = () => {
	const registry = createRegistry();
	registry.actions.register(
		defineAction({
			name: "post",
			description: "Publish a post",
			params: z.object({
				text: z.string(),
				visibility: z.enum(["public", "followers"]),
				count: z.number().int(),
				pinned: z.boolean().optional(),
				tags: z.array(z.string()).optional(),
			}),
			requiresModules: [],
			fallback: false,
			resolve: async () => [],
		}),
	);
	registry.actions.register(
		defineAction({
			name: "silent",
			description: "Do nothing",
			params: z.object({}),
			requiresModules: [],
			fallback: true,
			resolve: async () => [],
		}),
	);
	return registry;
};

const request = (agentId = agentA, overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
	agentId,
	t: timeAt(2),
	state: {},
	observation: { feed: [] },
	observationEvent: obsEvent,
	actionSpace: ["post", "silent"],
	...overrides,
});

const withPrompt = (req: DecisionRequest, instructions = "Be nice."): DecisionRequest => ({
	...req,
	prompt: renderPrompt(
		{
			agentId: req.agentId,
			persona: {},
			instructions,
			memory: [],
			observation: req.observation,
			actions: req.actionSpace.map((name) => ({ name, description: name, schema: {} })),
		},
		PromptOptionsSchema.parse({}),
	),
});

const roundContext = (seedPath: readonly number[] = [0, 2]): RoundContext => ({
	t: timeAt(2),
	runId: makeRunId("s", 0),
	seedPath,
	world: createWorld(),
	log: createMemoryEventLog(),
});

const servers: { stop: () => void }[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
});

const fakeLlm = (reply: (body: JsonObject, n: number) => string) => {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			calls += 1;
			const body = (await req.json()) as JsonObject;
			return Response.json({
				model: "fake",
				choices: [{ message: { content: reply(body, calls) } }],
				usage: { prompt_tokens: 7, completion_tokens: 3 },
			});
		},
	});
	const handle = {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		get calls() {
			return calls;
		},
		stop: () => server.stop(true),
	};
	servers.push(handle);
	return handle;
};

describe("mock provider", () => {
	test("is deterministic, produces schema-valid args and keeps the length contract", async () => {
		const registry = registryWithActions();
		const provider = createMockProvider(registry.actions);
		const reqs = [withPrompt(request(agentA)), withPrompt(request(agentB)), request(agentA)];
		const first = await provider.decide(reqs, roundContext());
		const second = await provider.decide(reqs, roundContext());
		expect(first).toHaveLength(3);
		expect(first).toEqual(second);
		for (const [i, r] of first.entries()) {
			expect(r.ok).toBe(true);
			if (!r.ok) continue;
			expect(r.value.agentId).toBe(reqs[i]!.agentId);
			expect(reqs[i]?.actionSpace).toContain(r.value.action);
			const validated = registry.actions.validate({
				agentId: r.value.agentId,
				name: r.value.action,
				args: r.value.args,
				cause: obsEvent,
			});
			expect(validated.ok).toBe(true);
			expect(r.value.parseOk).toBe(true);
			expect(r.value.cost.llmCalls).toBe(0);
		}
		const other = await provider.decide(reqs, roundContext([0, 3]));
		const actions = (rs: typeof first) => rs.map((r) => (r.ok ? r.value.action : "err"));
		expect(actions(first).some((a) => a === "post")).toBe(true);
		expect(actions(other)).toHaveLength(3);
	});

	test("fails typed on an empty action space and round-trips state", async () => {
		const provider = createMockProvider(registryWithActions().actions);
		const [r] = await provider.decide([request(agentA, { actionSpace: [] })], roundContext());
		expect(r?.ok).toBe(false);
		if (r !== undefined && !r.ok)
			expect(r.error.excType).toBe(FAILURE_TYPES.noAvailableActions);
		await provider.decide([request(agentA)], roundContext());
		expect(provider.getState()).toEqual({ decided: 1 });
		provider.setState({ decided: 5 });
		expect(provider.getState()).toEqual({ decided: 5 });
		provider.reset([1]);
		expect(provider.getState()).toEqual({ decided: 0 });
	});

	test("exampleFromJsonSchema fills required fields with fixed values", () => {
		expect(
			exampleFromJsonSchema({
				type: "object",
				properties: {
					s: { type: "string" },
					n: { type: "number" },
					i: { type: "integer" },
					b: { type: "boolean" },
					e: { type: "string", enum: ["x", "y"] },
					a: { type: "array", items: { type: "string" } },
					c: { const: "k" },
					o: { type: "boolean" },
				},
				required: ["s", "n", "i", "b", "e", "a", "c"],
			}),
		).toEqual({ s: "...", n: 0, i: 0, b: false, e: "x", a: [], c: "k" });
	});
});

describe("rule provider", () => {
	test("derives a per-agent rng from the seed path and reports thrown rules", async () => {
		const provider = createRuleProvider({
			name: "rule",
			seed: 11,
			rule: (req, rng) => ({
				agentId: req.agentId,
				action: rng.bernoulli(0.5) ? "post" : "silent",
				args: {},
				provenance: "rule",
				cost: {
					llmCalls: 0,
					promptTokens: 0,
					completionTokens: 0,
					cachedTokens: 0,
					wallMs: 0,
				},
				parseOk: true,
			}),
		});
		const reqs = [request(agentA), request(agentB)];
		const a = await provider.decide(reqs, roundContext());
		const b = await provider.decide(reqs, roundContext());
		expect(a).toHaveLength(2);
		expect(a).toEqual(b);
		const thrower = createRuleProvider({
			name: "boom",
			seed: 1,
			rule: () => {
				throw new Error("no idea");
			},
		});
		const [r] = await thrower.decide([request(agentA)], roundContext());
		expect(r?.ok).toBe(false);
		if (r !== undefined && !r.ok) {
			expect(r.error.excType).toBe(FAILURE_TYPES.ruleThrew);
			expect(r.error.reason).toContain("no idea");
		}
		provider.reset([4, 5]);
		expect(provider.getState()).toEqual({ seedPath: [4, 5] });
	});
});

describe("llm provider", () => {
	const options = {
		name: "llm",
		seed: 3,
		temperature: 0,
		maxTokens: 64,
		homogeneousGuard: true,
		purpose: "decision",
	};

	test("decides through the gateway, writes llm_call events and replays identically", async () => {
		const server = fakeLlm(
			() =>
				'Sure. {"action": "post", "args": {"text": "hello", "visibility": "public", "count": 1}, "rationale": "because"}',
		);
		const recordDir = mkdtempSync(join(tmpdir(), "simulacra-rec-"));
		const specOf = (mode: "record" | "replay") =>
			LLMSpecSchema.parse({ baseUrl: server.baseUrl, model: "m", mode, recordDir });
		const recorder = createLlmProvider(options, {
			gateway: createGateway(specOf("record"), { logger: silentLogger }),
			logger: silentLogger,
		});
		const reqs = [withPrompt(request(agentA)), withPrompt(request(agentB), "Be bold.")];
		const ctx = roundContext();
		const recorded = await recorder.decide(reqs, ctx);
		expect(recorded).toHaveLength(2);
		expect(server.calls).toBe(2);
		const llmEvents = ctx.log.query({ kind: ["llm_call"] });
		expect(llmEvents).toHaveLength(2);
		for (const [i, r] of recorded.entries()) {
			expect(r.ok).toBe(true);
			if (!r.ok) continue;
			expect(r.value.action).toBe("post");
			expect(r.value.args).toEqual({ text: "hello", visibility: "public", count: 1 });
			expect(r.value.rationale).toBe("because");
			expect(r.value.provenance).toBe("llm");
			expect(r.value.cost).toMatchObject({
				llmCalls: 1,
				promptTokens: 7,
				completionTokens: 3,
			});
			expect(llmEvents.some((e) => e.eventId === r.value.llmEvent)).toBe(true);
			const e = llmEvents.find((x) => x.eventId === r.value.llmEvent);
			expect(e?.agentId).toBe(reqs[i]?.agentId);
			expect(e?.parent).toBe(obsEvent);
			if (e?.kind === "llm_call") {
				expect(e.payload.promptHash).toBe(reqs[i]?.prompt?.hash ?? "");
				expect(ctx.log.getContent(e.payload.responseSha)).toContain('"action": "post"');
			}
		}

		const replayer = createLlmProvider(options, {
			gateway: createGateway(specOf("replay"), { logger: silentLogger }),
			logger: silentLogger,
		});
		const ctx2 = roundContext();
		const replayed = await replayer.decide(reqs, ctx2);
		expect(server.calls).toBe(2);
		const strip = (rs: readonly { ok: boolean; value?: Decision }[]) =>
			rs.map((r) => (r.ok && r.value !== undefined ? { ...r.value, cost: undefined } : r));
		expect(strip(replayed as never)).toEqual(strip(recorded as never));
		const ctx3 = roundContext();
		await replayer.decide(reqs, ctx3);
		expect(ctx3.log.digest()).toBe(ctx2.log.digest());
		const modRecorded = (log: typeof ctx.log) =>
			log
				.query({})
				.map((e) =>
					e.kind === "llm_call" ? { ...e, payload: { ...e.payload, recorded: null } } : e,
				);
		expect(modRecorded(ctx2.log)).toEqual(modRecorded(ctx.log));
		const replayEvents = ctx2.log.query({ kind: ["llm_call"] });
		expect(replayEvents.every((e) => e.kind === "llm_call" && e.payload.recorded)).toBe(true);
	});

	test("parse failures and unknown actions are typed errors that still record the call", async () => {
		const server = fakeLlm((_, n) =>
			n === 1 ? "I will not answer" : '{"action": "fly", "args": {}}',
		);
		const provider = createLlmProvider(options, {
			gateway: createGateway(LLMSpecSchema.parse({ baseUrl: server.baseUrl, model: "m" }), {
				logger: silentLogger,
			}),
			logger: silentLogger,
		});
		const ctx = roundContext();
		const results = await provider.decide(
			[withPrompt(request(agentA)), withPrompt(request(agentB)), request(agentA)],
			ctx,
		);
		expect(results).toHaveLength(3);
		const [garbage, unknown, noPrompt] = results;
		expect(garbage?.ok).toBe(false);
		if (garbage !== undefined && !garbage.ok)
			expect(garbage.error.excType).toBe(FAILURE_TYPES.parseFailure);
		expect(unknown?.ok).toBe(false);
		if (unknown !== undefined && !unknown.ok)
			expect(unknown.error.excType).toBe(FAILURE_TYPES.invalidAction);
		expect(noPrompt?.ok).toBe(false);
		if (noPrompt !== undefined && !noPrompt.ok)
			expect(noPrompt.error.excType).toBe(FAILURE_TYPES.noPrompt);
		expect(ctx.log.query({ kind: ["llm_call"] })).toHaveLength(2);
		expect(server.calls).toBe(2);
	});
});

describe("registerBuiltinProviders", () => {
	const scenario = (providers: Record<string, { kind: string; options?: JsonObject }>) => {
		const r = parseScenario({ scenarioId: "s", seed: 9, population: { n: 1 }, providers });
		if (!r.ok) throw new Error("scenario");
		return r.value;
	};

	test("creates mock, rule and llm providers from specs", () => {
		const registry = registryWithActions();
		const registered = registerBuiltinProviders(registry, {
			rules: {
				always: (req) => ({
					agentId: req.agentId,
					action: "silent",
					args: {},
					provenance: "rule",
					cost: {
						llmCalls: 0,
						promptTokens: 0,
						completionTokens: 0,
						cachedTokens: 0,
						wallMs: 0,
					},
					parseOk: true,
				}),
			},
		});
		expect(registered.ok).toBe(true);
		expect([...registry.providers.kinds()].sort()).toEqual(["llm", "mock", "rule"]);
		const ctx: PluginContext = {
			scenario: scenario({}),
			registry,
			logger: silentLogger,
			gateway: createGateway(LLMSpecSchema.parse({ baseUrl: "http://127.0.0.1:1/v1" }), {
				logger: silentLogger,
			}),
		};
		const mock = registry.providers.create({ kind: "mock", name: "m" }, ctx);
		expect(mock.ok && mock.value.name).toBe("m");
		const rule = registry.providers.create({ kind: "rule", options: { rule: "always" } }, ctx);
		expect(rule.ok && rule.value.name).toBe("rule");
		const missing = registry.providers.create({ kind: "rule", options: { rule: "nope" } }, ctx);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.reason).toBe("construct_failed");
		const llm = registry.providers.create({ kind: "llm", options: { temperature: 0.2 } }, ctx);
		expect(llm.ok && llm.value.name).toBe("llm");
		const badOptions = registry.providers.create(
			{ kind: "llm", options: { temperature: -1 } },
			ctx,
		);
		expect(badOptions.ok).toBe(false);
		expect(registerBuiltinProviders(registry).ok).toBe(false);
	});

	test("llm provider without a gateway in context fails every request with gateway_missing", async () => {
		const registry = registryWithActions();
		registerBuiltinProviders(registry);
		const ctx: PluginContext = { scenario: scenario({}), registry, logger: silentLogger };
		const created = registry.providers.create({ kind: "llm" }, ctx);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const round = roundContext();
		const results = await created.value.decide(
			[withPrompt(request(agentA)), withPrompt(request(agentB))],
			round,
		);
		expect(results).toHaveLength(2);
		for (const r of results) {
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.error.reason).toBe("gateway_missing");
				expect(r.error.retryable).toBe(false);
				expect(r.error.excType).toBe(FAILURE_TYPES.gatewayMissing);
			}
		}
		expect(round.log.count()).toBe(0);
	});
});
