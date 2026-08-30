import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineAction } from "../../src/core/actions";
import { makeEvent } from "../../src/core/events";
import { FAILURE_TYPES } from "../../src/core/failures";
import { makeRunId, newEventId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import { PERSONA_OWNER } from "../../src/core/population";
import type { Component, Executor, PluginContext, World } from "../../src/core/protocols";
import { createRegistry } from "../../src/core/registry";
import { rngFromSeed } from "../../src/core/rng";
import { parseScenario } from "../../src/core/scenario";
import { LLMSpecSchema } from "../../src/core/schema";
import { timeAt } from "../../src/core/time";
import type { Decision, EntityId, JsonObject, Scenario } from "../../src/core/types";
import { createWorld } from "../../src/core/world";
import { registerBuiltinExecutors } from "../../src/agents";
import {
	CONTEXT_KEYS,
	feedObservation,
	instructions,
	neighborhoodObservation,
	persona,
	recentMemory,
	summaryMemory,
} from "../../src/agents/components";
import { createFocalExecutor } from "../../src/agents/focal";
import { createGateway } from "../../src/llm/gateway";
import { silentLogger } from "../../src/logging/logger";

process.env.NO_PROXY ??= "127.0.0.1,localhost";

const scenarioOf = (extra: JsonObject = {}): Scenario => {
	const r = parseScenario({
		scenarioId: "focal",
		seed: 5,
		population: {
			n: 2,
			fields: [
				{ name: "name", dtype: "str", sampling: { kind: "value", value: "Ann" } },
				{ name: "age", dtype: "i32", sampling: { kind: "value", value: 30 } },
				{
					name: "secret",
					dtype: "str",
					private: true,
					sampling: { kind: "value", value: "hidden" },
				},
			],
		},
		...extra,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return r.value;
};

const buildWorld = (scenario: Scenario): { world: World; ids: readonly EntityId[] } => {
	const world = createWorld();
	for (const f of scenario.population.fields) {
		const r = world.declare({
			entity: "agent",
			name: f.name,
			dtype: f.dtype,
			default: f.sampling.kind === "value" ? f.sampling.value : "",
			owner: PERSONA_OWNER,
			merge: "last",
		});
		if (!r.ok) throw new Error(r.error.message);
	}
	const ids = world.create(
		"agent",
		[
			{ "persona.name": "Ann", "persona.age": 30, "persona.secret": "hidden" },
			{ "persona.name": "Bob", "persona.age": 41, "persona.secret": "hidden2" },
		],
		rngFromSeed(5, [0]),
	);
	return { world, ids };
};

const registryWithActions = () => {
	const registry = createRegistry();
	registry.actions.register(
		defineAction({
			name: "post",
			description: "Publish a post",
			params: z.object({ text: z.string() }),
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

const contextOf = (scenario: Scenario, extra: Partial<PluginContext> = {}): PluginContext => ({
	scenario,
	registry: registryWithActions(),
	logger: silentLogger,
	...extra,
});

const executorOf = (
	ctx: PluginContext,
	components: readonly Component[],
	options: JsonObject = {},
): Executor => {
	const r = createFocalExecutor(
		{ kind: "focal", name: "focal", options: { provider: "mock", ...options } },
		ctx,
		components,
	);
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return r.value;
};

const personaComponent = (scenario: Scenario) =>
	persona({
		entity: "agent",
		prefix: "persona.",
		nameField: "name",
		privateFields: scenario.population.fields.filter((f) => f.private).map((f) => f.name),
	});

const decisionOf = (agentId: EntityId, action = "post"): Decision => ({
	agentId,
	action,
	args: { text: "hi" },
	provenance: "rule",
	cost: { llmCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, wallMs: 0 },
	parseOk: true,
});

const runId = makeRunId("focal", 0);

const seedDecisions = (
	log: ReturnType<typeof createMemoryEventLog>,
	agentId: EntityId,
	n: number,
) => {
	const rng = rngFromSeed(99, [1]);
	for (let i = 0; i < n; i += 1) {
		const observation = newEventId(rng);
		log.append(
			makeEvent(
				{ eventId: observation, runId, t: timeAt(i, 1, 0), seedPath: [i], agentId },
				{
					kind: "observation",
					payload: { contentSha: "x", refs: [], truncated: false },
				},
			),
		);
		const rationaleSha = log.putContent(`reason ${i}`);
		log.append(
			makeEvent(
				{
					eventId: newEventId(rng),
					runId,
					t: timeAt(i, 2, 1),
					seedPath: [i],
					agentId,
					parent: observation,
				},
				{
					kind: "decision",
					payload: {
						action: "post",
						args: { text: `t${i}` },
						rationaleSha,
						provider: "mock",
						parseOk: true,
					},
				},
			),
		);
	}
};

const servers: { stop: () => void }[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
});

describe("FocalExecutor.declare", () => {
	test("rejects reads that are neither columns nor earlier writes, accepts wildcards", () => {
		const scenario = scenarioOf();
		const { world } = buildWorld(scenario);
		const ctx = contextOf(scenario);
		const needsMemory: Component = {
			name: "needsMemory",
			reads: ["memory", "feed"],
			writes: [],
			preAct: () => ({}),
			postAct: () => {},
			getState: () => null,
			setState: () => {},
		};
		const bad = executorOf(ctx, [needsMemory]).declare(world);
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.error.kind).toBe("ComponentDependencyError");
			if (bad.error.kind === "ComponentDependencyError") {
				expect(bad.error.component).toBe("needsMemory");
				expect(bad.error.missing).toEqual(["memory", "feed"]);
			}
		}
		const good = executorOf(ctx, [
			personaComponent(scenario),
			recentMemory({ k: 3 }),
			feedObservation(5),
			needsMemory,
		]).declare(world);
		expect(good.ok).toBe(true);
		const wrongOrder = executorOf(ctx, [
			needsMemory,
			recentMemory({ k: 3 }),
			feedObservation(5),
		]);
		expect(wrongOrder.declare(world).ok).toBe(false);
		const noPersonaColumns = executorOf(contextOf(scenario), [personaComponent(scenario)]);
		expect(noPersonaColumns.declare(createWorld()).ok).toBe(false);
	});
});

describe("FocalExecutor.observe", () => {
	test("renders persona without private fields, memory with event ids, and stores the prompt", async () => {
		const scenario = scenarioOf();
		const { world, ids } = buildWorld(scenario);
		const ctx = contextOf(scenario);
		const log = createMemoryEventLog();
		const ann = ids[0]!;
		seedDecisions(log, ann, 6);
		const executor = executorOf(ctx, [
			instructions("Stay polite."),
			personaComponent(scenario),
			recentMemory({ k: 4 }),
			feedObservation(2),
			neighborhoodObservation(1),
		]);
		expect(executor.declare(world).ok).toBe(true);
		const rng = rngFromSeed(5, [0, 7]);
		const observations = new Map<EntityId, JsonObject>([
			[
				ann,
				{ feed: [{ id: "p1" }, { id: "p2" }, { id: "p3" }], neighbors: [String(ids[1])] },
			],
		]);
		const requests = await executor.observe(world, ids, timeAt(7), log, rng, observations);
		expect(requests).toHaveLength(2);
		const [first, second] = requests;
		expect(first?.agentId).toBe(ann);
		expect(first?.actionSpace).toEqual(["post", "silent"]);
		expect(first?.observation).toEqual({
			feed: [{ id: "p1" }, { id: "p2" }],
			neighbors: [String(ids[1])],
			neighborhoodRadius: 1,
		});
		expect(second?.observation).toEqual({ feed: [], neighbors: [], neighborhoodRadius: 1 });
		expect(first?.state).toMatchObject({ "persona.name": "Ann", "persona.age": 30 });

		const prompt = first?.prompt;
		expect(prompt).toBeDefined();
		const text = prompt?.messages.map((m) => m.content).join("\n") ?? "";
		expect(text).toContain("Stay polite.");
		expect(text).toContain("name is Ann");
		expect(text).toContain("age is 30");
		expect(text).not.toContain("hidden");
		expect(text).not.toContain("secret");
		expect(text).toContain("because reason 5");
		expect(text).not.toContain("t1");

		const events = log.query({ kind: ["observation"], tick: 7 });
		expect(events).toHaveLength(2);
		const event = events[0];
		expect(event?.agentId).toBe(ann);
		expect(event?.eventId).toBe(first?.observationEvent ?? toEventId(""));
		expect(event?.seedPath).toEqual([0, 7]);
		if (event?.kind === "observation") {
			expect(event.payload.promptHash).toBe(prompt?.hash ?? "");
			expect(event.payload.truncated).toBe(false);
			const stored = log.getContent(event.payload.contentSha) ?? "";
			expect(stored).toContain("Stay polite.");
			expect(JSON.parse(stored)).toMatchObject({ agentId: ann });
		}
	});

	test("recentMemory keeps at most k entries, newest last, each with an event id", () => {
		const log = createMemoryEventLog();
		const agentId = buildWorld(scenarioOf()).ids[0]!;
		seedDecisions(log, agentId, 5);
		const component = recentMemory({ k: 3 });
		const out = component.preAct(agentId, createWorld(), timeAt(9), new Map(), log);
		const memory = out[CONTEXT_KEYS.memory];
		expect(Array.isArray(memory)).toBe(true);
		if (!Array.isArray(memory)) return;
		expect(memory).toHaveLength(3);
		const all = log.query({ agentId });
		for (const entry of memory) {
			expect(typeof entry === "object" && entry !== null && "eventId" in entry).toBe(true);
			if (typeof entry === "object" && entry !== null && !Array.isArray(entry))
				expect(all.some((e) => e.eventId === entry.eventId)).toBe(true);
		}
		expect(JSON.stringify(memory)).toContain("t4");
		expect(JSON.stringify(memory)).not.toContain('"t1"');
	});

	test("an empty action space writes a failure per agent and no requests", async () => {
		const scenario = scenarioOf();
		const { world, ids } = buildWorld(scenario);
		const ctx = contextOf(scenario);
		const log = createMemoryEventLog();
		const executor = executorOf(ctx, [], { actions: ["fly"] });
		const requests = await executor.observe(world, ids, timeAt(0), log, rngFromSeed(5, [0, 0]));
		expect(requests).toHaveLength(0);
		const failures = log.query({ kind: ["failure"] });
		expect(failures).toHaveLength(2);
		if (failures[0]?.kind === "failure")
			expect(failures[0].payload.excType).toBe(FAILURE_TYPES.noAvailableActions);
		const filtered = executorOf(ctx, [], { actions: ["silent", "fly"] });
		const some = await filtered.observe(world, ids, timeAt(0), log, rngFromSeed(5, [0, 1]));
		expect(some[0]?.actionSpace).toEqual(["silent"]);
	});
});

describe("FocalExecutor.after and state", () => {
	test("after runs postAct and consolidation without touching the world", async () => {
		const scenario = scenarioOf();
		const { world, ids } = buildWorld(scenario);
		const ctx = contextOf(scenario);
		const log = createMemoryEventLog();
		const seen: string[] = [];
		const spy: Component = {
			name: "spy",
			reads: [],
			writes: [],
			preAct: () => ({}),
			postAct: (agentId, decision) => {
				seen.push(`${agentId}:${decision.action}`);
			},
			getState: () => ({ seen: seen.length }),
			setState: () => {},
		};
		const executor = executorOf(ctx, [spy]);
		const before = world.hash();
		await executor.observe(world, ids, timeAt(1), log, rngFromSeed(5, [0, 1]));
		await executor.after(
			[decisionOf(ids[0]!), decisionOf(ids[1]!, "silent")],
			{ applied: 0, rejected: [] },
			log,
		);
		expect(seen).toEqual([`${ids[0]}:post`, `${ids[1]}:silent`]);
		expect(world.hash()).toBe(before);
	});

	test("summaryMemory compresses through the gateway and records an llm_call", async () => {
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async () => {
				calls += 1;
				return Response.json({
					model: "fake",
					choices: [{ message: { content: "I mostly posted greetings." } }],
					usage: { prompt_tokens: 20, completion_tokens: 6 },
				});
			},
		});
		servers.push({ stop: () => server.stop(true) });
		const scenario = scenarioOf();
		const { world, ids } = buildWorld(scenario);
		const gateway = createGateway(
			LLMSpecSchema.parse({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "m" }),
			{ logger: silentLogger },
		);
		const ctx = contextOf(scenario, { gateway });
		const log = createMemoryEventLog();
		const ann = ids[0]!;
		seedDecisions(log, ann, 6);
		const summary = summaryMemory({ threshold: 4 }, { gateway, logger: silentLogger });
		const executor = executorOf(ctx, [recentMemory({ k: 10 }), summary]);
		expect(executor.declare(world).ok).toBe(true);

		await executor.observe(world, [ann], timeAt(6), log, rngFromSeed(5, [0, 6]));
		await executor.after([decisionOf(ann)], { applied: 0, rejected: [] }, log);
		expect(calls).toBe(1);
		const llmCalls = log.query({ kind: ["llm_call"] });
		expect(llmCalls).toHaveLength(1);
		expect(llmCalls[0]?.agentId).toBe(ann);
		expect(gateway.ledgerByPurpose().memory_summary?.llmCalls).toBe(1);
		const state = executor.getState() as { components: readonly unknown[] };
		const summaryState = state.components[1] as {
			summaries: Record<string, { text: string; eventId: string }>;
		};
		expect(summaryState.summaries[ann]?.text).toBe("I mostly posted greetings.");
		expect(summaryState.summaries[ann]?.eventId).toBe(String(llmCalls[0]?.eventId));

		const requests = await executor.observe(
			world,
			[ann],
			timeAt(7),
			log,
			rngFromSeed(5, [0, 7]),
		);
		const text = requests[0]?.prompt?.messages.map((m) => m.content).join("\n") ?? "";
		expect(text).toContain("summary: I mostly posted greetings.");
		expect(text).not.toContain("reason 1");
		await executor.after([decisionOf(ann)], { applied: 0, rejected: [] }, log);
		expect(calls).toBe(1);

		const clone = executorOf(ctx, [
			recentMemory({ k: 10 }),
			summaryMemory({ threshold: 4 }, { gateway, logger: silentLogger }),
		]);
		clone.setState(executor.getState());
		expect(clone.getState()).toEqual(executor.getState());
	});

	test("summaryMemory keeps the raw memory and records a failure when the gateway fails", async () => {
		const scenario = scenarioOf();
		const { world, ids } = buildWorld(scenario);
		const gateway = createGateway(
			LLMSpecSchema.parse({ baseUrl: "http://127.0.0.1:1/v1", model: "m", timeoutMs: 200 }),
			{ logger: silentLogger, backoffBaseMs: 1 },
		);
		const ctx = contextOf(scenario, { gateway });
		const log = createMemoryEventLog();
		const ann = ids[0]!;
		seedDecisions(log, ann, 3);
		const executor = executorOf(ctx, [
			recentMemory({ k: 10 }),
			summaryMemory({ threshold: 1 }, { gateway, logger: silentLogger }),
		]);
		await executor.observe(world, [ann], timeAt(3), log, rngFromSeed(5, [0, 3]));
		await executor.after([decisionOf(ann)], { applied: 0, rejected: [] }, log);
		const failures = log.query({ kind: ["failure"] });
		expect(failures).toHaveLength(1);
		if (failures[0]?.kind === "failure")
			expect(failures[0].payload.excType).toBe(FAILURE_TYPES.memorySummaryFailed);
		const requests = await executor.observe(
			world,
			[ann],
			timeAt(4),
			log,
			rngFromSeed(5, [0, 4]),
		);
		const text = requests[0]?.prompt?.messages.map((m) => m.content).join("\n") ?? "";
		expect(text).toContain("reason 0");
	});
});

describe("registerBuiltinExecutors", () => {
	test("builds a focal executor with components from a spec", () => {
		const scenario = scenarioOf();
		const registry = registryWithActions();
		expect(registerBuiltinExecutors(registry).ok).toBe(true);
		expect(registerBuiltinExecutors(registry).ok).toBe(false);
		const ctx: PluginContext = { scenario, registry, logger: silentLogger };
		const created = registry.executors.create(
			{
				kind: "focal",
				name: "people",
				options: {
					provider: "mock",
					components: [
						{ kind: "instructions", options: { text: "hi" } },
						{ kind: "persona" },
						{ kind: "recentMemory", options: { k: 2 } },
						{ kind: "feedObservation", options: { size: 3 } },
						{ kind: "neighborhoodObservation" },
					],
				},
			},
			ctx,
		);
		expect(created.ok).toBe(true);
		if (created.ok) {
			expect(created.value.name).toBe("people");
			expect(created.value.provider).toBe("mock");
			expect(created.value.entity).toBe("agent");
			expect(created.value.declare(buildWorld(scenario).world).ok).toBe(true);
		}
		const unknown = registry.executors.create(
			{ kind: "focal", options: { provider: "mock", components: [{ kind: "telepathy" }] } },
			ctx,
		);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.reason).toBe("unknown_kind");
		const noProvider = registry.executors.create({ kind: "focal" }, ctx);
		expect(noProvider.ok).toBe(false);
	});
});
