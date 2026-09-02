import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashOf } from "../../src/core/hash";
import type { LLMFailure, LLMRequest } from "../../src/core/protocols";
import { LLMSpecSchema } from "../../src/core/schema";
import type { JsonObject, LLMSpec } from "../../src/core/types";
import { FAILURE_TYPES } from "../../src/core/failures";
import { createGateway } from "../../src/llm/gateway";
import { deepseek, lmStudio, mlxLm } from "../../src/llm/presets";
import { extractLastJsonBlock } from "../../src/llm/structured";
import { createLogger, silentLogger } from "../../src/logging/logger";
import { formatJsonl, memorySink } from "../../src/logging/sinks";

process.env.NO_PROXY ??= "127.0.0.1,localhost";

type Seen = { readonly body: JsonObject; readonly headers: Headers };
type Reply = { readonly status: number; readonly body?: unknown; readonly delayMs?: number };
type Script = (seen: Seen, n: number) => Reply;

const completion = (text: string, usage?: JsonObject): unknown => ({
	model: "fake-model",
	choices: [{ message: { role: "assistant", content: text } }],
	usage: usage ?? {
		prompt_tokens: 10,
		completion_tokens: 5,
		prompt_tokens_details: { cached_tokens: 3 },
	},
});

const fakeEndpoint = (script: Script) => {
	let calls = 0;
	let inFlight = 0;
	let maxInFlight = 0;
	const seen: Seen[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			calls += 1;
			const n = calls;
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				const body = (await req.json()) as JsonObject;
				const entry = { body, headers: req.headers };
				seen.push(entry);
				const reply = script(entry, n);
				if (reply.delayMs !== undefined) await Bun.sleep(reply.delayMs);
				return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
					status: reply.status,
					headers: { "content-type": "application/json" },
				});
			} finally {
				inFlight -= 1;
			}
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		seen,
		get calls() {
			return calls;
		},
		get maxInFlight() {
			return maxInFlight;
		},
		stop: () => server.stop(true),
	};
};

const servers: { stop: () => void }[] = [];
const endpoint = (script: Script) => {
	const s = fakeEndpoint(script);
	servers.push(s);
	return s;
};
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
});

const spec = (baseUrl: string, extra: Record<string, unknown> = {}): LLMSpec =>
	LLMSpecSchema.parse({
		baseUrl,
		model: "test-model",
		apiKeyEnv: "SIMULACRA_TEST_KEY",
		concurrency: { initial: 2, max: 4 },
		timeoutMs: 5000,
		...extra,
	});

const request = (system: string, user: string, extra: Partial<LLMRequest> = {}): LLMRequest => ({
	messages: [
		{ role: "system", content: system },
		{ role: "user", content: user },
	],
	temperature: 0,
	maxTokens: 100,
	tags: { purpose: "decision", eventId: "E1" },
	homogeneousGuard: false,
	...extra,
});

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-gw-"));

const systemOf = (seen: Seen): string => {
	const messages = seen.body.messages;
	if (!Array.isArray(messages)) return "";
	const first = messages[0];
	return typeof first === "object" && first !== null && "content" in first
		? String(first.content)
		: "";
};

describe("extractLastJsonBlock", () => {
	test("takes the last balanced object, tolerating fences, prose and braces in strings", () => {
		expect(extractLastJsonBlock('Sure: {"a": 1} then ```json\n{"b": {"c": "}"}}\n```').ok).toBe(
			true,
		);
		const r = extractLastJsonBlock('{"a": 1} text {"action": "post", "args": {"x": "{y}"}}');
		expect(r).toEqual({ ok: true, value: { action: "post", args: { x: "{y}" } } });
		expect(extractLastJsonBlock("no json here").ok).toBe(false);
		expect(extractLastJsonBlock('{"a": 1} {broken').ok).toBe(true);
		expect(extractLastJsonBlock("{not: valid}").ok).toBe(false);
	});
});

