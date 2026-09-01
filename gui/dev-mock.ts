import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	AuditPlan,
	AuditReport,
	Condition,
	EntityId,
	Event as SimEvent,
	EventId,
	EventOf,
	FailureInfo,
	LogicalTime,
	PairwiseTest,
	RunId,
	RunResult,
	Scenario,
} from "../src/core/types";
import type {
	AgentRow,
	AuditSummary,
	Example,
	GraphEdge,
	MetricPoint,
	RunStatus,
	RunSummary,
} from "./src/api";

const PORT = 8787;
const EXAMPLES_DIR = resolve(import.meta.dir, "../examples");
const PAGE_SIZE = 200;
const TICK_MS = 1000;
const NAMES = [
	"Ada",
	"Ben",
	"Cleo",
	"Dev",
	"Esme",
	"Finn",
	"Gia",
	"Hugo",
	"Ines",
	"Jun",
	"Kai",
	"Lina",
	"Milo",
	"Nia",
	"Otto",
	"Pia",
	"Quinn",
	"Rae",
	"Sol",
	"Tess",
	"Uma",
	"Vik",
	"Wren",
	"Xan",
	"Yara",
	"Zed",
];

const seeded = (seed: number): (() => number) => {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const hash32 = (text: string): number => {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
};

const fakeSha = (text: string): string => {
	const a = hash32(text).toString(16).padStart(8, "0");
	const b = hash32(`${text}#2`).toString(16).padStart(8, "0");
	return `${a}${b}`.repeat(4);
};

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let counter = 0;
const nextId = (): string => {
	counter += 1;
	let n = counter;
	let text = "";
	while (text.length < 23) {
		text = ALPHABET.charAt(n % 32) + text;
		n = Math.floor(n / 32);
	}
	return `01J${text}`;
};
const entityId = (): EntityId => nextId() as EntityId;
const eventId = (): EventId => nextId() as EventId;
const runIdOf = (scenarioId: string, replication: number): RunId =>
	`${scenarioId}:${replication}` as RunId;

interface Profile {
	readonly actions: readonly string[];
	readonly metrics: readonly string[];
	readonly activation: number;
}

const ECHO: Profile = {
	actions: ["post", "reply", "like", "repost", "follow", "silent"],
	metrics: ["stanceAssortativity", "sameGroupRatio", "postShare"],
	activation: 0.3,
};

const PD: Profile = {
	actions: ["cooperate", "defect"],
	metrics: ["cooperationRate", "averagePayoff"],
	activation: 1,
};

interface MockAgent {
	readonly id: EntityId;
	readonly name: string;
	readonly stance: number;
	readonly ordinal: number;
	decisions: number;
	failures: number;
	degree: number;
}

interface Subscriber {
	readonly send: (chunk: string) => void;
	readonly close: () => void;
}

interface MockRun {
	readonly runId: RunId;
	readonly scenarioId: string;
	readonly seed: number;
	readonly ticks: number;
	readonly profile: Profile;
	readonly failAt: number | undefined;
	readonly agents: readonly MockAgent[];
	readonly edges: readonly GraphEdge[];
	readonly events: SimEvent[];
	readonly byId: Map<EventId, SimEvent>;
	readonly children: Map<EventId, EventId[]>;
	readonly content: Map<string, string>;
	readonly metrics: Record<string, MetricPoint[]>;
	readonly subscribers: Set<Subscriber>;
	readonly random: () => number;
	readonly startedAt: number;
	tick: number;
	status: RunStatus;
	result: RunResult | undefined;
	activated: number;
	parseFailures: number;
	llmCalls: number;
	promptTokens: number;
	completionTokens: number;
}

const createRun = (
	scenarioId: string,
	replication: number,
	seed: number,
	n: number,
	ticks: number,
	profile: Profile,
	failAt?: number,
): MockRun => {
	const random = seeded(seed * 7919 + replication);
	const agents: MockAgent[] = Array.from({ length: n }, (_, i) => ({
		id: entityId(),
		name: NAMES[i % NAMES.length] ?? "Agent",
		stance: Math.round((random() * 4 - 2) * 1000) / 1000,
		ordinal: i,
		decisions: 0,
		failures: 0,
		degree: 0,
	}));
	const edges: GraphEdge[] = [];
	const endpoints: number[] = [];
	for (let i = 1; i < n; i++) {
		const source = agents[i];
		if (source === undefined) continue;
		const targets = new Set<number>();
		while (targets.size < Math.min(i, 3)) {
			const preferential = endpoints[Math.floor(random() * endpoints.length)];
			targets.add(
				preferential !== undefined && random() < 0.6
					? preferential
					: Math.floor(random() * i),
			);
		}
		for (const t of targets) {
			const target = agents[t];
			if (target === undefined) continue;
			edges.push({ src: source.id, dst: target.id, kind: "follow" });
			endpoints.push(i, t);
			source.degree += 1;
			target.degree += 1;
		}
	}
	return {
		runId: runIdOf(scenarioId, replication),
		scenarioId,
		seed,
		ticks,
		profile,
		failAt,
		agents,
		edges,
		events: [],
		byId: new Map(),
		children: new Map(),
		content: new Map(),
		metrics: {},
		subscribers: new Set(),
		random,
		startedAt: Date.now(),
		tick: 0,
		status: "running",
		result: undefined,
		activated: 0,
		parseFailures: 0,
		llmCalls: 0,
		promptTokens: 0,
		completionTokens: 0,
	};
};

const frame = (event: string, data: unknown): string =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const broadcast = (run: MockRun, chunk: string): void => {
	for (const s of run.subscribers) s.send(chunk);
};

const nextMetric = (name: string, previous: number | undefined, random: () => number): number => {
	const payoff = name === "averagePayoff";
	const start = payoff ? 2.5 : 0.5;
	const span = payoff ? 0.3 : 0.05;
	const max = payoff ? 5 : 1;
	const value = (previous ?? start) + (random() - 0.5) * 2 * span;
	return Math.min(max, Math.max(0, value));
};

const finish = (run: MockRun, status: "succeeded" | "failed"): void => {
	run.status = status;
	const metrics = Object.fromEntries(
		Object.entries(run.metrics).map(([name, points]) => [name, points.at(-1)?.value ?? 0]),
	);
	const failure: FailureInfo = {
		stage: "run",
		excType: "ProviderBatchFailure",
		message: "3 consecutive ticks with whole-batch provider failure",
		stack: "ProviderBatchFailure: 3 consecutive ticks with whole-batch provider failure\n    at Simulation.step",
		at: { tick: run.tick, substep: 0, seq: 0 },
	};
	run.result = {
		runId: run.runId,
		scenarioHash: fakeSha(run.scenarioId),
		seed: run.seed,
		status,
		...(status === "failed" ? { failure } : {}),
		metrics,
		distributions: { stance: run.agents.map((a) => a.stance) },
		integrity: {
			activated: run.activated,
			ok: run.activated - run.parseFailures,
			failed: 0,
			parseFailures: run.parseFailures,
			llmCalls: run.llmCalls,
			llmFailures: 0,
			droppedEffects: 0,
			rejectedActions: 0,
			complete: true,
		},
		cost: {
			llmCalls: run.llmCalls,
			promptTokens: run.promptTokens,
			completionTokens: run.completionTokens,
			cachedTokens: 0,
			wallMs: Date.now() - run.startedAt,
		},
		logPath: `simulacra-data/runs/${run.runId}/log.jsonl`,
	};
	broadcast(run, frame("done", { runId: run.runId, status }));
	for (const s of run.subscribers) s.close();
	run.subscribers.clear();
};

const advance = (run: MockRun): void => {
	const tick = run.tick;
	let seq = 0;
	const at = (): LogicalTime => ({ tick, substep: 0, seq: seq++ });
	const head = (agentId?: EntityId, parent?: EventId) => ({
		eventId: eventId(),
		runId: run.runId,
		t: at(),
		seedPath: [run.seed, tick],
		...(agentId === undefined ? {} : { agentId }),
		...(parent === undefined ? {} : { parent }),
	});
	const emit = (e: SimEvent): void => {
		run.events.push(e);
		run.byId.set(e.eventId, e);
		if (e.parent !== undefined) {
			const siblings = run.children.get(e.parent);
			if (siblings) siblings.push(e.eventId);
			else run.children.set(e.parent, [e.eventId]);
		}
		broadcast(run, frame("event", e));
	};

	if (run.failAt !== undefined && tick >= run.failAt) {
		const failure: EventOf<"failure"> = {
			...head(),
			kind: "failure",
			payload: {
				stage: "run",
				excType: "ProviderBatchFailure",
				message: "3 consecutive ticks with whole-batch provider failure",
				retryable: false,
			},
		};
		emit(failure);
		finish(run, "failed");
		return;
	}

	const active = run.agents.filter(() => run.random() < run.profile.activation);
	run.activated += active.length;
	const activation: EventOf<"activation"> = {
		...head(),
		kind: "activation",
		payload: {
			policy: run.profile.activation >= 1 ? "allAgents" : "bernoulli",
			agentIds: active.map((a) => a.id),
			modes: Object.fromEntries(active.map((a) => [a.id, "llm" as const])),
		},
	};
	emit(activation);

	for (const agent of active) {
		const prompt = [
			`System: You are ${agent.name}, stance ${agent.stance}. Act as your profile would.`,
			`User: Tick ${tick}. Your feed shows ${Math.floor(run.random() * 5)} new posts.`,
			`Respond with a JSON object {"action": ..., "args": ..., "rationale": ...}.`,
		].join("\n");
		const contentSha = fakeSha(`${prompt}|${agent.id}|${tick}`);
		run.content.set(contentSha, prompt);
		const promptHash = fakeSha(`hash:${contentSha}`).slice(0, 32);
		const observation: EventOf<"observation"> = {
			...head(agent.id, activation.eventId),
			kind: "observation",
			payload: { contentSha, refs: [], truncated: false, promptHash },
		};
		emit(observation);

		const failed = run.random() < 0.06;
		const fallback = run.profile.actions[run.profile.actions.length - 1] ?? "silent";
		const action = failed
			? fallback
			: (run.profile.actions[Math.floor(run.random() * run.profile.actions.length)] ??
				fallback);
		const rationale = `As ${agent.name} I choose ${action} this round.`;
		const response = failed
			? "I think I would like to"
			: JSON.stringify({ action, args: {}, rationale });
		const responseSha = fakeSha(`${response}|${agent.id}|${tick}`);
		run.content.set(responseSha, response);
		const promptTokens = 280 + Math.floor(run.random() * 120);
		const completionTokens = 24 + Math.floor(run.random() * 40);
		run.llmCalls += 1;
		run.promptTokens += promptTokens;
		run.completionTokens += completionTokens;
		const llm: EventOf<"llm_call"> = {
			...head(agent.id, observation.eventId),
			kind: "llm_call",
			provenance: "llm",
			payload: {
				promptHash,
				responseSha,
				model: "mock-model",
				params: { structured: "json_schema", temperature: 0 },
				usage: { promptTokens, completionTokens, cachedTokens: 0 },
				latencyMs: 120 + Math.floor(run.random() * 400),
				recorded: false,
			},
		};
		emit(llm);

		if (failed) {
			run.parseFailures += 1;
			agent.failures += 1;
			const failure: EventOf<"failure"> = {
				...head(agent.id, observation.eventId),
				kind: "failure",
				payload: {
					stage: "provider",
					excType: "ParseError",
					message: "response is not a JSON object",
					retryable: false,
				},
			};
			emit(failure);
		}
		const rationaleSha = fakeSha(`rationale:${responseSha}`);
		if (!failed) run.content.set(rationaleSha, rationale);
		const neighbor = run.edges.find((e) => e.src === agent.id)?.dst;
		const decision: EventOf<"decision"> = {
			...head(agent.id, observation.eventId),
			kind: "decision",
			provenance: "llm",
			payload: {
				action,
				args: action === "reply" && neighbor !== undefined ? { targetId: neighbor } : {},
				...(failed ? {} : { rationaleSha }),
				provider: "main",
				parseOk: !failed,
			},
		};
		emit(decision);
		agent.decisions += 1;

		if (action !== "silent") {
			const effect: EventOf<"effect"> = {
				...head(agent.id, decision.eventId),
				kind: "effect",
				payload: {
					effects: [
						{
							op: "inc",
							entity: "agent",
							id: agent.id,
							column: `actions.${action}`,
							value: 1,
							cause: decision.eventId,
						},
					],
					rejected: [],
				},
			};
			emit(effect);
		}
	}

	const moduleStep: EventOf<"module_step"> = {
		...head(),
		kind: "module_step",
		payload: { module: "feed", summary: { effects: [], applied: 0, rejected: 0 } },
	};
	emit(moduleStep);

	for (const name of run.profile.metrics) {
		const previous = run.metrics[name]?.at(-1)?.value;
		const value = Math.round(nextMetric(name, previous, run.random) * 10000) / 10000;
		(run.metrics[name] ??= []).push({ tick, value });
		const measurement: EventOf<"measurement"> = {
			...head(),
			kind: "measurement",
			payload: { instrument: name, name, value },
		};
		emit(measurement);
	}

	if ((tick + 1) % 5 === 0) {
		const checkpoint: EventOf<"checkpoint"> = {
			...head(),
			kind: "checkpoint",
			payload: { path: `checkpoints/${tick + 1}`, worldHash: fakeSha(`world:${tick + 1}`) },
		};
		emit(checkpoint);
	}

	run.tick = tick + 1;
	if (run.tick >= run.ticks) finish(run, "succeeded");
};

const summaryOf = (run: MockRun): RunSummary => ({
	runId: run.runId,
	progress: { tick: run.tick, ticks: run.ticks, status: run.status },
	agentCount: run.agents.length,
	...(run.result === undefined ? {} : { result: run.result }),
});

const agentRows = (run: MockRun): readonly AgentRow[] =>
	run.agents.map((a) => ({
		id: a.id,
		columns: {
			"persona.name": a.name,
			"persona.stance": a.stance,
			ordinal: a.ordinal,
			decisions: a.decisions,
			failures: a.failures,
			degree: a.degree,
		},
	}));

const numberParam = (value: string | null): number | undefined =>
	value === null || value === "" ? undefined : Number(value);

const eventsPage = (run: MockRun, params: URLSearchParams): readonly SimEvent[] => {
	const kinds = params
		.get("kind")
		?.split(",")
		.filter((k) => k !== "");
	const agent = params.get("agent");
	const tick = numberParam(params.get("tick"));
	const fromTick = numberParam(params.get("fromTick"));
	const toTick = numberParam(params.get("toTick"));
	const limit = Math.min(PAGE_SIZE, numberParam(params.get("limit")) ?? PAGE_SIZE);
	const offset = numberParam(params.get("offset")) ?? 0;
	return run.events
		.filter(
			(e) =>
				(kinds === undefined || kinds.includes(e.kind)) &&
				(agent === null || e.agentId === agent) &&
				(tick === undefined || e.t.tick === tick) &&
				(fromTick === undefined || e.t.tick >= fromTick) &&
				(toTick === undefined || e.t.tick <= toTick),
		)
		.slice(offset, offset + limit);
};

const compareTime = (a: LogicalTime, b: LogicalTime): number =>
	a.tick - b.tick || a.substep - b.substep || a.seq - b.seq;

const chainOf = (run: MockRun, id: EventId): readonly SimEvent[] | undefined => {
	const anchor = run.byId.get(id);
	if (anchor === undefined) return undefined;
	const out = new Map<EventId, SimEvent>();
	let cursor: SimEvent | undefined = anchor;
	while (cursor !== undefined) {
		out.set(cursor.eventId, cursor);
		cursor = cursor.parent === undefined ? undefined : run.byId.get(cursor.parent);
	}
	const stack: EventId[] = [anchor.eventId];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		for (const child of run.children.get(current) ?? []) {
			const e = run.byId.get(child);
			if (e !== undefined && !out.has(child)) {
				out.set(child, e);
				stack.push(child);
			}
		}
	}
	return [...out.values()].sort((a, b) => compareTime(a.t, b.t));
};

