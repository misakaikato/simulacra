import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse, stringify } from "yaml";
import {
	LLM_BENCH_CASES,
	MAX_COMPLETION_TOKENS,
	MAX_TOTAL_CALLS,
	benchLlmOverride,
	benchScenario,
	runBench,
} from "../../bench/llm";
import { DEEPSEEK_EXTRA, EXAMPLES_DIR, digest, runScenario } from "../../src/index";

process.env.NO_PROXY ??= "127.0.0.1,localhost";

const ROOT = join(import.meta.dir, "../..");
const RECORDINGS = "recordings";
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-bench-llm-"));

const jsonFiles = (dir: string): readonly string[] =>
	existsSync(dir)
		? readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.sort()
		: [];

const committedRecordings = (): readonly (readonly string[])[] =>
	LLM_BENCH_CASES.map((c) => jsonFiles(join(EXAMPLES_DIR, c.example, RECORDINGS)));

// A copy of the examples without recordings; the prisoners_dilemma plugin keeps pointing at the
// real rules.ts so that its own relative imports still resolve
const exampleCopy = (): string => {
	const root = tempDir();
	cpSync(EXAMPLES_DIR, join(root, "examples"), {
		recursive: true,
		filter: (src) => basename(src) !== RECORDINGS,
	});
	const yamlPath = join(root, "examples", "prisoners_dilemma", "scenario.yaml");
	const doc = parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
	writeFileSync(
		yamlPath,
		stringify({ ...doc, plugins: [join(EXAMPLES_DIR, "prisoners_dilemma", "rules.ts")] }),
	);
	return root;
};

interface DecisionRequestBody {
	readonly max_tokens?: number;
	readonly response_format?: {
		readonly json_schema?: {
			readonly schema?: {
				readonly properties?: { readonly action?: { readonly enum?: readonly string[] } };
			};
		};
	};
}

const PREFERRED_ACTIONS = ["silent", "cooperate"];

const fakeEndpoint = () => {
	let calls = 0;
	let sawThinking = false;
	const maxTokens = new Set<number | undefined>();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			calls += 1;
			const body = (await req.json()) as DecisionRequestBody;
			sawThinking ||= "thinking" in body;
			maxTokens.add(body.max_tokens);
			const space = body.response_format?.json_schema?.schema?.properties?.action?.enum ?? [];
			const action = PREFERRED_ACTIONS.find((a) => space.includes(a)) ?? space[0] ?? "noop";
			return Response.json({
				model: "fake",
				choices: [
					{
						message: {
							content: JSON.stringify({ action, args: {}, rationale: "smoke" }),
						},
						finish_reason: "stop",
					},
				],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 12,
					prompt_tokens_details: { cached_tokens: calls > 1 ? 64 : 0 },
				},
			});
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		maxTokens,
		get calls() {
			return calls;
		},
		get sawThinking() {
			return sawThinking;
		},
		stop: () => server.stop(true),
	};
};

