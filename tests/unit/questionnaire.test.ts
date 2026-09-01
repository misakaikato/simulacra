import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryEventLog } from "../../src/core/log";
import type { DecisionProvider } from "../../src/core/protocols";
import {
	ANSWERS_ARG,
	ANSWER_ACTION,
	answersSchema,
	parseAnswers,
	questionnaireInstruction,
} from "../../src/core/questionnaire";
import { ok } from "../../src/core/result";
import { createSimulation, type Simulation } from "../../src/core/simulation";
import type { JsonObject, JsonValue } from "../../src/core/types";
import { silentLogger } from "../../src/logging/logger";
import { ruleDecision } from "../../src/providers/rule";
import {
	gatewayFactory,
	kernelRegistry,
	kernelScenario,
	type KernelFixture,
} from "../helpers/kernel";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-questionnaire-"));

const QUESTIONS: JsonValue = [
	{ id: "trust", prompt: "How much do you trust the feed?", responseType: "integer" },
	{ id: "mood", prompt: "How do you feel?", responseType: "choice", choices: ["good", "bad"] },
];

const exit = (entersMemory: boolean): JsonObject => ({
	kind: "questionnaire",
	name: "exit",
	options: { questions: QUESTIONS, entersMemory },
});

const build = (overrides: JsonObject, fixture: KernelFixture = kernelRegistry()): Simulation => {
	const created = createSimulation(kernelScenario(overrides), fixture.registry, {
		outDir: tempDir(),
		logger: silentLogger,
		log: createMemoryEventLog(),
		createGateway: gatewayFactory,
	});
	if (!created.ok) throw new Error(`${created.error.excType}: ${created.error.message}`);
	return created.value;
};

const kinds = (sim: Simulation): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const e of sim.log.query({})) out[e.kind] = (out[e.kind] ?? 0) + 1;
	return out;
};

