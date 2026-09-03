// Prompt rendering for focal agents. PromptOptions are the representation-level perturbation
// axes (persona format, instruction order, role placement, naming, memory representation,
// context window), so every option must change the rendered text and therefore the promptHash.
// focal agent 的 prompt 渲染。PromptOptions 是表征级扰动轴（persona 格式、指令顺序、角色位置、命名、
// 记忆表示、上下文窗口），每个选项都必须改变渲染文本，从而改变 promptHash。

import { hashOf } from "./hash";
import type {
	EntityId,
	EventId,
	JsonObject,
	JsonValue,
	LogicalTime,
	PromptMessage,
	PromptOptions,
	RenderedPrompt,
	Scalar,
} from "./types";

export interface MemoryEntry {
	readonly eventId: EventId;
	readonly t: LogicalTime;
	readonly kind: string;
	readonly text: string;
}

export interface ActionSummary {
	readonly name: string;
	readonly description: string;
	readonly schema: JsonValue;
}

export interface PromptInput {
	readonly agentId: EntityId;
	readonly name?: string;
	readonly persona: Readonly<Record<string, Scalar>>;
	readonly instructions: string;
	readonly memory: readonly MemoryEntry[];
	readonly observation: JsonObject;
	readonly actions: readonly ActionSummary[];
}

export interface PromptMeta {
	readonly truncated: boolean;
	readonly droppedMemories: number;
	readonly chars: number;
}

export interface RenderedPromptWithMeta extends RenderedPrompt {
	readonly meta: PromptMeta;
}

const GENERIC_SYSTEM = "You are a participant in a social simulation.";

// The structured-output schema pins the action to the action space as an enum; args stays
// an open object because each action's parameter schema is delivered in the prompt text.
// 结构化输出 schema 用枚举把 action 钉在动作空间内；args 保持开放对象，因为各动作的参数 schema
// 通过 prompt 文本给出。
export const decisionSchema = (actionNames: readonly string[]): JsonObject => ({
	type: "object",
	properties: {
		action: { type: "string", enum: [...actionNames] },
		args: { type: "object" },
		rationale: { type: "string" },
	},
	required: ["action", "args", "rationale"],
	additionalProperties: false,
});

const scalarText = (v: Scalar): string => {
	if (v === null) return "unknown";
	if (Array.isArray(v)) return v.length === 0 ? "none" : v.join(", ");
	return String(v);
};

const identityOf = (input: PromptInput, naming: PromptOptions["naming"]): string | undefined => {
	switch (naming) {
		case "id":
			return `agent ${input.agentId}`;
		case "name":
			return input.name ?? `agent ${input.agentId}`;
		case "anonymous":
			return undefined;
	}
};

const personaBlock = (input: PromptInput, options: PromptOptions): string => {
	const identity = identityOf(input, options.naming);
	const intro = identity === undefined ? "You are a participant." : `You are ${identity}.`;
	const entries = Object.entries(input.persona);
	if (entries.length === 0) return intro;
	switch (options.personaFormat) {
		case "plain":
			return `${intro} Your profile: ${entries.map(([k, v]) => `${k} is ${scalarText(v)}`).join("; ")}.`;
		case "bullets":
			return [
				`${intro} Your profile:`,
				...entries.map(([k, v]) => `- ${k}: ${scalarText(v)}`),
			].join("\n");
		case "table":
			return [
				`${intro} Your profile:`,
				"| field | value |",
				"| --- | --- |",
				...entries.map(([k, v]) => `| ${k} | ${scalarText(v)} |`),
			].join("\n");
	}
};

const memoryBlock = (
	memory: readonly MemoryEntry[],
	representation: PromptOptions["memoryRepresentation"],
): string => {
	if (memory.length === 0) return "Memory: none yet.";
	switch (representation) {
		case "transcript":
			return [
				"Memory:",
				...memory.map((m) => `[tick ${m.t.tick}] ${m.kind}: ${m.text}`),
			].join("\n");
		case "json":
			return `Memory (JSON):\n${JSON.stringify(
				memory.map((m) => ({ eventId: m.eventId, t: m.t, kind: m.kind, text: m.text })),
			)}`;
		case "bullets":
			return [
				"Memory:",
				...memory.map((m) => `- (tick ${m.t.tick}, ${m.kind}) ${m.text}`),
			].join("\n");
	}
};

const observationBlock = (observation: JsonObject): string =>
	`Observation:\n${JSON.stringify(observation, null, 2)}`;

const actionsBlock = (actions: readonly ActionSummary[]): string =>
	[
		"Available actions:",
		...actions.map(
			(a) => `- ${a.name}: ${a.description}\n  parameters: ${JSON.stringify(a.schema)}`,
		),
		'Choose exactly one action. Respond with a JSON object {"action": <name>, "args": <parameters object>, "rationale": <short reason>}.',
	].join("\n");

const roleBlock = (input: PromptInput, options: PromptOptions): string => {
	const persona = personaBlock(input, options);
	const instructions = input.instructions.trim();
	const parts =
		options.instructionOrder === "first" ? [instructions, persona] : [persona, instructions];
	return parts.filter((p) => p.length > 0).join("\n\n");
};

// rolePlacement decides whether persona and instructions live in the system message or are
// prepended to the user turn behind a generic system line.
// rolePlacement 决定 persona 与指令放在 system 消息里，还是放在通用 system 行之后的 user 轮开头。
const assemble = (
	input: PromptInput,
	options: PromptOptions,
	memory: readonly MemoryEntry[],
): { readonly system: string; readonly messages: readonly PromptMessage[] } => {
	const role = roleBlock(input, options);
	const context = [
		memoryBlock(memory, options.memoryRepresentation),
		observationBlock(input.observation),
		actionsBlock(input.actions),
	].join("\n\n");
	const system = options.rolePlacement === "system" ? role : GENERIC_SYSTEM;
	const user = options.rolePlacement === "system" ? context : `${role}\n\n${context}`;
	return {
		system,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
	};
};

const charsOf = (messages: readonly PromptMessage[]): number =>
	messages.reduce((n, m) => n + m.content.length, 0);

// Trimming drops the oldest memory entries one at a time until the prompt fits; persona,
// instructions, observation and actions are never dropped, so a prompt still over budget
// with no memory left is marked truncated rather than emptied. hash covers the messages only.
// 裁剪逐条丢弃最旧的记忆直到 prompt 装下；persona、指令、观察与动作从不丢弃，记忆已空仍超预算的
// prompt 标记 truncated 而不是裁成空。hash 只覆盖 messages。
export const renderPrompt = (
	input: PromptInput,
	options: PromptOptions,
): RenderedPromptWithMeta => {
	let memory = input.memory;
	let built = assemble(input, options, memory);
	let dropped = 0;
	while (charsOf(built.messages) > options.contextWindow && memory.length > 0) {
		memory = memory.slice(1);
		dropped += 1;
		built = assemble(input, options, memory);
	}
	const chars = charsOf(built.messages);
	return {
		system: built.system,
		messages: built.messages,
		schema: decisionSchema(input.actions.map((a) => a.name)),
		hash: hashOf(built.messages),
		meta: {
			truncated: dropped > 0 || chars > options.contextWindow,
			droppedMemories: dropped,
			chars,
		},
	};
};
