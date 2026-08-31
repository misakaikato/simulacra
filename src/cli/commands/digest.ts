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