describe("gateway retries and backoff", () => {
	test("429 backs off and retries at most three times", async () => {
		const ep = endpoint((_, n) =>
			n < 4 ? { status: 429 } : { status: 200, body: completion("ok") },
		);
		const gw = createGateway(spec(ep.baseUrl), { logger: silentLogger, backoffBaseMs: 1 });
		const r = await gw.complete(request("s", "u"));
		expect(r.ok).toBe(true);
		expect(ep.calls).toBe(4);

		const always = endpoint(() => ({ status: 429, body: { error: "slow down" } }));
		const gw2 = createGateway(spec(always.baseUrl), { logger: silentLogger, backoffBaseMs: 1 });
		const failed = await gw2.complete(request("s", "u"));
		expect(failed.ok).toBe(false);
		if (!failed.ok) {
			expect(failed.error.excType).toBe(FAILURE_TYPES.rateLimited);
			expect(failed.error.retryable).toBe(true);
			expect(failed.error.attempts).toBe(4);
		}
		expect(always.calls).toBe(4);
		expect(gw2.failures()).toBe(1);
	});

	test("5xx retries the same way, other 4xx does not retry", async () => {
		const five = endpoint(() => ({ status: 503 }));
		const gw = createGateway(spec(five.baseUrl), { logger: silentLogger, backoffBaseMs: 1 });
		const r = await gw.complete(request("s", "u"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.excType).toBe(FAILURE_TYPES.serverError);
		expect(five.calls).toBe(4);

		const four = endpoint(() => ({ status: 400, body: { error: "bad" } }));
		const gw2 = createGateway(spec(four.baseUrl), { logger: silentLogger, backoffBaseMs: 1 });
		const r2 = await gw2.complete(request("s", "u"));
		expect(r2.ok).toBe(false);
		if (!r2.ok) {
			expect(r2.error.excType).toBe(FAILURE_TYPES.clientError);
			expect(r2.error.retryable).toBe(false);
			expect(r2.error.attempts).toBe(1);
		}
		expect(four.calls).toBe(1);
	});

	test("timeouts are retried and halve the concurrency limit", async () => {
		const slow = endpoint(() => ({ status: 200, body: completion("late"), delayMs: 300 }));
		const gw = createGateway(
			spec(slow.baseUrl, { timeoutMs: 20, concurrency: { initial: 4, max: 4 } }),
			{
				logger: silentLogger,
				backoffBaseMs: 1,
			},
		);
		const r = await gw.complete(request("s", "u"));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.excType).toBe(FAILURE_TYPES.timeout);
			expect(r.error.retryable).toBe(true);
		}
		expect(gw.concurrencyLimit()).toBe(1);
	});
});

describe("gateway concurrency", () => {
	test("in-flight requests never exceed the limit and 429 halves it", async () => {
		const ep = endpoint((_, n) =>
			n === 7 ? { status: 429 } : { status: 200, body: completion("ok"), delayMs: 10 },
		);
		const gw = createGateway(spec(ep.baseUrl, { concurrency: { initial: 4, max: 4 } }), {
			logger: silentLogger,
			backoffBaseMs: 1,
		});
		const reqs = Array.from({ length: 12 }, (_, i) => request("s", `u${i}`));
		const results = await gw.completeMany(reqs);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(ep.maxInFlight).toBeLessThanOrEqual(4);
		expect(gw.concurrencyLimit()).toBe(2);
	});

	test("twenty consecutive successes raise the limit by one up to max", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("ok") }));
		const gw = createGateway(spec(ep.baseUrl, { concurrency: { initial: 2, max: 3 } }), {
			logger: silentLogger,
		});
		for (let i = 0; i < 19; i += 1) await gw.complete(request("s", `u${i}`));
		expect(gw.concurrencyLimit()).toBe(2);
		await gw.complete(request("s", "u19"));
		expect(gw.concurrencyLimit()).toBe(3);
		for (let i = 0; i < 20; i += 1) await gw.complete(request("s", `v${i}`));
		expect(gw.concurrencyLimit()).toBe(3);
	});

	test("completeMany sorts by system prefix on the wire but returns input order", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("ok"), delayMs: 5 }));
		const gw = createGateway(spec(ep.baseUrl, { concurrency: { initial: 1, max: 1 } }), {
			logger: silentLogger,
		});
		const reqs = [
			request("zeta", "0"),
			request("alpha", "1"),
			request("zeta", "2"),
			request("beta", "3"),
		];
		const results = await gw.completeMany(reqs);
		expect(results.map((r) => (r.ok ? r.value.promptHash : ""))).toEqual(
			reqs.map((r) => hashOf(r.messages)),
		);
		expect(ep.seen.map(systemOf)).toEqual(["alpha", "beta", "zeta", "zeta"]);
	});
});

