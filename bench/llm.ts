// Real-endpoint LLM bench: runs the prisoner's dilemma and a small echo chamber against the
// configured endpoint in record mode, refreshing the shipped recordings, and upserts cost,
// failure and truncation counts into bench/RESULTS.md. MAX_TOTAL_CALLS bounds the spend; the
// replay tests rebuild the same scenarios through benchScenario.
// 真实端点的 LLM 基准：以 record 模式对配置的端点跑囚徒困境与一个小回声室，刷新随包发布的录制，
// 并把成本、失败与截断计数 upsert 进 bench/RESULTS.md。MAX_TOTAL_CALLS 限制花费；
// 回放测试通过 benchScenario 重建同样的场景。

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	API_KEY_ENV,
	BASE_URL_ENV,
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	FAILURE_TYPES,
	MODEL_ENV,
	deepseek,
	digest,
	err,
	loadScenario,
	ok,
	overrideScenario,
	runScenario,
	withRunLog,
	type JsonValue,
	type LLMSpec,
	type Result,
	type RunResult,
	type Scenario,
} from "../src/index";
import { metaLines, writeSection } from "./results";

export const LLM_SECTION = "LLM";
export const MAX_TOTAL_CALLS = 150;
export const MAX_COMPLETION_TOKENS = 512;
export const CONCURRENCY_INITIAL = 4;

export interface LlmBenchCase {
	readonly example: string;
	readonly ticks: number;
	readonly maxCalls: number;
	readonly overrides: readonly (readonly [string, JsonValue])[];
}

export const LLM_BENCH_CASES: readonly LlmBenchCase[] = [
	{ example: "prisoners_dilemma", ticks: 5, maxCalls: 40, overrides: [] },
	{
		example: "echo_chamber",
		ticks: 3,
		maxCalls: 110,
		overrides: [
			["population.n", 20],
			["params.activation", 0.5],
		],
	},
];

export interface BenchEndpoint {
	readonly mode: LLMSpec["mode"];
	readonly apiKeyEnv?: string;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly extra?: LLMSpec["extra"];
}

export interface LlmBenchOptions {
	readonly apiKeyEnv: string;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly root: string;
	readonly out?: string;
}

export interface LlmBenchRow {
	readonly name: string;
	readonly agents: number;
	readonly ticks: number;
	readonly llmCalls: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
	readonly seconds: number;
	readonly status: RunResult["status"];
	readonly complete: boolean;
	readonly parseFailures: number;
	readonly llmFailures: number;
	readonly truncated: number;
	readonly rejectedActions: number;
	readonly digest: string;
}

export interface LlmBenchReport {
	readonly rows: readonly LlmBenchRow[];
	readonly totalCalls: number;
	readonly markdown: string;
	readonly out: string;
}

