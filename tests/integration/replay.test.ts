import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	LLM_BENCH_CASES,
	benchLlmOverride,
	benchScenario,
	type LlmBenchCase,
} from "../../bench/llm";
import { EXAMPLES_DIR, digest, ok, runScenario, withRunLog } from "../../src/index";

const ROOT = join(import.meta.dir, "../..");
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-replay-"));

const RecordedModel = z.object({ request: z.object({ model: z.string() }) });

const recordingsOf = (c: LlmBenchCase): readonly string[] => {
	const dir = join(EXAMPLES_DIR, c.example, "recordings");
	return existsSync(dir)
		? readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.sort()
				.map((f) => join(dir, f))
		: [];
};

const recordedModel = (file: string): string =>
	RecordedModel.parse(JSON.parse(readFileSync(file, "utf8"))).request.model;

describe("replay from the committed recordings", () => {
	for (const c of LLM_BENCH_CASES) {
		const files = recordingsOf(c);
		const title = `${c.example}: two replay runs share a digest and make no live calls`;
		if (files.length === 0) {
			test.skip(`${title} (skipped: examples/${c.example}/recordings is missing or empty; run bench/llm.ts to record)`, () => {});
			continue;
		}
		test(
			title,
			async () => {
				const scenario = benchScenario(ROOT, c);
				expect(scenario.ok).toBe(true);
				if (!scenario.ok) return;
				const first = files[0];
				if (first === undefined) return;
				const llmOverride = benchLlmOverride(c, scenario.value.llm, {
					mode: "replay",
					model: recordedModel(first),
				});
				const replay = async () => {
					const dir = tempDir();
					const r = await runScenario(scenario.value, dir, {
						ticksOverride: c.ticks,
						overwrite: true,
						logLevel: "warn",
						llmOverride,
					});
					if (!r.ok) throw new Error(`${r.error.excType}: ${r.error.message}`);
					const sha = digest(dir);
					const replayed = withRunLog(dir, (log) =>
						ok(
							log
								.query({ kind: ["llm_call"] })
								.filter((e) => e.kind === "llm_call" && e.payload.recorded).length,
						),
					);
					return {
						result: r.value,
						digest: sha.ok ? sha.value : "",
						replayed: replayed.ok ? replayed.value : -1,
					};
				};
				const a = await replay();
				const b = await replay();
				expect(a.result.status).toBe("succeeded");
				expect(a.result.integrity).toMatchObject({
					llmCalls: 0,
					llmFailures: 0,
					parseFailures: 0,
					complete: true,
				});
				expect(a.result.cost.llmCalls).toBe(0);
				expect(a.replayed).toBeGreaterThan(0);
				expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
				expect(a.digest).toBe(b.digest);
				expect(b.result.integrity).toEqual(a.result.integrity);
			},
			60000,
		);
	}
});