const stream = (run: MockRun): Response => {
	const encoder = new TextEncoder();
	let subscriber: Subscriber | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (chunk: string): void => controller.enqueue(encoder.encode(chunk));
			if (run.status !== "running") {
				for (const e of run.events) send(frame("event", e));
				send(frame("done", { runId: run.runId, status: run.status }));
				controller.close();
				return;
			}
			subscriber = { send, close: () => controller.close() };
			run.subscribers.add(subscriber);
		},
		cancel() {
			if (subscriber !== undefined) run.subscribers.delete(subscriber);
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
	});
};

const baseScenario = (scenarioId: string, seed: number, n: number): Scenario => ({
	scenarioId,
	replicationId: 0,
	seed,
	seedPath: [],
	params: { opponent: "titForTat", framing: "canonical" },
	population: {
		n,
		fields: [
			{ name: "name", dtype: "str", sampling: { kind: "choice", choices: ["Alice", "Bob"] } },
		],
		source: { kind: "synthetic" },
		provenance: "synthetic",
	},
	modules: [{ kind: "pd" }],
	executors: [{ kind: "focal", name: "player", options: { provider: "player" } }],
	providers: { player: { kind: "llm" } },
	policy: { kind: "allAgents" },
	instruments: [{ kind: "cooperationRate", every: 1 }],
	steps: [{ kind: "run", ticks: 10 }],
	llm: {
		baseUrl: "https://api.deepseek.com/v1",
		model: "deepseek-v4-flash",
		apiKeyEnv: "SIMULACRA_LLM_API_KEY",
		mode: "replay",
		concurrency: { initial: 4, max: 16 },
		structured: "auto",
		budget: { maxCalls: 40, maxCompletionTokens: 200 },
		timeoutMs: 60000,
		sendSeed: true,
	},
	prompt: {
		personaFormat: "plain",
		instructionOrder: "first",
		rolePlacement: "system",
		naming: "id",
		memoryRepresentation: "transcript",
		contextWindow: 4000,
	},
});

