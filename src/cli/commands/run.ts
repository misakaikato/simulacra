// `simulacra run`: loads a scenario file, applies the command-line overrides and calls the public
// runScenario; prints the summary and the log digest, and exits non-zero when the run failed.
// `simulacra run`：加载场景文件，套用命令行覆盖后调用公共 runScenario；打印摘要与日志摘要值，
// 运行失败时以非零退出码结束。

import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { digest, loadScenario, runScenario, type RunResult } from "../../index";
import {
	LLM_MODES,
	describeFailure,
	fail,
	integerArg,
	llmModeArg,
	logLevelArg,
	pluginPathsOf,
	positiveArg,
	print,
} from "./shared";

// Shared with `resume` so both commands print the same five lines.
// 与 resume 共用，两个命令输出同样的五行。
export const summarize = (result: RunResult, outDir: string): readonly string[] => {
	const i = result.integrity;
	const c = result.cost;
	const metrics = Object.entries(result.metrics)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	return [
		`run ${result.runId} ${result.status}`,
		`out: ${outDir}`,
		`integrity: activated=${i.activated} ok=${i.ok} failed=${i.failed} parseFailures=${i.parseFailures} llmFailures=${i.llmFailures} droppedEffects=${i.droppedEffects} rejectedActions=${i.rejectedActions} complete=${i.complete}`,
		`cost: llmCalls=${c.llmCalls} promptTokens=${c.promptTokens} completionTokens=${c.completionTokens} cachedTokens=${c.cachedTokens}`,
		`metrics: ${metrics.length === 0 ? "none" : metrics}`,
	];
};

export const runCommand = defineCommand({
	meta: {
		name: "run",
		description: "Run a scenario and write events, checkpoints and result.json",
	},
	args: {
		scenario: { type: "positional", description: "path to scenario.yaml", required: true },
		seed: { type: "string", description: "override the scenario seed" },
		out: { type: "string", description: "output directory", required: true },
		ticks: { type: "string", description: "override the total number of ticks" },
		provider: {
			type: "enum",
			options: ["mock", "llm"],
			description: "replace every provider with this kind",
		},
		"llm-mode": {
			type: "enum",
			options: [...LLM_MODES],
			description: "gateway mode: live, record into llm.recordDir or replay from it",
		},
		plugin: { type: "string", description: "module exporting register(registry); repeatable" },
		overwrite: { type: "boolean", description: "replace a non-empty output directory" },
		"log-level": { type: "string", description: "trace, debug, info, warn or error" },
		"checkpoint-every": { type: "string", description: "write a checkpoint every N ticks" },
	},
	run: async ({ args, rawArgs }) => {
		// loadScenario treats a path that does not exist as inline YAML text, so a missing file is
		// caught here by its extension to report file-not-found instead of a YAML parse error.
		// loadScenario 把不存在的路径当作内联 YAML 文本，因此按扩展名在此拦截缺失的文件，
		// 报“文件不存在”而不是 YAML 解析错误。
		if (/\.(ya?ml|json)$/i.test(args.scenario) && !existsSync(args.scenario))
			return fail(`${args.scenario}: file not found`);
		const loaded = loadScenario(args.scenario);
		if (!loaded.ok)
			return fail(
				`${args.scenario}: ${loaded.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
			);
		const seed = integerArg("seed", args.seed);
		const scenario = seed === undefined ? loaded.value : { ...loaded.value, seed };
		const plugins = pluginPathsOf(rawArgs);
		const ticks = positiveArg("ticks", args.ticks);
		const every = positiveArg("checkpoint-every", args["checkpoint-every"]);
		const logLevel = logLevelArg(args["log-level"]);
		const mode = llmModeArg(args["llm-mode"]);
		const result = await runScenario(scenario, args.out, {
			plugins,
			overwrite: args.overwrite === true,
			...(ticks === undefined ? {} : { ticksOverride: ticks }),
			...(args.provider === undefined ? {} : { providerOverride: args.provider }),
			...(mode === undefined ? {} : { llmOverride: { mode } }),
			...(every === undefined ? {} : { checkpointEvery: every }),
			...(logLevel === undefined ? {} : { logLevel }),
		});
		// A run that failed mid-way still wrote result.json and a log, so the summary and digest
		// are printed before the non-zero exit; only a run that could not start skips them.
		// 中途失败的运行同样写了 result.json 与日志，所以摘要与摘要值先打印再非零退出；
		// 只有根本没能启动的运行才跳过它们。
		if (!result.ok) return fail(describeFailure(result.error));
		for (const line of summarize(result.value, args.out)) print(line);
		const sha = digest(args.out);
		if (sha.ok) print(`digest: ${sha.value}`);
		if (result.value.status === "failed")
			return fail(
				`run failed: ${result.value.failure === undefined ? "unknown" : describeFailure(result.value.failure)}`,
			);
	},
});
