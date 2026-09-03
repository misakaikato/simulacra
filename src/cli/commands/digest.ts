// `simulacra digest`: prints the sha256 digest of a run's event log, the value two runs of the
// same scenario and seed must agree on.
// `simulacra digest`：打印运行事件日志的 sha256 摘要值，同场景同种子的两次运行必须在此一致。

import { defineCommand } from "citty";
import { digest } from "../../index";
import { fail, print } from "./shared";

export const digestCommand = defineCommand({
	meta: { name: "digest", description: "Print the sha256 digest of a run's event log" },
	args: { runDir: { type: "positional", description: "run directory", required: true } },
	run: ({ args }) => {
		const result = digest(args.runDir);
		if (!result.ok) return fail(result.error);
		print(result.value);
	},
});