const holmCorrect = (tests: readonly PairwiseTest[]): readonly PairwiseTest[] => {
	const order = [...tests].sort((x, y) => x.mwuP - y.mwuP);
	const adjusted = new Map<string, number>();
	let running = 0;
	order.forEach((t, i) => {
		running = Math.max(running, (order.length - i) * t.mwuP);
		adjusted.set(t.b, Math.min(1, running));
	});
	return tests.map((t) => ({ ...t, holmP: adjusted.get(t.b) ?? 1 }));
};

const buildPdAudit = (): { readonly plan: AuditPlan; readonly report: AuditReport } => {
	const random = seeded(42);
	const base = baseScenario("prisoners_dilemma", 1, 2);
	const axes: AuditPlan["axes"] = [
		{
			id: "personaFormat",
			level: "micro",
			kind: "representation",
			dimension: "persona_format",
			target: "prompt.personaFormat",
			levels: ["plain", "bullets", "table"],
		},
		{
			id: "framing",
			level: "meso",
			kind: "design",
			dimension: "instruction_framing",
			target: "params.framing",
			levels: ["canonical", "moralized", "risk"],
		},
		{
			id: "memoryRepresentation",
			level: "micro",
			kind: "representation",
			dimension: "memory_format",
			target: "prompt.memoryRepresentation",
			levels: ["transcript", "json", "bullets"],
		},
	];
	const plan: AuditPlan = {
		base,
		hypothesis: {
			id: "H1",
			claim: "Moralized framing raises the cooperation rate against tit-for-tat",
			claimType: "mechanism",
			arms: [],
			outcomes: [{ name: "cooperation", metric: "cooperationRate", direction: "increase" }],
		},
		axes,
		design: "one_at_a_time",
		replications: 5,
		models: ["mock"],
		metrics: ["cooperationRate", "averagePayoff"],
		claimType: "mechanism",
		concurrency: 2,
	};
	const conditions: Condition[] = [
		{ conditionId: "base", axisValues: {}, model: "mock", scenario: base },
	];
	for (const axis of axes)
		for (const level of axis.levels.slice(1))
			conditions.push({
				conditionId: `${axis.id}=${String(level)}`,
				axisValues: { [axis.id]: level },
				model: "mock",
				scenario: base,
			});
	const runs: RunResult[] = conditions.flatMap((c) =>
		Array.from({ length: plan.replications }, (_, i) => ({
			runId: `${c.conditionId}:${i}` as RunId,
			scenarioHash: fakeSha(c.conditionId),
			seed: i,
			status: "succeeded" as const,
			metrics: {
				cooperationRate: Math.round((0.4 + random() * 0.4) * 1000) / 1000,
				averagePayoff: Math.round((2 + random() * 1.5) * 1000) / 1000,
			},
			distributions: {},
			integrity: {
				activated: 20,
				ok: 20,
				failed: 0,
				parseFailures: 0,
				llmCalls: 10,
				llmFailures: 0,
				droppedEffects: 0,
				rejectedActions: 0,
				complete: true,
			},
			cost: {
				llmCalls: 10,
				promptTokens: 3200,
				completionTokens: 410,
				cachedTokens: 0,
				wallMs: 900,
			},
			logPath: `simulacra-data/audits/prisoners_dilemma-audit/${c.conditionId}/${i}/log.jsonl`,
		})),
	);
	const pairwise: PairwiseTest[] = [];
	for (const metric of plan.metrics) {
		const rate = metric === "cooperationRate";
		const tests = conditions.slice(1).map((c): PairwiseTest => {
			const meanA = rate ? 0.55 : 2.6;
			const meanB = meanA + (random() - 0.5) * (rate ? 0.4 : 1.2);
			const meanDiff = meanB - meanA;
			const sd = rate ? 0.12 : 0.5;
			const cohenD = meanDiff / sd;
			const half = 1.96 * sd * Math.sqrt(2 / plan.replications);
			const mwuP = Math.min(
				1,
				Math.max(0.0005, Math.exp(-Math.abs(cohenD) * 2.2) * (0.5 + random())),
			);
			return {
				metric,
				a: "base",
				b: c.conditionId,
				nA: plan.replications,
				nB: plan.replications,
				meanA,
				meanB,
				meanDiff,
				ci95: [meanDiff - half, meanDiff + half],
				cohenD,
				mwuP,
				holmP: mwuP,
				directionFlip: rate && meanDiff < -0.15,
			};
		});
		pairwise.push(...holmCorrect(tests));
	}
	const sensitivityRank = axes
		.map((axis): readonly [string, number] => [
			axis.id,
			pairwise
				.filter((p) => p.b.startsWith(`${axis.id}=`))
				.reduce((m, p) => Math.max(m, Math.abs(p.cohenD)), 0),
		])
		.sort((a, b) => b[1] - a[1]);
	const report: AuditReport = {
		planHash: fakeSha("prisoners_dilemma-audit"),
		conditions,
		runs,
		pairwise,
		directionConsistency: { cooperationRate: 0.83, averagePayoff: 0.67 },
		sensitivityRank,
		distributionTests: [
			{
				metric: "cooperationRate",
				a: "base",
				b: "framing=moralized",
				w1: 0.08,
				cliffDelta: 0.28,
				tvd: 0.12,
			},
			{
				metric: "cooperationRate",
				a: "base",
				b: "framing=risk",
				w1: 0.05,
				cliffDelta: -0.12,
			},
		],
		crossModel: {
			mock: { cooperationRate: 0.57, averagePayoff: 2.7 },
			"deepseek-v4-flash": { cooperationRate: 0.61, averagePayoff: 2.9 },
		},
		integritySummary: {
			runs: runs.length,
			complete: runs.length,
			excluded: 0,
			failed: 0,
			parseFailures: 4,
		},
		costSummary: {
			llmCalls: 350,
			promptTokens: 112000,
			completionTokens: 14350,
			cachedTokens: 0,
			wallMs: 18000,
		},
		evidenceGrade: "weak",
	};
	return { plan, report };
};

