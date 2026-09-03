// `simulacra doctor`: prints the environment checks and, with --llm, the endpoint probe, which
// is capped at 6 calls so the command never spends more than a few tokens. Any failed check
// makes the command exit non-zero.
// `simulacra doctor`：打印环境检查，带 --llm 时再打印端点探测；探测上限 6 次调用，
// 命令绝不会花费超过几个 token。任一检查失败即以非零退出。

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
