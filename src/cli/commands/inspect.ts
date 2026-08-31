import { defineCommand } from "citty";
import { inspect, toEntityId, toEventId, type Effect, type InspectResult } from "../../index";
import { fail, integerArg, print } from "./shared";

const timeOf = (t: { tick: number; substep: number; seq: number }): string =>
	`${t.tick}.${t.substep}.${t.seq}`;

const describeEffect = (e: Effect): string => {
	switch (e.op) {
		case "set":
		case "inc":
		case "append":
			return `${e.op} ${e.entity}[${e.id}].${e.column} = ${JSON.stringify(e.value)}`;
		case "create":
			return `create ${e.entity}[${e.id}] ${JSON.stringify(e.row)}`;
		case "delete":
			return `delete ${e.entity}[${e.id}]`;
		case "envSet":
			return `envSet ${e.key} = ${JSON.stringify(e.value)}`;
		case "setColumn":
			return `setColumn ${e.entity}.${e.column} on ${e.ids.length} rows`;
	}
};

export const renderInspect = (r: InspectResult): readonly string[] => {
	const lines: string[] = [`agent ${r.agentId} tick ${r.tick}`];
	lines.push("observation:");
	lines.push(
		r.observation === undefined
			? "  none"
			: `  ${r.observation.eventId} t=${timeOf(r.observation.t)} contentSha=${r.observation.payload.contentSha} promptHash=${r.observation.payload.promptHash ?? "-"} truncated=${r.observation.payload.truncated}`,
	);
	lines.push("prompt:");
	lines.push(
		r.promptPreview === undefined
			? "  none"
			: `  ${r.promptPreview.replace(/\s+/g, " ").trim()}`,
	);
	lines.push("decision:");
	lines.push(
		r.decision === undefined
			? "  none"
			: `  ${r.decision.eventId} t=${timeOf(r.decision.t)} action=${r.decision.payload.action} args=${JSON.stringify(r.decision.payload.args)} provider=${r.decision.payload.provider} parseOk=${r.decision.payload.parseOk}`,
	);
	lines.push(`effects: ${r.effects.length}`);
	for (const e of r.effects) lines.push(`  ${describeEffect(e)}`);
	if (r.failures.length > 0) {
		lines.push(`failures: ${r.failures.length}`);
		for (const f of r.failures)
			lines.push(
				`  ${f.eventId} ${f.payload.stage} ${f.payload.excType}: ${f.payload.message}`,
			);
	}
	lines.push(`chain: ${r.chain.map((e) => `${e.kind}@${timeOf(e.t)}`).join(" -> ")}`);
	return lines;
};

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
