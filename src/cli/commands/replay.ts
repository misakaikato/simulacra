import { defineCommand } from "citty";
import { replay } from "../../index";
import { fail, integerArg, print } from "./shared";

export const replayCommand = defineCommand({
	meta: {
		name: "replay",
		description: "Fold recorded effects from the tick 0 checkpoint and print the world hash",
	},
	args: {
		runDir: { type: "positional", description: "run directory", required: true },
		"to-tick": { type: "string", description: "stop at the start of this tick" },
	},
	run: ({ args }) => {
		const toTick = integerArg("to-tick", args["to-tick"]);
		const result = replay(args.runDir, toTick);
		if (!result.ok) return fail(result.error);
		print(`worldHash: ${result.value.worldHash}`);
		print(`tick: ${result.value.tick}`);
		print(`effects: ${result.value.folded}`);
	},
});
