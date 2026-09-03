// Script adapter: the process contract for external frameworks. The scenario is written to
// config.json, the script is spawned as `argv --config cfg.json --seed N --out dir`, and its
// result.json is validated into a RunResult; a non-zero exit, timeout or missing result becomes
// a FailureInfo rather than an exception, so the harness treats it like any other failed run.
// 脚本适配器：接入外部框架的进程契约。场景写成 config.json，脚本以
// `argv --config cfg.json --seed N --out dir` 启动，其 result.json 校验后转成 RunResult；
// 非零退出、超时或缺少结果都转成 FailureInfo 而不是异常，harness 把它当普通失败 run 处理。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { makeRunId } from "../core/ids";
import type { Adapter, RunFn } from "../core/protocols";
import { err, ok } from "../core/result";
import { parseScenario, scenarioHash } from "../core/scenario";
import { LogicalTimeSchema } from "../core/schema";
import type { Cost, FailureInfo, JsonValue, Result, RunResult, Scenario } from "../core/types";

export const SCRIPT_CONFIG_FILE = "config.json";
export const SCRIPT_RESULT_FILE = "result.json";
export const SCRIPT_LOG_FILE = "script.log";
export const SCRIPT_ADAPTER_KIND = "script";
const STDERR_EXCERPT = 500;

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const counter = z.number().int().nonnegative().default(0);

export const ScriptFailureSchema = z.object({
	stage: z.enum(["instantiate", "run", "extract"]).default("run"),
	excType: z.string().default("Error"),
	message: z.string().default(""),
	stack: z.string().default(""),
	at: LogicalTimeSchema.optional(),
});

export const ScriptIntegritySchema = z.object({
	activated: counter,
	ok: counter,
	failed: counter,
	parseFailures: counter,
	llmCalls: counter,
	llmFailures: counter,
	droppedEffects: counter,
	rejectedActions: counter,
	complete: z.boolean().optional(),
});

export const ScriptCostSchema = z.object({
	llmCalls: counter,
	promptTokens: counter,
	completionTokens: counter,
	cachedTokens: counter,
	wallMs: counter,
});

// Every counter defaults to 0 and `status` may be omitted: a script that only writes metrics
// still yields a valid, complete result, and one that writes `failure` is failed by default.
// 所有计数器默认 0，`status` 可省略：只写指标的脚本也能得到合法且完整的结果，
// 写了 `failure` 的脚本默认判为失败。
export const ScriptResultSchema = z.object({
	status: z.enum(["succeeded", "failed"]).optional(),
	failure: ScriptFailureSchema.optional(),
	metrics: z.record(z.string(), z.number()).default({}),
	distributions: z.record(z.string(), z.array(z.number())).default({}),
	integrity: ScriptIntegritySchema.prefault({}),
	cost: ScriptCostSchema.prefault({}),
});

export type ScriptResult = z.output<typeof ScriptResultSchema>;

export interface ScriptAdapterOptions {
	readonly argv: readonly string[];
	readonly name?: string | undefined;
	readonly cwd?: string | undefined;
	readonly env?: Readonly<Record<string, string>> | undefined;
	readonly timeoutMs?: number | undefined;
}

const isObject = (v: JsonValue): v is { readonly [k: string]: JsonValue } =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const failedScriptResult = (
	scenario: Scenario,
	outDir: string,
	failure: FailureInfo,
	wallMs = 0,
): RunResult => ({
	runId: makeRunId(scenario.scenarioId, scenario.replicationId),
	scenarioHash: scenarioHash(scenario),
	seed: scenario.seed,
	status: "failed",
	failure,
	metrics: {},
	distributions: {},
	integrity: {
		activated: 0,
		ok: 0,
		failed: 0,
		parseFailures: 0,
		llmCalls: 0,
		llmFailures: 0,
		droppedEffects: 0,
		rejectedActions: 0,
		complete: false,
	},
	cost: { ...ZERO_COST, wallMs },
	logPath: join(outDir, SCRIPT_LOG_FILE),
});

const failureInfoOf = (f: z.output<typeof ScriptFailureSchema>): FailureInfo => ({
	stage: f.stage,
	excType: f.excType,
	message: f.message,
	stack: f.stack,
	...(f.at === undefined ? {} : { at: f.at }),
});

// `complete` defaults to the run's success and the adapter's own wall time fills in when the
// script reports none, so integrity and cost summaries never carry holes.
// `complete` 默认等于 run 是否成功，脚本未报 wallMs 时用适配器自己计的时间补上，
// 完整性与成本汇总因此不会出现空洞。
export const scriptResultToRunResult = (
	scenario: Scenario,
	outDir: string,
	parsed: ScriptResult,
	wallMs: number,
): RunResult => {
	const status = parsed.status ?? (parsed.failure === undefined ? "succeeded" : "failed");
	const { complete, ...integrity } = parsed.integrity;
	return {
		runId: makeRunId(scenario.scenarioId, scenario.replicationId),
		scenarioHash: scenarioHash(scenario),
		seed: scenario.seed,
		status,
		...(parsed.failure === undefined ? {} : { failure: failureInfoOf(parsed.failure) }),
		metrics: parsed.metrics,
		distributions: parsed.distributions,
		integrity: { ...integrity, complete: complete ?? status === "succeeded" },
		cost: { ...parsed.cost, wallMs: parsed.cost.wallMs === 0 ? wallMs : parsed.cost.wallMs },
		logPath: join(outDir, SCRIPT_LOG_FILE),
	};
};