describe("questionnaire step", () => {
	test("interviews every agent through its executor's provider without touching the world", async () => {
		const sim = build({ instruments: [exit(true)], providers: { main: { kind: "mock" } } });
		const r = await sim.step();
		expect(r.ok).toBe(true);
		const before = sim.world.hash();
		const eventsBefore = sim.log.count();
		await sim.questionnaire("exit", undefined, 1);
		expect(sim.world.hash()).toBe(before);
		const measurements = sim.log
			.query({ kind: ["measurement"] })
			.filter((e) => e.kind === "measurement" && e.payload.instrument === "exit");
		expect(measurements).toHaveLength(3 * 2);
		for (const m of measurements) {
			if (m.kind !== "measurement") continue;
			expect(m.provenance).toBe("interview");
			expect(m.agentId).toBeDefined();
			expect(m.parent).toBeDefined();
			if (m.payload.name === "trust") expect(Number.isInteger(m.payload.value)).toBe(true);
			else expect(["good", "bad"]).toContain(String(m.payload.value));
		}
		const interviews = sim.log
			.query({ kind: ["decision"] })
			.filter((e) => e.provenance === "interview");
		expect(interviews).toHaveLength(3);
		expect(interviews.every((d) => d.agentId !== undefined)).toBe(true);
		expect(
			interviews.every((d) => d.kind === "decision" && d.payload.action === ANSWER_ACTION),
		).toBe(true);
		const failures = sim.log.query({ kind: ["failure"] });
		expect(failures.filter((f) => f.t.tick === 1)).toEqual([]);
		expect(sim.log.count()).toBe(eventsBefore + 3 + 3 + 6);
		expect(sim.clock.now).toEqual({ tick: 1, substep: 0, seq: 0 });
		const observations = sim.log
			.query({ kind: ["observation"] })
			.filter((e) => e.provenance === "interview");
		expect(observations).toHaveLength(3);
		const first = observations[0];
		const content =
			first?.kind === "observation" ? sim.log.getContent(first.payload.contentSha) : "";
		expect(content).toContain("How much do you trust the feed?");
		expect(content).toContain("Play along.");
		const r2 = await sim.step();
		expect(r2.ok).toBe(true);
		expect(sim.integrity().complete).toBe(true);
	});

	test("entersMemory false keeps interview events off the agent timeline and skips after()", async () => {
		const fixture = kernelRegistry();
		let afterCalls = 0;
		const original = fixture.registry.executors.get("focal");
		if (original === undefined) throw new Error("focal missing");
		fixture.registry.executors.register("spyFocal", (spec, ctx) => {
			const made = original(spec, ctx);
			if (!made.ok) return made;
			const executor = made.value;
			const interview = executor.interview;
			return ok({
				name: executor.name,
				entity: executor.entity,
				provider: executor.provider,
				declare: (world) => executor.declare(world),
				owns: (world, id) => executor.owns?.(world, id) ?? true,
				observe: (...args) => executor.observe(...args),
				...(interview === undefined ? {} : { interview: interview.bind(executor) }),
				act: (...args) => executor.act(...args),
				after: async (...args) => {
					afterCalls += 1;
					return executor.after(...args);
				},
				getState: () => executor.getState(),
				setState: (s) => executor.setState(s),
			});
		});
		const spied: JsonObject = {
			executors: [
				{
					kind: "spyFocal",
					name: "people",
					options: {
						provider: "main",
						components: [
							{ kind: "instructions", options: { text: "Play along." } },
							{ kind: "persona" },
							{ kind: "recentMemory", options: { k: 3 } },
						],
					},
				},
			],
			instruments: [exit(false)],
			providers: { main: { kind: "mock" } },
		};
		const sim = build(spied, fixture);
		await sim.step();
		const afterTick = afterCalls;
		await sim.questionnaire("exit", undefined, 1);
		expect(afterCalls).toBe(afterTick);
		const interviews = sim.log.query({}).filter((e) => e.provenance === "interview");
		const decisions = interviews.filter((e) => e.kind === "decision");
		const observations = interviews.filter((e) => e.kind === "observation");
		expect(decisions).toHaveLength(3);
		expect(observations).toHaveLength(3);
		expect([...decisions, ...observations].every((e) => e.agentId === undefined)).toBe(true);
		expect(
			interviews
				.filter((e) => e.kind === "measurement")
				.every((e) => e.agentId !== undefined),
		).toBe(true);
		const withMemory = build({
			instruments: [exit(true)],
			providers: { main: { kind: "mock" } },
		});
		await withMemory.step();
		await withMemory.questionnaire("exit", undefined, 1);
		await withMemory.step();
		const lastPrompt = withMemory.log
			.query({ kind: ["observation"], tick: 1 })
			.filter((e) => e.provenance === undefined)
			.map((e) =>
				e.kind === "observation" ? withMemory.log.getContent(e.payload.contentSha) : "",
			);
		expect(lastPrompt.some((p) => p?.includes(ANSWER_ACTION))).toBe(true);
	});

	test("targets select a subset reproducibly and invalid answers become failures", async () => {
		const fixture = kernelRegistry();
		const sloppy: DecisionProvider = {
			name: "sloppy",
			decide: async (requests) =>
				requests.map((req) =>
					ok({
						...ruleDecision(req, ANSWER_ACTION),
						args: { [ANSWERS_ARG]: { trust: "many", mood: "good" } },
					}),
				),
			reset: () => {},
			getState: () => null,
			setState: () => {},
		};
		fixture.registry.providers.register("sloppy", () => ok(sloppy));
		const overrides: JsonObject = {
			instruments: [exit(true)],
			providers: { main: { kind: "sloppy" } },
		};
		const targets = { where: {}, n: 2 };
		const a = build(overrides, fixture);
		const b = build(overrides, fixture);
		await a.step();
		await b.step();
		await a.questionnaire("exit", targets, 1);
		await b.questionnaire("exit", targets, 1);
		const measured = (sim: Simulation) =>
			sim.log
				.query({ kind: ["measurement"] })
				.filter((e) => e.kind === "measurement" && e.payload.instrument === "exit");
		expect(measured(a)).toHaveLength(2);
		expect(measured(a).map((e) => e.agentId)).toEqual(measured(b).map((e) => e.agentId));
		const failures = a.log
			.query({ kind: ["failure"] })
			.filter((e) => e.kind === "failure" && e.payload.excType === "invalid_answer");
		expect(failures).toHaveLength(2);
		expect(failures[0]?.kind === "failure" && failures[0].payload.message).toContain("trust");
	});

	test("unknown questionnaires and empty selections are failures, not crashes", async () => {
		const sim = build({ instruments: [exit(true)], providers: { main: { kind: "mock" } } });
		await sim.questionnaire("nope", undefined, 0);
		await sim.questionnaire("exit", { where: { "persona.name": "Nobody" } }, 1);
		const failures = sim.log
			.query({ kind: ["failure"] })
			.map((e) => (e.kind === "failure" ? e.payload.excType : ""));
		expect(failures).toEqual(["unknown_questionnaire", "empty_selection"]);
		expect(kinds(sim).measurement).toBeUndefined();
	});

	test("questionnaire options are validated at assembly", () => {
		const fixture = kernelRegistry();
		const created = createSimulation(
			kernelScenario({
				instruments: [
					{
						kind: "questionnaire",
						name: "bad",
						options: {
							questions: [{ id: "q", prompt: "?", responseType: "choice" }],
						},
					},
				],
			}),
			fixture.registry,
			{
				outDir: tempDir(),
				logger: silentLogger,
				log: createMemoryEventLog(),
				createGateway: gatewayFactory,
			},
		);
		expect(created.ok).toBe(false);
		if (!created.ok) expect(created.error.excType).toBe("InstrumentCreate");
	});
});

describe("answer parsing", () => {
	const q = {
		name: "exit",
		entersMemory: true,
		questions: [
			{ id: "n", prompt: "count", responseType: "integer" as const },
			{ id: "x", prompt: "value", responseType: "float" as const },
			{ id: "c", prompt: "pick", responseType: "choice" as const, choices: ["a", "b"] },
			{ id: "t", prompt: "say", responseType: "text" as const },
		],
	};

	test("accepts typed values and numeric strings, rejects the rest", () => {
		const good = parseAnswers(q, { [ANSWERS_ARG]: { n: "3", x: 1.5, c: "b", t: "hi" } });
		expect(good.issues).toEqual([]);
		expect(good.answers).toEqual({ n: 3, x: 1.5, c: "b", t: "hi" });
		const bad = parseAnswers(q, { [ANSWERS_ARG]: { n: 1.5, x: "abc", c: "z", t: 4 } });
		expect(bad.answers).toEqual({});
		expect(bad.issues.map((i) => i.questionId)).toEqual(["n", "x", "c", "t"]);
		const missing = parseAnswers(q, {});
		expect(missing.issues).toHaveLength(4);
	});

	test("schema and instruction cover every question", () => {
		const schema = answersSchema(q);
		expect(JSON.stringify(schema)).toContain('"enum":["a","b"]');
		const text = questionnaireInstruction(q);
		for (const question of q.questions) expect(text).toContain(question.id);
	});
});
