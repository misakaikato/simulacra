// `simulacra inspect`: prints one agent's causal chain at a tick or around an anchor event,
// rendered by the same renderInspect the MCP get_agent_trace tool uses.
// `simulacra inspect`：打印某个 agent 在指定 tick 或围绕锚定事件的因果链，
// 渲染与 MCP 的 get_agent_trace 工具共用 renderInspect。

import { defineCommand } from "citty";
import { inspect, renderInspect, toEntityId, toEventId } from "../../index";
import { fail, integerArg, print } from "./shared";

export const inspectCommand = defineCommand({
	meta: {
		name: "inspect",
		description: "Print one agent's causal chain: observation, prompt, decision, effects",
	},
	args: {
		runDir: { type: "positional", description: "run directory", required: true },
		agent: { type: "string", description: "agent id", required: true },
		tick: { type: "string", description: "tick to inspect (default: the latest decision)" },
		event: { type: "string", description: "anchor on this event id instead of a decision" },
	},
	run: ({ args }) => {
		const tick = integerArg("tick", args.tick);
		const result = inspect(args.runDir, {
			agentId: toEntityId(args.agent),
			...(tick === undefined ? {} : { tick }),
			...(args.event === undefined ? {} : { eventId: toEventId(args.event) }),
		});
		if (!result.ok) return fail(result.error);
		for (const line of renderInspect(result.value)) print(line);
	},
});