describe("gateway structured output", () => {
	const schema = { type: "object", properties: { action: { type: "string" } } };

	test("json_schema rejected with 400 falls back to prompt mode once", async () => {
		const ep = endpoint((seen) =>
			"response_format" in seen.body
				? { status: 400, body: { error: "response_format unsupported" } }
				: { status: 200, body: completion('thinking... {"action": "post"}') },
		);
		const failures: LLMFailure[] = [];
		const gw = createGateway(spec(ep.baseUrl), {
			logger: silentLogger,
			backoffBaseMs: 1,
			onFailure: (f) => failures.push(f),
		});
		const first = await gw.complete(request("s", "u", { schema }));
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.value.parsed).toEqual({ action: "post" });
		expect(failures).toHaveLength(1);
		expect(failures[0]?.excType).toBe(FAILURE_TYPES.structuredFallback);
		expect(failures[0]?.retryable).toBe(true);
		expect(ep.calls).toBe(2);
		expect("response_format" in (ep.seen[0]?.body ?? {})).toBe(true);
		expect("response_format" in (ep.seen[1]?.body ?? {})).toBe(false);
		expect(systemOf(ep.seen[1] as Seen)).toContain("JSON schema");

		const second = await gw.complete(request("s", "u2", { schema }));
		expect(second.ok).toBe(true);
		expect(ep.calls).toBe(3);
		expect("response_format" in (ep.seen[2]?.body ?? {})).toBe(false);
		expect(failures).toHaveLength(1);
	});

	test("forced json_schema does not fall back, forced prompt never sends response_format", async () => {
		const ep = endpoint((seen) =>
			"response_format" in seen.body
				? { status: 400, body: { error: "no" } }
				: { status: 200, body: completion('{"action": "x"}') },
		);
		const forced = createGateway(spec(ep.baseUrl, { structured: "json_schema" }), {
			logger: silentLogger,
			backoffBaseMs: 1,
		});
		const r = await forced.complete(request("s", "u", { schema }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.excType).toBe(FAILURE_TYPES.clientError);

		const prompt = createGateway(spec(ep.baseUrl, { structured: "prompt" }), {
			logger: silentLogger,
		});
		const r2 = await prompt.complete(request("s", "u", { schema }));
		expect(r2.ok).toBe(true);
		const strict = ep.seen[0]?.body.response_format;
		expect(strict).toEqual({
			type: "json_schema",
			json_schema: { name: "decision", schema, strict: true },
		});
		expect("response_format" in (ep.seen[1]?.body ?? {})).toBe(false);
	});

	test("unparseable text leaves parsed undefined without failing the call", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("I refuse") }));
		const gw = createGateway(spec(ep.baseUrl, { structured: "prompt" }), {
			logger: silentLogger,
		});
		const r = await gw.complete(request("s", "u", { schema }));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.parsed).toBeUndefined();
			expect(r.value.text).toBe("I refuse");
		}
	});
});