describe("bench/llm", () => {
	test("runBench records into <root>/examples/*/recordings, reports both scenarios within budget, and the recordings replay", async () => {
		const root = exampleCopy();
		const before = committedRecordings();
		const ep = fakeEndpoint();
		try {
			const out = join(root, "bench", "RESULTS.md");
			const report = await runBench({
				apiKeyEnv: "SIMULACRA_TEST_KEY",
				baseUrl: ep.baseUrl,
				model: "fake",
				root,
				out,
			});
			expect(report.ok).toBe(true);
			if (!report.ok) return;
			const { rows, totalCalls } = report.value;
			expect(rows.map((r) => r.name)).toEqual(["prisoners_dilemma", "echo_chamber"]);
			expect(report.value.out).toBe(out);
			for (const row of rows) {
				expect(row.status).toBe("succeeded");
				expect(row.complete).toBe(true);
				expect(row.llmFailures).toBe(0);
				expect(row.parseFailures).toBe(0);
				expect(row.truncated).toBe(0);
				expect(row.llmCalls).toBeGreaterThan(0);
				expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
				const recorded = jsonFiles(join(root, "examples", row.name, RECORDINGS));
				expect(recorded.length).toBeGreaterThan(0);
				expect(recorded.length).toBeLessThanOrEqual(row.llmCalls);
			}
			const [pd, echo] = rows;
			expect(pd).toMatchObject({ agents: 2, ticks: 5, llmCalls: 5 });
			expect(echo).toMatchObject({ agents: 20, ticks: 3 });
			expect(echo?.cachedTokens).toBeGreaterThan(0);
			expect(totalCalls).toBe(ep.calls);
			expect(totalCalls).toBeLessThanOrEqual(MAX_TOTAL_CALLS);
			expect(ep.sawThinking).toBe(true);
			expect([...ep.maxTokens]).toEqual([MAX_COMPLETION_TOKENS]);
			const md = readFileSync(out, "utf8");
			expect(md).toContain("## LLM");
			expect(md).toContain("- model: fake");
			expect(md).toContain("| truncated |");
			expect(md).toContain("| prisoners_dilemma | 2 | 5 | 5 |");
			expect(md).toContain(`| echo_chamber | 20 | 3 | ${echo?.llmCalls} |`);
			expect(md).toContain(`total llmCalls: ${totalCalls} (budget ${MAX_TOTAL_CALLS})`);
			expect(committedRecordings()).toEqual(before);

			const callsAfterBench = ep.calls;
			for (const c of LLM_BENCH_CASES) {
				const scenario = benchScenario(root, c);
				expect(scenario.ok).toBe(true);
				if (!scenario.ok) continue;
				const llmOverride = benchLlmOverride(c, scenario.value.llm, {
					mode: "replay",
					model: "fake",
				});
				const replay = async () => {
					const dir = tempDir();
					const r = await runScenario(scenario.value, dir, {
						ticksOverride: c.ticks,
						overwrite: true,
						logLevel: "warn",
						llmOverride,
					});
					if (!r.ok) throw new Error(r.error.message);
					const sha = digest(dir);
					return { result: r.value, digest: sha.ok ? sha.value : "" };
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
				expect(a.digest).toBe(b.digest);
			}
			expect(ep.calls).toBe(callsAfterBench);
		} finally {
			ep.stop();
		}
	}, 60000);

	test("benchLlmOverride carries the endpoint's extra and the bench budget", () => {
		const first = LLM_BENCH_CASES[0];
		expect(first).toBeDefined();
		if (first === undefined) return;
		const real = benchScenario(ROOT, first);
		expect(real.ok).toBe(true);
		if (!real.ok) return;
		const plain = benchLlmOverride(first, real.value.llm, { mode: "record" });
		expect(plain.extra).toBeUndefined();
		expect(plain.budget).toEqual({
			maxCalls: first.maxCalls,
			maxCompletionTokens: MAX_COMPLETION_TOKENS,
		});
		const withExtra = benchLlmOverride(first, real.value.llm, {
			mode: "replay",
			extra: DEEPSEEK_EXTRA,
		});
		expect(withExtra.extra).toEqual(DEEPSEEK_EXTRA);
		expect(withExtra.mode).toBe("replay");
	});

	test("benchScenario reports a missing example instead of parsing the path as YAML", () => {
		const first = LLM_BENCH_CASES[0];
		expect(first).toBeDefined();
		if (first === undefined) return;
		const missing = benchScenario(tempDir(), first);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain("file not found");
		const real = benchScenario(ROOT, first);
		expect(real.ok && real.value.llm.recordDir).toBe(
			join(EXAMPLES_DIR, "prisoners_dilemma", RECORDINGS),
		);
	});

	test("the script exits 1 with a message when SIMULACRA_LLM_API_KEY is missing", () => {
		const proc = Bun.spawnSync(["bun", join(ROOT, "bench", "llm.ts")], {
			cwd: ROOT,
			env: { ...process.env, SIMULACRA_LLM_API_KEY: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(proc.exitCode).toBe(1);
		expect(new TextDecoder().decode(proc.stderr).trim()).toBe(
			"error: SIMULACRA_LLM_API_KEY is not set",
		);
		expect(new TextDecoder().decode(proc.stdout)).toBe("");
	});
});
