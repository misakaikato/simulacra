import { defineCommand } from "citty";
import { replay } from "../../index";
import { fail, nonNegativeArg, print } from "./shared";

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
		const toTick = nonNegativeArg("to-tick", args["to-tick"]);
		const result = replay(args.runDir, toTick);
		if (!result.ok) return fail(result.error);
		print(`worldHash: ${result.value.worldHash}`);
		print(`tick: ${result.value.tick}`);
		if (toTick !== undefined && result.value.tick < toTick)
			print(`requested: ${toTick} (run ends at tick ${result.value.tick})`);
		print(`from: checkpoint ${result.value.fromTick}`);
		print(`effects: ${result.value.folded}`);
	},
});
