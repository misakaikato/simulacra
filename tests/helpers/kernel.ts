import { z } from "zod";
import { registerBuiltinExecutors } from "../../src/agents";
import { defineAction } from "../../src/core/actions";
import { FAILURE_TYPES } from "../../src/core/failures";
import { toEventId } from "../../src/core/ids";
import type { DecisionProvider, Metric, Module, Registry } from "../../src/core/protocols";
import { createRegistry } from "../../src/core/registry";
import { err, ok } from "../../src/core/result";
import { parseScenario } from "../../src/core/scenario";
import type { GatewayFactory } from "../../src/core/simulation";
import type { Decision, DecisionRequest, JsonObject, Scenario } from "../../src/core/types";
import { registerBuiltinInstruments } from "../../src/instruments";
import { createGateway } from "../../src/llm/gateway";
import { registerBuiltinPolicies } from "../../src/policies";
import { registerBuiltinProviders } from "../../src/providers";

export const gatewayFactory: GatewayFactory = (spec, opts) => createGateway(spec, opts);

export const ZERO_COST = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
} as const;

export const noop = defineAction({
	name: "noop",
	description: "Do nothing",
	params: z.object({}),
	requiresModules: [],
	fallback: true,
	resolve: async () => [],
});

export const bump = defineAction({
	name: "bump",
	description: "Increase the score",
	params: z.object({ amount: z.number().int() }),
	requiresModules: [],
	fallback: false,
	resolve: async (call) => [
		{
			op: "inc",
			entity: "agent",
			id: call.agentId,
			column: "score",
			value: call.args.amount,
			cause: call.cause,
		},
	],
});

export const bogus = defineAction({
	name: "bogus",
	description: "Write to a column that does not exist",
	params: z.object({}),
	requiresModules: [],
	fallback: false,
	resolve: async (call) => [
		{ op: "set", entity: "ghost", id: call.agentId, column: "x", value: 1, cause: call.cause },
	],
});

export const decisionFor = (
	req: DecisionRequest,
	action = "bump",
	args: JsonObject = { amount: 1 },
): Decision => ({
	agentId: req.agentId,
	action,
	args,
	provenance: "rule",
	cost: ZERO_COST,
	parseOk: true,
});

export interface TickerState {
	steps: number;
	failUntil: number;
	failAlways: boolean;
}

export const tickerModule = (
	state: TickerState = { steps: 0, failUntil: 0, failAlways: false },
): Module => ({
	name: "ticker",
	concurrencySafe: true,
	declare: (world) =>
		world.declare({
			entity: "agent",
			name: "score",
			dtype: "i32",
			default: 0,
			owner: "kernel",
			merge: "sum",
		}),
	actions: () => [],
	observe: (_view, ids) => {
		const out: Record<string, JsonObject> = {};
		for (const id of ids) out[id] = { feed: [{ id: "post-1", text: "hello" }] };
		return out;
	},
	step: async (_view, t) => {
		state.steps += 1;
		if (state.failAlways || t.tick < state.failUntil)
			throw new Error(`ticker refuses tick ${t.tick}`);
		return [
			{
				op: "envSet",
				key: "ticker.tick",
				value: t.tick,
				cause: toEventId("00000000000000000000000000"),
			},
		];
	},
	getState: () => ({ steps: state.steps }),
	setState: () => {},
});

const scoreSum: Metric = {
	name: "scoreSum",
	compute: (view) =>
		view
			.column<number>("agent", "score")
			.toArray()
			.reduce((a, b) => a + b, 0),
};

const scores: Metric = {
	name: "scores",
	compute: (view) => view.column<number>("agent", "score").toArray(),
};

export type ProviderBehaviour =
	| { readonly kind: "ok" }
	| { readonly kind: "failIndex"; readonly index: number; readonly excType?: string }
	| { readonly kind: "throw" }
	| { readonly kind: "short" }
	| { readonly kind: "allErr" }
	| { readonly kind: "wrongAgent" };

export const scriptedProvider = (
	name: string,
	behaviour: () => ProviderBehaviour,
): DecisionProvider => ({
	name,
	decide: async (requests) => {
		const b = behaviour();
		switch (b.kind) {
			case "ok":
				return requests.map((r) => ok(decisionFor(r)));
			case "failIndex":
				return requests.map((r, i) =>
					i === b.index
						? err({
								agentId: r.agentId,
								reason: "scripted failure",
								retryable: false,
								excType: b.excType ?? FAILURE_TYPES.parseFailure,
							})
						: ok(decisionFor(r)),
				);
			case "throw":
				throw new Error("scripted provider crash");
			case "short":
				return requests.slice(1).map((r) => ok(decisionFor(r)));
			case "allErr":
				return requests.map((r) =>
					err({
						agentId: r.agentId,
						reason: "endpoint unreachable",
						retryable: true,
						excType: FAILURE_TYPES.network,
					}),
				);
			case "wrongAgent":
				return requests.map((r, i) =>
					ok(decisionFor(requests[(i + 1) % requests.length] ?? r)),
				);
		}
	},
	reset: () => {},
	getState: () => null,
	setState: () => {},
});

export interface KernelFixture {
	readonly registry: Registry;
	readonly ticker: TickerState;
	behaviour: ProviderBehaviour;
}

export const kernelRegistry = (): KernelFixture => {
	const registry = createRegistry();
	const ticker: TickerState = { steps: 0, failUntil: 0, failAlways: false };
	const fixture: KernelFixture = { registry, ticker, behaviour: { kind: "ok" } };
	for (const action of [noop, bump, bogus]) {
		const r = registry.actions.register(action);
		if (!r.ok) throw new Error(JSON.stringify(r.error));
	}
	registerBuiltinPolicies(registry);
	registerBuiltinProviders(registry);
	registerBuiltinExecutors(registry);
	registerBuiltinInstruments(registry);
	registry.providers.register("scripted", (spec) =>
		ok(scriptedProvider(spec.name ?? "scripted", () => fixture.behaviour)),
	);
	registry.modules.register("ticker", () => ok(tickerModule(ticker)));
	registry.metrics.register("scoreSum", () => ok(scoreSum));
	registry.metrics.register("scores", () => ok(scores));
	return fixture;
};

export const kernelScenario = (overrides: JsonObject = {}): Scenario => {
	const parsed = parseScenario({
		scenarioId: "kernel",
		seed: 21,
		population: {
			n: 3,
			fields: [
				{
					name: "name",
					dtype: "str",
					sampling: { kind: "choice", choices: ["Ann", "Bob", "Cy"] },
				},
				{ name: "mood", dtype: "f64", sampling: { kind: "range", min: 0, max: 1 } },
			],
		},
		modules: [{ kind: "ticker" }],
		executors: [
			{
				kind: "focal",
				name: "people",
				options: {
					provider: "main",
					components: [
						{ kind: "instructions", options: { text: "Play along." } },
						{ kind: "persona" },
						{ kind: "recentMemory", options: { k: 3 } },
						{ kind: "feedObservation", options: { size: 2 } },
					],
				},
			},
		],
		providers: { main: { kind: "scripted" } },
		policy: { kind: "allAgents" },
		instruments: [{ kind: "scoreSum" }, { kind: "scores", every: 2 }],
		steps: [{ kind: "run", ticks: 3 }],
		...overrides,
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};