describe("gateway record and replay", () => {
	test("record writes a file, replay serves it without touching the network", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion('{"action": "wave"}') }));
		const recordDir = tempDir();
		const recorder = createGateway(spec(ep.baseUrl, { mode: "record", recordDir }), {
			logger: silentLogger,
		});
		const req = request("s", "u", { seed: 7, schema: { type: "object" } });
		const live = await recorder.complete(req);
		expect(live.ok).toBe(true);
		if (live.ok) expect(live.value.recorded).toBe(false);
		expect(readdirSync(recordDir)).toHaveLength(1);
		const callsAfterRecord = ep.calls;

		const replayer = createGateway(spec(ep.baseUrl, { mode: "replay", recordDir }), {
			logger: silentLogger,
		});
		const replayed = await replayer.complete(req);
		expect(replayed.ok).toBe(true);
		if (replayed.ok && live.ok) {
			expect(replayed.value.recorded).toBe(true);
			expect(replayed.value.text).toBe(live.value.text);
			expect(replayed.value.parsed).toEqual({ action: "wave" });
			expect(replayed.value.responseSha).toBe(live.value.responseSha);
			expect(replayed.value.promptHash).toBe(live.value.promptHash);
			expect(replayed.value.latencyMs).toBe(live.value.latencyMs);
		}
		expect(ep.calls).toBe(callsAfterRecord);
		expect(replayer.ledger().llmCalls).toBe(0);

		const miss = await replayer.complete(request("s", "other", { seed: 7 }));
		expect(miss.ok).toBe(false);
		if (!miss.ok) {
			expect(miss.error.excType).toBe(FAILURE_TYPES.replayMiss);
			expect(miss.error.retryable).toBe(false);
		}
		expect(ep.calls).toBe(callsAfterRecord);
	});

	test("live mode neither reads nor writes recordings", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("ok") }));
		const recordDir = tempDir();
		const gw = createGateway(spec(ep.baseUrl, { mode: "live", recordDir }), {
			logger: silentLogger,
		});
		await gw.complete(request("s", "u"));
		expect(existsSync(recordDir) ? readdirSync(recordDir) : []).toHaveLength(0);
	});

	test("record and replay modes require a recordDir", () => {
		expect(() =>
			createGateway(spec("http://127.0.0.1:1/v1", { mode: "replay" }), {
				logger: silentLogger,
			}),
		).toThrow(TypeError);
	});
});

