import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { digest, loadScenario, runScenario, type RunResult } from "../../index";
import {
	describeFailure,
	fail,
	integerArg,
	logLevelArg,
	pluginPathsOf,
	positiveArg,
	print,
} from "./shared";

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
		plugin: { type: "string", description: "module exporting register(registry); repeatable" },
		overwrite: { type: "boolean", description: "replace a non-empty output directory" },
		"log-level": { type: "string", description: "trace, debug, info, warn or error" },
		"checkpoint-every": { type: "string", description: "write a checkpoint every N ticks" },
	},
	run: async ({ args, rawArgs }) => {
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
		const result = await runScenario(scenario, args.out, {
			plugins,
			overwrite: args.overwrite === true,
			...(ticks === undefined ? {} : { ticksOverride: ticks }),
			...(args.provider === undefined ? {} : { providerOverride: args.provider }),
			...(every === undefined ? {} : { checkpointEvery: every }),
			...(logLevel === undefined ? {} : { logLevel }),
		});
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