const buildEchoPlan = (): AuditPlan => ({
	base: baseScenario("echo_chamber", 7, 100),
	axes: [
		{
			id: "homophily",
			level: "meso",
			kind: "design",
			dimension: "network_homophily",
			target: "params.homophily",
			levels: ["low", "medium", "high"],
		},
		{
			id: "activation",
			level: "macro",
			kind: "design",
			dimension: "activation_rate",
			target: "params.activation",
			levels: [0.1, 0.3, 0.6],
		},
	],
	design: "one_at_a_time",
	replications: 12,
	models: ["mock"],
	metrics: ["stanceAssortativity", "sameGroupRatio"],
	claimType: "exploratory",
	concurrency: 4,
});

const examples = (): readonly Example[] =>
	existsSync(EXAMPLES_DIR)
		? readdirSync(EXAMPLES_DIR, { withFileTypes: true })
				.filter(
					(e) =>
						e.isDirectory() && existsSync(join(EXAMPLES_DIR, e.name, "scenario.yaml")),
				)
				.map((e) => ({
					name: e.name,
					yaml: readFileSync(join(EXAMPLES_DIR, e.name, "scenario.yaml"), "utf8"),
				}))
				.sort((a, b) => a.name.localeCompare(b.name))
		: [];

const runs = new Map<RunId, MockRun>();
const audits = new Map<string, AuditSummary>();