describe("gateway budget, nonce, circuit and ledger", () => {
	test("budget.maxCalls stops further calls and maxCompletionTokens caps max_tokens", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("ok") }));
		const gw = createGateway(
			spec(ep.baseUrl, { budget: { maxCalls: 2, maxCompletionTokens: 32 } }),
			{ logger: silentLogger },
		);
		expect((await gw.complete(request("s", "1"))).ok).toBe(true);
		expect((await gw.complete(request("s", "2"))).ok).toBe(true);
		const third = await gw.complete(request("s", "3"));
		expect(third.ok).toBe(false);
		if (!third.ok) {
			expect(third.error.excType).toBe(FAILURE_TYPES.budgetExhausted);
			expect(third.error.retryable).toBe(false);
		}
		expect(ep.calls).toBe(2);
		expect(ep.seen[0]?.body.max_tokens).toBe(32);
	});

	test("replay hits consume neither budget nor ledger", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion('{"action": "wave"}') }));
		const recordDir = tempDir();
		const recorder = createGateway(spec(ep.baseUrl, { mode: "record", recordDir }), {
			logger: silentLogger,
		});
		const req = request("s", "u", { seed: 1, schema: { type: "object" } });
		expect((await recorder.complete(req)).ok).toBe(true);
		const failures: LLMFailure[] = [];
		const replayer = createGateway(
			spec(ep.baseUrl, {
				mode: "replay",
				recordDir,
				budget: { maxCalls: 5, maxCompletionTokens: 100 },
			}),
			{ logger: silentLogger, onFailure: (f) => failures.push(f) },
		);
		const results = await replayer.completeMany(Array.from({ length: 100 }, () => req));
		expect(results.every((r) => r.ok && r.value.recorded)).toBe(true);
		expect(results.every((r) => r.ok && r.value.structured === "json_schema")).toBe(true);
		expect(replayer.ledger().llmCalls).toBe(0);
		expect(replayer.ledger().promptTokens).toBe(0);
		expect(replayer.callsStarted()).toBe(0);
		expect(failures).toHaveLength(0);
		expect(ep.calls).toBe(1);
	});

	test("circuit-open and budget refusals do not consume the budget", async () => {
		const ep = endpoint(() => ({ status: 400, body: { error: "nope" } }));
		const failures: LLMFailure[] = [];
		const gw = createGateway(
			spec(ep.baseUrl, {
				concurrency: { initial: 1, max: 1 },
				budget: { maxCalls: 12, maxCompletionTokens: 100 },
			}),
			{ logger: silentLogger, backoffBaseMs: 1, onFailure: (f) => failures.push(f) },
		);
		const batch = await gw.completeMany(
			Array.from({ length: 14 }, (_, i) => request("s", `u${i}`)),
		);
		expect(
			batch.filter((r) => !r.ok && r.error.excType === FAILURE_TYPES.circuitOpen),
		).toHaveLength(4);
		expect(gw.callsStarted()).toBe(10);
		expect(ep.calls).toBe(10);
		expect(failures).toHaveLength(14);
		const later = await gw.completeMany([
			request("s", "a"),
			request("s", "b"),
			request("s", "c"),
		]);
		expect(later.map((r) => (r.ok ? "ok" : r.error.excType))).toEqual([
			FAILURE_TYPES.clientError,
			FAILURE_TYPES.clientError,
			FAILURE_TYPES.budgetExhausted,
		]);
		expect(gw.callsStarted()).toBe(12);
		expect(ep.calls).toBe(12);
		expect(failures.filter((f) => f.excType === FAILURE_TYPES.budgetExhausted)).toHaveLength(1);
		expect(gw.failures()).toBe(17);
	});

	test("every final failure and the structured fallback reach onFailure, the fallback logs at error", async () => {
		const ep = endpoint((seen) =>
			"response_format" in seen.body
				? { status: 400, body: { error: "no schema" } }
				: JSON.stringify(seen.body.messages).includes('"content":"u"')
					? { status: 503 }
					: { status: 200, body: completion('{"action": "x"}') },
		);
		const failures: LLMFailure[] = [];
		const sink = memorySink();
		const gw = createGateway(spec(ep.baseUrl), {
			logger: createLogger({ level: "debug", sinks: [sink] }),
			backoffBaseMs: 1,
			onFailure: (f) => failures.push(f),
		});
		const first = await gw.complete(request("s", "u", { schema: { type: "object" } }));
		expect(first.ok).toBe(false);
		if (!first.ok) expect(first.error.excType).toBe(FAILURE_TYPES.serverError);
		expect(failures.map((f) => f.excType)).toEqual([
			FAILURE_TYPES.structuredFallback,
			FAILURE_TYPES.serverError,
		]);
		expect(failures[1]?.retryable).toBe(true);
		expect(
			sink.records.filter((r) => r.msg === "structured output fallback").map((r) => r.level),
		).toEqual(["error"]);
		const second = await gw.complete(request("s", "v", { schema: { type: "object" } }));
		expect(second.ok && second.value.structured).toBe("prompt");
		const plain = await gw.complete(request("s", "w"));
		expect(plain.ok && plain.value.structured).toBeUndefined();
	});

	test("homogeneousGuard appends a nonce to system without changing promptHash", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("ok") }));
		const gw = createGateway(spec(ep.baseUrl), { logger: silentLogger });
		const a = await gw.complete(
			request("sys", "u", { homogeneousGuard: true, tags: { eventId: "EV-A" } }),
		);
		const b = await gw.complete(
			request("sys", "u", { homogeneousGuard: true, tags: { requestId: "RQ-B" } }),
		);
		expect(a.ok && b.ok && a.value.promptHash === b.value.promptHash).toBe(true);
		expect(systemOf(ep.seen[0] as Seen)).toBe("sys\n<!-- nonce:EV-A -->");
		expect(systemOf(ep.seen[1] as Seen)).toBe("sys\n<!-- nonce:RQ-B -->");
	});

	test("seed is sent unless the spec disables it", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("ok") }));
		const withSeed = createGateway(spec(ep.baseUrl), { logger: silentLogger });
		await withSeed.complete(request("s", "u", { seed: 42 }));
		expect(ep.seen[0]?.body.seed).toBe(42);
		const noSeed = createGateway(spec(ep.baseUrl, { sendSeed: false }), {
			logger: silentLogger,
		});
		await noSeed.complete(request("s", "u", { seed: 42 }));
		expect("seed" in (ep.seen[1]?.body ?? {})).toBe(false);
	});

	test("ten consecutive failures open the circuit for the rest of the batch", async () => {
		const ep = endpoint(() => ({ status: 400, body: { error: "nope" } }));
		const gw = createGateway(spec(ep.baseUrl, { concurrency: { initial: 1, max: 1 } }), {
			logger: silentLogger,
			backoffBaseMs: 1,
		});
		const results = await gw.completeMany(
			Array.from({ length: 14 }, (_, i) => request("s", `u${i}`)),
		);
		const types = results.map((r) => (r.ok ? "ok" : r.error.excType));
		expect(types.filter((t) => t === FAILURE_TYPES.clientError)).toHaveLength(10);
		expect(types.filter((t) => t === FAILURE_TYPES.circuitOpen)).toHaveLength(4);
		expect(ep.calls).toBe(10);
		const next = await gw.completeMany([request("s", "fresh")]);
		expect(next[0]?.ok).toBe(false);
		if (next[0] !== undefined && !next[0].ok)
			expect(next[0].error.excType).toBe(FAILURE_TYPES.clientError);
	});

	test("ledger totals and per-purpose buckets", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("ok") }));
		const gw = createGateway(spec(ep.baseUrl), { logger: silentLogger });
		await gw.completeMany([
			request("s", "1", { tags: { purpose: "decision" } }),
			request("s", "2", { tags: { purpose: "decision" } }),
			request("s", "3", { tags: { purpose: "memory_summary" } }),
			request("s", "4", { tags: {} }),
		]);
		const total = gw.ledger();
		expect(total.llmCalls).toBe(4);
		expect(total.promptTokens).toBe(40);
		expect(total.completionTokens).toBe(20);
		expect(total.cachedTokens).toBe(12);
		expect(total.wallMs).toBeGreaterThan(0);
		const buckets = gw.ledgerByPurpose();
		expect(buckets.decision?.llmCalls).toBe(2);
		expect(buckets.memory_summary?.llmCalls).toBe(1);
		expect(buckets.unknown?.llmCalls).toBe(1);
	});

	test("sends a Bearer header and never logs the key", async () => {
		process.env.SIMULACRA_TEST_KEY = "sk-super-secret";
		const ep = endpoint(() => ({ status: 200, body: completion("ok") }));
		const sink = memorySink();
		const logger = createLogger({ level: "trace", sinks: [sink] });
		const gw = createGateway(spec(ep.baseUrl), { logger });
		const r = await gw.complete(request("s", "u"));
		expect(r.ok).toBe(true);
		expect(ep.seen[0]?.headers.get("authorization")).toBe("Bearer sk-super-secret");
		expect(sink.records.length).toBeGreaterThan(0);
		for (const record of sink.records)
			expect(formatJsonl(record)).not.toContain("sk-super-secret");
		const debug = sink.records.find((x) => x.level === "debug" && x.msg === "llm call");
		expect(debug?.data?.promptHash).toBe(hashOf(request("s", "u").messages));
		expect(debug?.data?.model).toBe("fake-model");
		expect(typeof debug?.data?.latencyMs).toBe("number");
		delete process.env.SIMULACRA_TEST_KEY;
	});

	test("malformed completion bodies are non-retryable failures", async () => {
		const ep = endpoint(() => ({ status: 200, body: { choices: [] } }));
		const gw = createGateway(spec(ep.baseUrl), { logger: silentLogger });
		const r = await gw.complete(request("s", "u"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.excType).toBe(FAILURE_TYPES.malformed);
		expect(ep.calls).toBe(1);
	});
});