// The scenario exactly as the bench runs it; replay tests must build theirs through the same function
// 与基准实际运行的场景完全一致；回放测试必须经同一函数构造自己的场景
export const benchScenario = (root: string, c: LlmBenchCase): Result<Scenario, string> => {
	const path = join(root, "examples", c.example, "scenario.yaml");
	if (!existsSync(path)) return err(`${path}: file not found`);
	const loaded = loadScenario(path);
	if (!loaded.ok)
		return err(
			`${path}: ${loaded.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
		);
	let scenario = loaded.value;
	for (const [target, value] of c.overrides) {
		const overridden = overrideScenario(scenario, target, value);
		if (!overridden.ok) return err(`${path}: override ${target}: ${overridden.error.kind}`);
		scenario = overridden.value;
	}
	if (scenario.llm.recordDir === undefined) return err(`${path}: llm.recordDir is not declared`);
	return ok(scenario);
};

// Everything that enters the recording key besides the prompt: budget, model and mode
// 除提示词外进入录制键的一切：预算、模型与模式
export const benchLlmOverride = (
	c: LlmBenchCase,
	base: LLMSpec,
	endpoint: BenchEndpoint,
): Partial<LLMSpec> => ({
	mode: endpoint.mode,
	budget: { maxCalls: c.maxCalls, maxCompletionTokens: MAX_COMPLETION_TOKENS },
	concurrency: {
		initial: CONCURRENCY_INITIAL,
		max: Math.max(CONCURRENCY_INITIAL, base.concurrency.max),
	},
	...(endpoint.apiKeyEnv === undefined ? {} : { apiKeyEnv: endpoint.apiKeyEnv }),
	...(endpoint.baseUrl === undefined ? {} : { baseUrl: endpoint.baseUrl }),
	...(endpoint.model === undefined ? {} : { model: endpoint.model }),
	...(endpoint.extra === undefined ? {} : { extra: endpoint.extra }),
});

// Old recordings are deleted before recording so the shipped set is exactly what this bench
// produced, with no stale keys left over from earlier prompts.
// 录制前先删旧录制，随包发布的集合正好是本次基准产出的，不残留早先提示词的过期键。
const clearRecordings = (dir: string | undefined): void => {
	if (dir === undefined || !existsSync(dir)) return;
	for (const file of readdirSync(dir)) if (file.endsWith(".json")) rmSync(join(dir, file));
};

const benchOne = async (
	c: LlmBenchCase,
	scenario: Scenario,
	outDir: string,
	endpoint: BenchEndpoint,
): Promise<Result<LlmBenchRow, string>> => {
	const started = performance.now();
	const result = await runScenario(scenario, outDir, {
		ticksOverride: c.ticks,
		overwrite: true,
		logLevel: "warn",
		llmOverride: benchLlmOverride(c, scenario.llm, endpoint),
	});
	const seconds = (performance.now() - started) / 1000;
	if (!result.ok) return err(`${c.example}: ${result.error.excType}: ${result.error.message}`);
	const sha = digest(outDir);
	const truncated = withRunLog(outDir, (log) =>
		ok(
			log
				.query({ kind: ["failure"] })
				.filter(
					(e) =>
						e.kind === "failure" &&
						e.payload.stage === "llm" &&
						e.payload.excType === FAILURE_TYPES.truncated,
				).length,
		),
	);
	const { cost, integrity, status } = result.value;
	return ok({
		name: c.example,
		agents: scenario.population.n,
		ticks: c.ticks,
		llmCalls: cost.llmCalls,
		promptTokens: cost.promptTokens,
		completionTokens: cost.completionTokens,
		cachedTokens: cost.cachedTokens,
		seconds,
		status,
		complete: integrity.complete,
		parseFailures: integrity.parseFailures,
		llmFailures: integrity.llmFailures,
		truncated: truncated.ok ? truncated.value : -1,
		rejectedActions: integrity.rejectedActions,
		digest: sha.ok ? sha.value : "",
	});
};

const table = (rows: readonly LlmBenchRow[]): string =>
	[
		"| scenario | agents | ticks | llmCalls | promptTokens | completionTokens | cachedTokens | wall s | status | integrity.complete | parseFailures | llmFailures | truncated | rejectedActions | digest |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |",
		...rows.map(
			(r) =>
				`| ${r.name} | ${r.agents} | ${r.ticks} | ${r.llmCalls} | ${r.promptTokens} | ${r.completionTokens} | ${r.cachedTokens} | ${r.seconds.toFixed(1)} | ${r.status} | ${r.complete} | ${r.parseFailures} | ${r.llmFailures} | ${r.truncated} | ${r.rejectedActions} | ${r.digest.slice(0, 12)} |`,
		),
	].join("\n");

export const runBench = async (opts: LlmBenchOptions): Promise<Result<LlmBenchReport, string>> => {
	const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
	const model = opts.model ?? DEFAULT_MODEL;
	const preset = deepseek();
	// The DeepSeek preset's extra parameters apply only when the base URL is DeepSeek's; they
	// enter the recording key, so a replay must send the same ones.
	// DeepSeek 预设的 extra 参数只在 base URL 是 DeepSeek 时套用；它们进入录制键，回放必须发同样的参数。
	const endpoint: BenchEndpoint = {
		mode: "record",
		apiKeyEnv: opts.apiKeyEnv,
		baseUrl,
		model,
		...(baseUrl === preset.baseUrl && preset.extra !== undefined
			? { extra: preset.extra }
			: {}),
	};
	const out = opts.out ?? join(opts.root, "bench", "RESULTS.md");
	const runRoot = mkdtempSync(join(tmpdir(), "simulacra-bench-llm-"));
	try {
		const rows: LlmBenchRow[] = [];
		for (const c of LLM_BENCH_CASES) {
			const scenario = benchScenario(opts.root, c);
			if (!scenario.ok) return scenario;
			clearRecordings(scenario.value.llm.recordDir);
			const row = await benchOne(c, scenario.value, join(runRoot, c.example), endpoint);
			if (!row.ok) return row;
			rows.push(row.value);
		}
		const totalCalls = rows.reduce((sum, r) => sum + r.llmCalls, 0);
		const markdown = [
			...metaLines({ model, endpoint: baseUrl }),
			"",
			table(rows),
			"",
			`total llmCalls: ${totalCalls} (budget ${MAX_TOTAL_CALLS})`,
		].join("\n");
		writeSection(out, LLM_SECTION, markdown);
		return ok({ rows, totalCalls, markdown, out });
	} finally {
		rmSync(runRoot, { recursive: true, force: true });
	}
};

const envValue = (name: string): string | undefined => {
	const value = process.env[name];
	return value === undefined || value.length === 0 ? undefined : value;
};

const main = async (): Promise<number> => {
	process.env.NO_PROXY ??= "127.0.0.1,localhost";
	if (envValue(API_KEY_ENV) === undefined) {
		console.error(`error: ${API_KEY_ENV} is not set`);
		return 1;
	}
	const baseUrl = envValue(BASE_URL_ENV);
	const model = envValue(MODEL_ENV);
	const report = await runBench({
		apiKeyEnv: API_KEY_ENV,
		root: join(import.meta.dir, ".."),
		...(baseUrl === undefined ? {} : { baseUrl }),
		...(model === undefined ? {} : { model }),
	});
	if (!report.ok) {
		console.error(`error: ${report.error}`);
		return 1;
	}
	console.log(`# simulacra llm bench`);
	console.log(``);
	console.log(report.value.markdown);
	console.log(``);
	console.log(`results: ${report.value.out}`);
	// Exit non-zero when a run failed or the budget was exceeded, so either regression fails CI.
	// 有运行失败或超出预算时非零退出，两种回退都会让 CI 变红。
	const succeeded = report.value.rows.every((r) => r.status === "succeeded");
	const withinBudget = report.value.totalCalls <= MAX_TOTAL_CALLS;
	if (!succeeded) console.error(`error: a bench run failed`);
	if (!withinBudget)
		console.error(
			`error: ${report.value.totalCalls} llm calls exceed the budget of ${MAX_TOTAL_CALLS}`,
		);
	return succeeded && withinBudget ? 0 : 1;
};

if (import.meta.main) process.exit(await main());
