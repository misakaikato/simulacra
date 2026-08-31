import { defineCommand } from "citty";
import { BASE_URL_ENV, DEFAULT_MODEL, MODEL_ENV, doctor } from "../../index";
import { fail, print } from "./shared";

export const doctorCommand = defineCommand({
	meta: {
		name: "doctor",
		description: "Check the environment; with --llm probe the endpoint (at most 6 calls)",
	},
	args: {
		llm: { type: "boolean", description: "probe the LLM endpoint" },
		"base-url": {
			type: "string",
			description: `endpoint base URL (default: $${BASE_URL_ENV} or DeepSeek)`,
		},
		model: {
			type: "string",
			description: `model name (default: $${MODEL_ENV} or ${DEFAULT_MODEL})`,
		},
	},
	run: async ({ args }) => {
		const checks = await doctor({
			llm: args.llm === true,
			...(args["base-url"] === undefined ? {} : { baseUrl: args["base-url"] }),
			...(args.model === undefined ? {} : { model: args.model }),
		});
		if (!checks.ok) return fail(checks.error);
		for (const c of checks.value) print(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
		const failed = checks.value.filter((c) => !c.ok);
		if (failed.length > 0) return fail(`${failed.length} check(s) failed`);
	},
});