describe("presets", () => {
	test("return complete specs with schema defaults", () => {
		const ds = deepseek();
		expect(ds.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(ds.model).toBe("deepseek-v4-flash");
		expect(ds.apiKeyEnv).toBe("SIMULACRA_LLM_API_KEY");
		expect(ds.sendSeed).toBe(true);
		expect(ds.extra).toEqual({ thinking: { type: "disabled" } });
		const mlx = mlxLm("http://127.0.0.1:8080/v1");
		expect(mlx.sendSeed).toBe(false);
		expect(mlx.extra).toBeUndefined();
		expect(mlx.concurrency).toEqual({ initial: 4, max: 8 });
		const lm = lmStudio("http://127.0.0.1:1234/v1");
		expect(lm.concurrency).toEqual({ initial: 4, max: 8 });
		expect(lm.structured).toBe("auto");
		for (const s of [ds, mlx, lm]) expect(LLMSpecSchema.safeParse(s).success).toBe(true);
	});
});

describe("gateway finish_reason and extra", () => {
	const reply = (
		message: { content?: string | null; reasoning_content?: string },
		finish_reason: string,
		completion_tokens = 20,
	): Reply => ({
		status: 200,
		body: {
			model: "fake-model",
			choices: [{ message, finish_reason }],
			usage: { prompt_tokens: 10, completion_tokens },
		},
	});

	test("empty content with finish_reason=length fails as truncated without a retry", async () => {
		const ep = endpoint(() => reply({ content: "" }, "length", 100));
		const failures: LLMFailure[] = [];
		const gw = createGateway(spec(ep.baseUrl), {
			logger: silentLogger,
			backoffBaseMs: 1,
			onFailure: (f) => failures.push(f),
		});
		const r = await gw.complete(request("s", "u", { schema: { type: "object" } }));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.excType).toBe(FAILURE_TYPES.truncated);
			expect(r.error.retryable).toBe(false);
			expect(r.error.message).toContain("100 completion tokens");
		}
		expect(ep.calls).toBe(1);
		expect(failures.map((f) => f.excType)).toEqual([FAILURE_TYPES.truncated]);
		expect(gw.failures()).toBe(1);
		expect(gw.ledger().llmCalls).toBe(0);
	});

	test("empty content beside reasoning_content fails as empty_content", async () => {
		const ep = endpoint(() =>
			reply({ content: null, reasoning_content: "let me think about this" }, "stop"),
		);
		const failures: LLMFailure[] = [];
		const gw = createGateway(spec(ep.baseUrl), {
			logger: silentLogger,
			onFailure: (f) => failures.push(f),
		});
		const r = await gw.complete(request("s", "u"));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.excType).toBe(FAILURE_TYPES.emptyContent);
			expect(r.error.retryable).toBe(false);
		}
		expect(ep.calls).toBe(1);
		expect(failures.map((f) => f.excType)).toEqual([FAILURE_TYPES.emptyContent]);
	});

	test("non-empty content keeps finish_reason on the response; blank content without reasoning stays a response", async () => {
		const cut = endpoint(() => reply({ content: '{"action": "wa' }, "length"));
		const r = await createGateway(spec(cut.baseUrl), { logger: silentLogger }).complete(
			request("s", "u", { schema: { type: "object" } }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.finishReason).toBe("length");
			expect(r.value.parsed).toBeUndefined();
		}
		const blank = endpoint(() => reply({ content: "  " }, "stop"));
		const b = await createGateway(spec(blank.baseUrl), { logger: silentLogger }).complete(
			request("s", "u"),
		);
		expect(b.ok).toBe(true);
		if (b.ok) {
			expect(b.value.text).toBe("  ");
			expect(b.value.finishReason).toBe("stop");
		}
		const missing = endpoint(() => ({ status: 200, body: completion("ok") }));
		const m = await createGateway(spec(missing.baseUrl), { logger: silentLogger }).complete(
			request("s", "u"),
		);
		expect(m.ok && m.value.finishReason).toBeUndefined();
	});

	test("extra is merged into the request body without overriding the gateway's own fields", async () => {
		const ep = endpoint(() => ({ status: 200, body: completion("ok") }));
		const gw = createGateway(
			spec(ep.baseUrl, {
				extra: {
					thinking: { type: "disabled" },
					top_p: 0.5,
					model: "evil",
					messages: [],
					max_tokens: 1,
					temperature: 9,
					seed: 99,
					response_format: "text",
				},
			}),
			{ logger: silentLogger },
		);
		const r = await gw.complete(request("s", "u", { seed: 7, schema: { type: "object" } }));
		expect(r.ok).toBe(true);
		const body = ep.seen[0]?.body ?? {};
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.top_p).toBe(0.5);
		expect(body.model).toBe("test-model");
		expect(body.max_tokens).toBe(100);
		expect(body.temperature).toBe(0);
		expect(body.seed).toBe(7);
		expect(Array.isArray(body.messages) && body.messages.length).toBe(2);
		expect(typeof body.response_format === "object" && body.response_format !== null).toBe(
			true,
		);
		const plain = endpoint(() => ({ status: 200, body: completion("ok") }));
		await createGateway(spec(plain.baseUrl), { logger: silentLogger }).complete(
			request("s", "u"),
		);
		expect("thinking" in (plain.seen[0]?.body ?? {})).toBe(false);
	});

	test("extra enters the recording key; finish_reason is recorded and replayed", async () => {
		const ep = endpoint(() => reply({ content: '{"action": "wave"}' }, "stop"));
		const recordDir = tempDir();
		const req = request("s", "u", { seed: 7, schema: { type: "object" } });
		const extra = { thinking: { type: "disabled" } };
		const plain = createGateway(spec(ep.baseUrl, { mode: "record", recordDir }), {
			logger: silentLogger,
		});
		const disabled = createGateway(spec(ep.baseUrl, { mode: "record", recordDir, extra }), {
			logger: silentLogger,
		});
		expect((await plain.complete(req)).ok).toBe(true);
		expect((await disabled.complete(req)).ok).toBe(true);
		expect(readdirSync(recordDir)).toHaveLength(2);
		expect(ep.calls).toBe(2);
		const replayer = createGateway(spec(ep.baseUrl, { mode: "replay", recordDir, extra }), {
			logger: silentLogger,
		});
		const replayed = await replayer.complete(req);
		expect(replayed.ok).toBe(true);
		if (replayed.ok) {
			expect(replayed.value.recorded).toBe(true);
			expect(replayed.value.finishReason).toBe("stop");
		}
		const other = createGateway(
			spec(ep.baseUrl, {
				mode: "replay",
				recordDir,
				extra: { thinking: { type: "enabled" } },
			}),
			{ logger: silentLogger },
		);
		const miss = await other.complete(req);
		expect(miss.ok).toBe(false);
		if (!miss.ok) expect(miss.error.excType).toBe(FAILURE_TYPES.replayMiss);
		expect(ep.calls).toBe(2);
		const files = readdirSync(recordDir).map(
			(f) =>
				JSON.parse(readFileSync(join(recordDir, f), "utf8")) as {
					request: { extra?: unknown };
					response: { finishReason?: string };
				},
		);
		expect(files.map((f) => f.response.finishReason)).toEqual(["stop", "stop"]);
		expect(files.filter((f) => f.request.extra !== undefined)).toHaveLength(1);
	});
});
