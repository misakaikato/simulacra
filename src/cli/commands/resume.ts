import { defineCommand } from "citty";
import { digest, resume } from "../../index";
import { summarize } from "./run";
import { describeFailure, fail, logLevelArg, pluginPathsOf, positiveArg, print } from "./shared";

export const resumeCommand = defineCommand({
	meta: { name: "resume", description: "Continue a run from a checkpoint directory" },
	args: {
		checkpointDir: {
			type: "positional",
			description: "<runDir>/checkpoints/<tick>",
			required: true,
		},
		ticks: { type: "string", description: "number of ticks to run", required: true },
		out: { type: "string", description: "output directory", required: true },
		plugin: { type: "string", description: "module exporting register(registry); repeatable" },
		overwrite: { type: "boolean", description: "replace a non-empty output directory" },
		"log-level": { type: "string", description: "trace, debug, info, warn or error" },
		"checkpoint-every": { type: "string", description: "write a checkpoint every N ticks" },
	},
	run: async ({ args, rawArgs }) => {
		const ticks = positiveArg("ticks", args.ticks);
		if (ticks === undefined) return fail("--ticks is required");
		const plugins = pluginPathsOf(rawArgs);
		const every = positiveArg("checkpoint-every", args["checkpoint-every"]);
		const logLevel = logLevelArg(args["log-level"]);
		const result = await resume(args.checkpointDir, ticks, args.out, {
			plugins,
			overwrite: args.overwrite === true,
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
