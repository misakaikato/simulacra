import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, levelFromEnv } from "../../src/logging/logger";
import { formatPretty, jsonlSink, memorySink, prettySink } from "../../src/logging/sinks";

describe("Logger", () => {
	test("filters by level and merges child context", () => {
		const sink = memorySink();
		const root = createLogger({ level: "info", sinks: [sink], ctx: { runId: "r1" } });
		const tick = root.child({ tick: 3 });
		tick.debug("hidden");
		tick.info("visible", { n: 1 });
		tick.child({ component: "feed" }).error("boom");
		expect(sink.records.map((r) => r.msg)).toEqual(["visible", "boom"]);
		expect(sink.records[0]?.ctx).toEqual({ runId: "r1", tick: 3 });
		expect(sink.records[0]?.data).toEqual({ n: 1 });
		expect(sink.records[1]?.ctx).toEqual({ runId: "r1", tick: 3, component: "feed" });
		expect(sink.records[1]?.level).toBe("error");
	});

	test("span records start, end and duration, and rethrows failures", async () => {
		const sink = memorySink();
		const log = createLogger({ level: "debug", sinks: [sink] });
		const value = await log.span("work", async () => 42);
		expect(value).toBe(42);
		expect(sink.records.map((r) => r.data?.span)).toEqual(["start", "end"]);
		expect(typeof sink.records[1]?.data?.ms).toBe("number");
		await expect(
			log.span("fail", async () => {
				throw new Error("nope");
			}),
		).rejects.toThrow("nope");
		const last = sink.records.at(-1);
		expect(last?.level).toBe("error");
		expect(last?.data?.error).toBe("Error: nope");
	});

	test("levelFromEnv accepts known levels and falls back otherwise", () => {
		expect(levelFromEnv("debug")).toBe("debug");
		expect(levelFromEnv("loud")).toBe("info");
		expect(levelFromEnv(undefined, "warn")).toBe("warn");
	});
});

describe("sinks", () => {
	test("jsonlSink appends one JSON object per line with ctx flattened", () => {
		const dir = mkdtempSync(join(tmpdir(), "simulacra-log-"));
		const path = join(dir, "nested", "log.jsonl");
		const sink = jsonlSink(path);
		const log = createLogger({ level: "trace", sinks: [sink], ctx: { runId: "r" } });
		log.info("one");
		log.warn("two", { k: "v" });
		sink.close();
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!) as Record<string, unknown>;
		const second = JSON.parse(lines[1]!) as Record<string, unknown>;
		expect(first.level).toBe("info");
		expect(first.msg).toBe("one");
		expect(first.runId).toBe("r");
		expect(typeof first.ts).toBe("string");
		expect(second.data).toEqual({ k: "v" });
	});

	test("prettySink writes human-readable lines through a callback or a WritableStream", async () => {
		const lines: string[] = [];
		const viaCallback = prettySink((line) => lines.push(line));
		const log = createLogger({ level: "info", sinks: [viaCallback], ctx: { tick: 1 } });
		log.info("hello", { a: 1 });
		expect(lines[0]).toMatch(/INFO {2}\[tick=1\] hello \{"a":1\}$/);

		const chunks: string[] = [];
		const stream = new WritableStream<string>({
			write(chunk) {
				chunks.push(chunk);
			},
		});
		const viaStream = prettySink(stream, { color: true });
		viaStream.write({ ts: "t", level: "warn", msg: "w", ctx: {} });
		viaStream.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(chunks[0]).toContain("WARN");
		expect(chunks[0]).toContain("[33m");
		expect(formatPretty({ ts: "t", level: "error", msg: "m", ctx: {} })).toBe("t ERROR m");
	});
});