const seedRun = (run: MockRun, ticksToAdvance: number): void => {
	runs.set(run.runId, run);
	for (let i = 0; i < ticksToAdvance && run.status === "running"; i++) advance(run);
};

seedRun(createRun("echo_chamber", 0, 7, 100, 15, ECHO), 15);
seedRun(createRun("prisoners_dilemma", 0, 1, 2, 10, PD), 10);
seedRun(createRun("echo_chamber", 1, 8, 100, 40, ECHO), 0);
seedRun(createRun("echo_chamber", 2, 9, 6000, 5, { ...ECHO, activation: 0.1 }), 5);
seedRun(createRun("echo_chamber", 3, 10, 100, 15, ECHO, 4), 15);

const pdAudit = buildPdAudit();
audits.set("prisoners_dilemma-audit", {
	auditId: "prisoners_dilemma-audit",
	progress: { completed: 35, total: 35, status: "succeeded" },
	plan: pdAudit.plan,
	report: pdAudit.report,
});
audits.set("echo_chamber-audit", {
	auditId: "echo_chamber-audit",
	progress: { completed: 12, total: 60, status: "running" },
	plan: buildEchoPlan(),
});

setInterval(() => {
	for (const run of runs.values()) if (run.status === "running") advance(run);
}, TICK_MS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const json = (data: unknown, status = 200): Response => Response.json(data, { status });
const notFound = (what: string): Response => json({ error: `${what} not found` }, 404);

const createFromRequest = async (req: Request): Promise<Response> => {
	const body: unknown = await req.json().catch(() => undefined);
	const issues: { readonly path: readonly string[]; readonly message: string }[] = [];
	const fields = isRecord(body) ? body : {};
	if (!isRecord(body)) issues.push({ path: [], message: "body must be a JSON object" });
	const scenario = typeof fields.scenario === "string" ? fields.scenario : undefined;
	if (scenario === undefined || scenario.trim() === "")
		issues.push({ path: ["scenario"], message: "expected scenario YAML text" });
	const seed =
		typeof fields.seed === "number" && Number.isInteger(fields.seed) ? fields.seed : undefined;
	if (seed === undefined) issues.push({ path: ["seed"], message: "expected an integer" });
	const ticks = fields.ticks;
	if (
		ticks !== undefined &&
		(typeof ticks !== "number" || !Number.isInteger(ticks) || ticks <= 0)
	)
		issues.push({ path: ["ticks"], message: "expected a positive integer" });
	if (fields.provider !== undefined && fields.provider !== "mock" && fields.provider !== "llm")
		issues.push({ path: ["provider"], message: "expected mock or llm" });
	if (issues.length > 0 || scenario === undefined || seed === undefined)
		return json({ issues }, 400);
	const scenarioId = /^scenarioId:\s*(\S+)/m.exec(scenario)?.[1] ?? "scenario";
	const n = Number(/^\s+n:\s*(\d+)/m.exec(scenario)?.[1] ?? "50");
	const replication = [...runs.keys()].filter((k) => k.startsWith(`${scenarioId}:`)).length;
	const runId = runIdOf(scenarioId, replication);
	if (runs.has(runId)) return json({ error: `run ${runId} already exists` }, 409);
	const run = createRun(
		scenarioId,
		replication,
		seed,
		n,
		typeof ticks === "number" ? ticks : 12,
		scenarioId === "prisoners_dilemma" ? PD : ECHO,
	);
	runs.set(runId, run);
	return json({ runId }, 201);
};

const reportHtml = (audit: AuditSummary): string =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${audit.auditId}</title></head><body><h1>${audit.auditId}</h1><p>Evidence grade: ${audit.report?.evidenceGrade ?? "pending"}</p></body></html>`;

const handle = async (req: Request): Promise<Response> => {
	const url = new URL(req.url);
	const [root, resource, rawId, sub, rawSubId, tail] = url.pathname
		.split("/")
		.filter((p) => p !== "");
	if (root !== "api") return notFound(url.pathname);
	const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
	const subId = rawSubId === undefined ? undefined : decodeURIComponent(rawSubId);
	if (resource === "health") return json({ ok: true, version: "dev-mock" });
	if (resource === "examples") return json(examples());
	if (resource === "runs") {
		if (id === undefined)
			return req.method === "POST"
				? createFromRequest(req)
				: json([...runs.values()].map(summaryOf));
		const run = runs.get(id as RunId);
		if (run === undefined) return notFound(`run ${id}`);
		if (sub === undefined) return json(summaryOf(run));
		if (sub === "events" && subId === undefined) return json(eventsPage(run, url.searchParams));
		if (sub === "events" && subId !== undefined && tail === "chain") {
			const chain = chainOf(run, subId as EventId);
			return chain === undefined ? notFound(`event ${subId}`) : json(chain);
		}
		if (sub === "content" && subId !== undefined) {
			const text = run.content.get(subId);
			return text === undefined
				? notFound(`content ${subId}`)
				: new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		if (sub === "agents") return json(agentRows(run));
		if (sub === "graph")
			return json({
				tick: numberParam(url.searchParams.get("tick")) ?? run.tick,
				edges: run.edges,
			});
		if (sub === "metrics") return json(run.metrics);
		if (sub === "stream") return stream(run);
	}
	if (resource === "audits") {
		if (id === undefined) return json([...audits.values()]);
		const audit = audits.get(id);
		if (audit === undefined) return notFound(`audit ${id}`);
		if (sub === undefined) return json(audit);
		if (sub === "report.html")
			return new Response(reportHtml(audit), {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
	}
	return notFound(url.pathname);
};

Bun.serve({ port: PORT, fetch: handle });
console.log(`dev-mock listening on http://127.0.0.1:${PORT}`);
