// `simulacra replay`: folds the recorded effect events onto the tick 0 checkpoint up to --to-tick
// and prints the resulting world hash, the check that a run's log reproduces its world.
// `simulacra replay`：把录下的 effect 事件折叠到 tick 0 检查点之上直到 --to-tick，
// 打印得到的世界哈希，用于核对运行日志能复现其世界。

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
		// A --to-tick past the end of the run is not an error: the world at the last tick is
		// printed together with the tick that was asked for.
		// 超过运行末尾的 --to-tick 不算错误：打印最后一个 tick 的世界，并附上所请求的 tick。
		if (toTick !== undefined && result.value.tick < toTick)
			print(`requested: ${toTick} (run ends at tick ${result.value.tick})`);
		print(`from: checkpoint ${result.value.fromTick}`);
		print(`effects: ${result.value.folded}`);
	},
});