export const readScriptResult = (scenario: Scenario, outDir: string, wallMs: number): RunResult => {
	const resultPath = join(outDir, SCRIPT_RESULT_FILE);
	if (!existsSync(resultPath))
		return failedScriptResult(
			scenario,
			outDir,
			{
				stage: "extract",
				excType: "MissingResult",
				message: `${resultPath} was not written by the script`,
				stack: "",
			},
			wallMs,
		);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(resultPath, "utf8"));
	} catch (e) {
		return failedScriptResult(
			scenario,
			outDir,
			{
				stage: "extract",
				excType: "InvalidResult",
				message: `${resultPath}: ${e instanceof Error ? e.message : String(e)}`,
				stack: "",
			},
			wallMs,
		);
	}
	const parsed = ScriptResultSchema.safeParse(raw);
	if (!parsed.success)
		return failedScriptResult(
			scenario,
			outDir,
			{
				stage: "extract",
				excType: "InvalidResult",
				message: `${resultPath}: ${parsed.error.issues
					.map((i) => `${i.path.join(".")} ${i.message}`)
					.join("; ")}`,
				stack: "",
			},
			wallMs,
		);
	return scriptResultToRunResult(scenario, outDir, parsed.data, wallMs);
};

const describeError = (e: unknown): FailureInfo => ({
	stage: "instantiate",
	excType: e instanceof Error ? e.name : "Error",
	message: e instanceof Error ? e.message : String(e),
	stack: e instanceof Error ? (e.stack ?? "") : "",
});

export const scriptArgv = (
	argv: readonly string[],
	cfgPath: string,
	seed: number,
	outDir: string,
): readonly string[] => [...argv, "--config", cfgPath, "--seed", String(seed), "--out", outDir];

export interface ScriptExecution {
	readonly scenario: Scenario;
	readonly wallMs: number;
	readonly failure?: FailureInfo;
}

type ScriptProcess = Subprocess<"ignore", "pipe", "pipe">;

const spawnScript = (
	options: ScriptAdapterOptions,
	argv: readonly string[],
): Result<ScriptProcess, FailureInfo> => {
	try {
		return ok(
			Bun.spawn([...argv], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, ...(options.env ?? {}) },
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			}),
		);
	} catch (e) {
		return err(describeError(e));
	}
};

// Writes config.json, runs the script and stores its output in script.log; result.json is not read here
// 写 config.json、运行脚本并把输出存进 script.log；此处不读 result.json

// The seed passed by the harness overrides the scenario's own so replications differ only by
// seed; stdout and stderr are drained concurrently with `exited` to avoid pipe deadlock.
// harness 传入的种子覆盖场景自带的种子，复制之间只差种子；
// stdout 与 stderr 和 `exited` 并发读取，避免管道死锁。
export const executeScript = async (
	options: ScriptAdapterOptions,
	scenario: Scenario,
	seed: number,
	outDir: string,
): Promise<ScriptExecution> => {
	const effective: Scenario = { ...scenario, seed };
	mkdirSync(outDir, { recursive: true });
	const cfgPath = join(outDir, SCRIPT_CONFIG_FILE);
	writeFileSync(cfgPath, JSON.stringify(effective, null, "\t"));
	const started = performance.now();
	const spawned = spawnScript(options, scriptArgv(options.argv, cfgPath, seed, outDir));
	if (!spawned.ok) {
		writeFileSync(join(outDir, SCRIPT_LOG_FILE), "");
		return { scenario: effective, wallMs: 0, failure: spawned.error };
	}
	const proc = spawned.value;
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => proc.kill(), options.timeoutMs);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (timer !== undefined) clearTimeout(timer);
	const wallMs = Math.round(performance.now() - started);
	writeFileSync(
		join(outDir, SCRIPT_LOG_FILE),
		stderr.length === 0 ? stdout : `${stdout}\n[stderr]\n${stderr}`,
	);
	if (code === 0) return { scenario: effective, wallMs };
	const excerpt = stderr.trim().slice(0, STDERR_EXCERPT);
	return {
		scenario: effective,
		wallMs,
		failure: {
			stage: "run",
			excType: "NonZeroExit",
			message: `${options.argv.join(" ")} exited with code ${code}${excerpt.length === 0 ? "" : `: ${excerpt}`}`,
			stack: "",
		},
	};
};

export const runScript = async (
	options: ScriptAdapterOptions,
	scenario: Scenario,
	seed: number,
	outDir: string,
): Promise<RunResult> => {
	const executed = await executeScript(options, scenario, seed, outDir);
	if (executed.failure !== undefined)
		return failedScriptResult(executed.scenario, outDir, executed.failure, executed.wallMs);
	return readScriptResult(executed.scenario, outDir, executed.wallMs);
};

// A foreign config that already is a scenario passes through; anything else is wrapped into a
// minimal scenario under params.external so the harness can still hash, perturb and replicate.
// 已经是场景的外部配置直接通过；其它形态包进最小场景的 params.external，
// harness 仍能对它哈希、扰动与复制。
export const externalToScenario = (name: string, external: JsonValue): Result<Scenario, string> => {
	if (isObject(external)) {
		const direct = parseScenario(external);
		if (direct.ok) return direct;
	}
	const fields = isObject(external) ? external : {};
	const wrapped = parseScenario({
		scenarioId: typeof fields.scenarioId === "string" ? fields.scenarioId : name,
		seed: typeof fields.seed === "number" ? fields.seed : 0,
		population: { n: 1 },
		params: { external },
	});
	return wrapped.ok
		? wrapped
		: err(wrapped.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
};

export const createScriptAdapter = (options: ScriptAdapterOptions): Adapter => {
	const name = options.name ?? SCRIPT_ADAPTER_KIND;
	const run: RunFn = (scenario, seed, outDir) => runScript(options, scenario, seed, outDir);
	return {
		name,
		toScenario: (external) => externalToScenario(name, external),
		run,
	};
};
