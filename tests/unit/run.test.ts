import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCheckpoint } from "../../src/core/checkpoint";
import { FAILURE_TYPES } from "../../src/core/failures";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";
import {
	CHECKPOINTS_DIR,
	LOG_FILE,
	RESULT_FILE,
	runScenario,
	withLlmOverride,
	withProviderOverride,
	withTicksOverride,
} from "../../src/core/run";
import { readRunScenario } from "../../src/core/runDir";
import type { RunResult } from "../../src/core/types";
import { gatewayFactory, kernelRegistry, kernelScenario } from "../helpers/kernel";
import { z } from "zod";

const structuredOf = (params: unknown): string | null | undefined => {
	const parsed = z.object({ structured: z.string().nullable() }).safeParse(params);
	return parsed.success ? parsed.data.structured : undefined;
};

process.env.NO_PROXY ??= "127.0.0.1,localhost";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-run-"));

const readResult = (dir: string): RunResult =>
	JSON.parse(readFileSync(join(dir, RESULT_FILE), "utf8")) as RunResult;

const readLog = (dir: string): readonly Record<string, unknown>[] =>
	readFileSync(join(dir, LOG_FILE), "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("runScenario", () => {
	test("writes result.json, log.jsonl, checkpoints and an events database", async () => {
		const out = tempDir();
		const fixture = kernelRegistry();
		const scenario = kernelScenario({
			steps: [{ kind: "run", ticks: 2 }, { kind: "checkpoint" }, { kind: "run", ticks: 1 }],
		});
		const r = await runScenario(scenario, fixture.registry, out, {
			logLevel: "debug",
			createGateway: gatewayFactory,
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.status).toBe("succeeded");
		expect(String(r.value.runId)).toBe("kernel:0");
		expect(r.value.seed).toBe(21);
		expect(r.value.metrics).toEqual({ scoreSum: 9 });
		expect(r.value.distributions).toEqual({ scores: [3, 3, 3] });
		expect(r.value.integrity.complete).toBe(true);
		expect(r.value.integrity.activated).toBe(9);
		expect(r.value.logPath).toBe(join(out, LOG_FILE));
		expect(readResult(out)).toEqual(r.value);
		expect(existsSync(join(out, CHECKPOINTS_DIR, "0"))).toBe(true);
		expect(existsSync(join(out, CHECKPOINTS_DIR, "2"))).toBe(true);
		const loaded = loadCheckpoint(join(out, CHECKPOINTS_DIR, "2"), r.value.scenarioHash);
		expect(loaded.ok).toBe(true);
		if (loaded.ok) expect(loaded.value.clock.now.tick).toBe(2);
		const log = openSqliteEventLog(eventLogPath(out));
		expect(log.query({ kind: ["checkpoint"] })).toHaveLength(2);
		expect(log.query({ kind: ["activation"] })).toHaveLength(3);
		log.close();
		const lines = readLog(out);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((l) => l.runId === "kernel:0" || l.msg === "run finished")).toBe(true);
		expect(lines.some((l) => l.msg === "tick complete" && l.tick === 2)).toBe(true);
	});

	test("two runs with the same seed produce the same digest", async () => {
		const a = tempDir();
		const b = tempDir();
		const opts = { createGateway: gatewayFactory };
		await runScenario(kernelScenario(), kernelRegistry().registry, a, opts);
		await runScenario(kernelScenario(), kernelRegistry().registry, b, opts);
		const da = openSqliteEventLog(eventLogPath(a));
		const db = openSqliteEventLog(eventLogPath(b));
		expect(da.digest()).toBe(db.digest());
		expect(da.count()).toBeGreaterThan(10);
		da.close();
		db.close();
		expect(readResult(a).scenarioHash).toBe(readResult(b).scenarioHash);
	});

	test("refuses a non-empty output directory unless overwrite is set", async () => {
		const out = tempDir();
		writeFileSync(join(out, "leftover.txt"), "x");
		const refused = await runScenario(kernelScenario(), kernelRegistry().registry, out, {
			createGateway: gatewayFactory,
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error.excType).toBe("OutputDirNotEmpty");
		const allowed = await runScenario(kernelScenario(), kernelRegistry().registry, out, {
			overwrite: true,
			createGateway: gatewayFactory,
		});
		expect(allowed.ok).toBe(true);
		expect(existsSync(join(out, "leftover.txt"))).toBe(false);
		expect(existsSync(join(out, RESULT_FILE))).toBe(true);
	});

	test("ticksOverride and providerOverride reshape the scenario", async () => {
		const base = kernelScenario({
			steps: [{ kind: "run", ticks: 2 }, { kind: "checkpoint" }, { kind: "run", ticks: 4 }],
		});
		expect(withTicksOverride(base, 3).steps).toEqual([
			{ kind: "run", ticks: 2 },
			{ kind: "checkpoint" },
			{ kind: "run", ticks: 1 },
		]);
		expect(withTicksOverride(base, 10).steps).toEqual([
			{ kind: "run", ticks: 2 },
			{ kind: "checkpoint" },
			{ kind: "run", ticks: 8 },
		]);
		expect(withTicksOverride(base, 1).steps).toEqual([
			{ kind: "run", ticks: 1 },
			{ kind: "checkpoint" },
		]);
		expect(withTicksOverride(kernelScenario({ steps: [] }), 2).steps).toEqual([
			{ kind: "run", ticks: 2 },
		]);
		expect(withProviderOverride(base, "mock").providers).toEqual({ main: { kind: "mock" } });

		const out = tempDir();
		const r = await runScenario(base, kernelRegistry().registry, out, {
			ticksOverride: 4,
			providerOverride: "mock",
			createGateway: gatewayFactory,
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.integrity.activated).toBe(12);
			expect(r.value.status).toBe("succeeded");
		}
		const log = openSqliteEventLog(eventLogPath(out));
		const decisions = log.query({ kind: ["decision"] });
		expect(decisions.every((d) => d.kind === "decision" && d.payload.provider === "main")).toBe(
			true,
		);
		expect(decisions.some((d) => d.kind === "decision" && d.payload.action === "noop")).toBe(
			true,
		);
		log.close();
	});

	test("intervene and questionnaire steps that name nothing declared record failures and continue", async () => {
		const out = tempDir();
		const scenario = kernelScenario({
			steps: [
				{ kind: "run", ticks: 1 },
				{ kind: "intervene", arm: "treatment" },
				{ kind: "questionnaire", name: "exit" },
				{ kind: "checkpoint" },
				{ kind: "run", ticks: 1 },
			],
		});
		const r = await runScenario(scenario, kernelRegistry().registry, out, {
			createGateway: gatewayFactory,
		});
		expect(r.ok && r.value.status).toBe("succeeded");
		expect(existsSync(join(out, CHECKPOINTS_DIR, "1", "meta.json"))).toBe(true);
		const log = openSqliteEventLog(eventLogPath(out));
		const intervention = log.query({ kind: ["intervention"] });
		expect(intervention).toHaveLength(1);
		if (intervention[0]?.kind === "intervention") {
			expect(intervention[0].payload).toEqual({
				stepIndex: 1,
				arm: "treatment",
				targets: [],
			});
			expect(intervention[0].t).toEqual({ tick: 1, substep: 0, seq: 0 });
		}
		expect(
			log.query({ kind: ["measurement"] }).filter((e) => e.t.tick === 1 && e.t.substep === 0),
		).toEqual([]);
		const failures = log
			.query({ kind: ["failure"] })
			.map((f) => (f.kind === "failure" ? f.payload.excType : ""));
		expect(failures).toEqual([FAILURE_TYPES.unknownArm, FAILURE_TYPES.unknownQuestionnaire]);
		log.close();
		const lines = readLog(out);
		expect(lines.filter((l) => l.level === "error")).toHaveLength(2);
	});

	test("instantiate failures still produce a failed result.json", async () => {
		const out = tempDir();
		const r = await runScenario(
			kernelScenario({ providers: { other: { kind: "scripted" } } }),
			kernelRegistry().registry,
			out,
			{ createGateway: gatewayFactory },
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.status).toBe("failed");
			expect(r.value.failure?.stage).toBe("instantiate");
			expect(r.value.integrity.complete).toBe(false);
		}
		expect(readResult(out).status).toBe("failed");
		expect(readLog(out).some((l) => l.level === "error")).toBe(true);
	});

	test("llm provider end to end: record once, replay twice with identical digests and real cost", async () => {
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async () => {
				calls += 1;
				return Response.json({
					model: "fake",
					choices: [
						{
							message: {
								content:
									'{"action": "bump", "args": {"amount": 2}, "rationale": "keep score up"}',
							},
						},
					],
					usage: { prompt_tokens: 50, completion_tokens: 12 },
				});
			},
		});
		try {
			const recordDir = tempDir();
			const scenarioFor = (mode: "record" | "replay") =>
				kernelScenario({
					population: { n: 2 },
					providers: { main: { kind: "llm" } },
					llm: {
						baseUrl: `http://127.0.0.1:${server.port}/v1`,
						model: "fake",
						mode,
						recordDir,
					},
					steps: [{ kind: "run", ticks: 2 }],
				});
			const opts = { createGateway: gatewayFactory };
			const recorded = await runScenario(
				scenarioFor("record"),
				kernelRegistry().registry,
				tempDir(),
				opts,
			);
			expect(recorded.ok && recorded.value.status).toBe("succeeded");
			if (!recorded.ok) return;
			expect(calls).toBe(4);
			expect(recorded.value.cost).toMatchObject({
				llmCalls: 4,
				promptTokens: 200,
				completionTokens: 48,
			});
			expect(recorded.value.integrity).toMatchObject({
				activated: 4,
				ok: 4,
				llmCalls: 4,
				llmFailures: 0,
			});
			expect(recorded.value.metrics.scoreSum).toBe(8);

			const a = tempDir();
			const b = tempDir();
			const ra = await runScenario(scenarioFor("replay"), kernelRegistry().registry, a, opts);
			const rb = await runScenario(scenarioFor("replay"), kernelRegistry().registry, b, opts);
			expect(calls).toBe(4);
			expect(ra.ok && ra.value.status).toBe("succeeded");
			expect(rb.ok && rb.value.integrity).toMatchObject({
				llmCalls: 0,
				llmFailures: 0,
				ok: 4,
			});
			expect(rb.ok && rb.value.cost.llmCalls).toBe(0);
			expect(rb.ok && rb.value.metrics.scoreSum).toBe(8);
			const la = openSqliteEventLog(eventLogPath(a));
			const lb = openSqliteEventLog(eventLogPath(b));
			expect(la.digest()).toBe(lb.digest());
			const llmCalls = la.query({ kind: ["llm_call"] });
			expect(llmCalls).toHaveLength(4);
			expect(llmCalls.every((e) => e.kind === "llm_call" && e.payload.recorded)).toBe(true);
			expect(
				llmCalls.every(
					(e) =>
						e.kind === "llm_call" && structuredOf(e.payload.params) === "json_schema",
				),
			).toBe(true);
			const decision = la.query({ kind: ["decision"] })[0];
			if (decision?.kind === "decision") {
				expect(decision.payload.action).toBe("bump");
				expect(la.getContent(decision.payload.rationaleSha ?? "")).toBe("keep score up");
				expect(la.chain(decision.eventId).map((e) => e.kind)).toEqual([
					"observation",
					"decision",
				]);
				expect(la.chain(decision.parent!).map((e) => e.kind)).toEqual([
					"observation",
					"llm_call",
					"decision",
				]);
			}
			la.close();
			lb.close();
		} finally {
			server.stop(true);
		}
	});

	test("gateway failures become llm-stage failure events counted in integrity", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				const body = (await req.json()) as Record<string, unknown>;
				if ("response_format" in body)
					return new Response(JSON.stringify({ error: "json_schema unsupported" }), {
						status: 400,
					});
				return Response.json({
					model: "fake",
					choices: [
						{ message: { content: '{"action":"noop","args":{},"rationale":"r"}' } },
					],
					usage: { prompt_tokens: 5, completion_tokens: 2 },
				});
			},
		});
		try {
			const out = tempDir();
			const scenario = kernelScenario({
				population: { n: 2 },
				providers: { main: { kind: "llm" } },
				llm: {
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					model: "fake",
					structured: "auto",
					budget: { maxCalls: 3, maxCompletionTokens: 64 },
				},
				steps: [{ kind: "run", ticks: 2 }],
			});
			const r = await runScenario(scenario, kernelRegistry().registry, out, {
				createGateway: gatewayFactory,
			});
			expect(r.ok && r.value.status).toBe("succeeded");
			if (!r.ok) return;
			expect(r.value.cost.llmCalls).toBe(3);
			expect(r.value.integrity).toMatchObject({
				activated: 4,
				ok: 3,
				failed: 1,
				llmCalls: 3,
			});
			expect(r.value.integrity.llmFailures).toBe(2);
			const log = openSqliteEventLog(eventLogPath(out));
			const llmStage = log
				.query({ kind: ["failure"] })
				.filter((e) => e.kind === "failure" && e.payload.stage === "llm");
			const types = llmStage.map((e) => (e.kind === "failure" ? e.payload.excType : ""));
			expect(types).toEqual([
				FAILURE_TYPES.structuredFallback,
				FAILURE_TYPES.budgetExhausted,
			]);
			expect(llmStage.every((e) => e.provenance === "llm")).toBe(true);
			if (llmStage[0]?.kind === "failure") expect(llmStage[0].payload.retryable).toBe(true);
			if (llmStage[1]?.kind === "failure") expect(llmStage[1].payload.retryable).toBe(false);
			const modes = log
				.query({ kind: ["llm_call"] })
				.map((e) => (e.kind === "llm_call" ? structuredOf(e.payload.params) : undefined));
			expect(modes).toEqual(["prompt", "prompt", "prompt"]);
			log.close();
			const lines = readLog(out);
			expect(
				lines.filter((l) => l.msg === "structured output fallback").map((l) => l.level),
			).toEqual(["error"]);
			expect(
				lines.some(
					(l) => l.level === "error" && JSON.stringify(l.data).includes('"stage":"llm"'),
				),
			).toBe(true);
		} finally {
			server.stop(true);
		}
	});
});

describe("llmOverride", () => {
	test("withLlmOverride shallow-merges into scenario.llm and keeps the source intact", () => {
		const s = kernelScenario();
		const budget = { maxCalls: 3, maxCompletionTokens: 50 };
		const merged = withLlmOverride(s, { mode: "replay", budget });
		expect(merged.llm).toEqual({ ...s.llm, mode: "replay", budget });
		expect(s.llm.mode).toBe("live");
		expect(merged.steps).toBe(s.steps);
	});

	test("runScenario applies llmOverride before writing scenario.json", async () => {
		const out = tempDir();
		const r = await runScenario(kernelScenario(), kernelRegistry().registry, out, {
			createGateway: gatewayFactory,
			llmOverride: { mode: "replay", concurrency: { initial: 1, max: 2 } },
		});
		expect(r.ok && r.value.status).toBe("succeeded");
		const written = readRunScenario(out);
		expect(written.ok).toBe(true);
		if (!written.ok) return;
		expect(written.value.llm.mode).toBe("replay");
		expect(written.value.llm.concurrency).toEqual({ initial: 1, max: 2 });
		expect(written.value.llm.budget).toEqual(kernelScenario().llm.budget);
	});
});
