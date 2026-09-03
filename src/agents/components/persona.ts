// Persona component: projects the agent's public `persona.*` columns into the prompt and lifts
// the name field out separately; private fields never leave the world table.
// 人设组件：把 agent 公开的 `persona.*` 列投影进 prompt，并单独提出姓名字段；
// 私有字段永远不离开世界表。

import type { Component } from "../../core/protocols";
import type { JsonObject, JsonValue, Scalar } from "../../core/types";
import { CONTEXT_KEYS } from "./shared";

export interface PersonaOptions {
	readonly entity: string;
	readonly prefix: string;
	readonly privateFields: readonly string[];
	readonly nameField: string;
}

const scalarJson = (v: Scalar): JsonValue => (Array.isArray(v) ? [...v] : v);

// The wildcard read keeps declare() satisfied for any persona layout; filtering happens on the
// actual row, so a scenario that adds fields later needs no component change.
// 通配读键让 declare() 对任何人设布局都成立；过滤发生在实际行上，
// 场景日后增加字段无需改组件。
export const persona = (options: PersonaOptions): Component => {
	const hidden = new Set(options.privateFields.map((f) => `${options.prefix}${f}`));
	return {
		name: "persona",
		reads: [`${options.prefix}*`],
		writes: [CONTEXT_KEYS.persona, CONTEXT_KEYS.name],
		preAct: (agentId, view) => {
			const row = view.row(options.entity, agentId);
			const out: Record<string, JsonValue> = {};
			let name: string | undefined;
			if (row !== undefined) {
				for (const [column, value] of Object.entries(row)) {
					if (!column.startsWith(options.prefix) || hidden.has(column)) continue;
					const field = column.slice(options.prefix.length);
					out[field] = scalarJson(value);
					if (field === options.nameField && typeof value === "string") name = value;
				}
			}
			const result: Record<string, JsonValue> = { [CONTEXT_KEYS.persona]: out };
			if (name !== undefined) result[CONTEXT_KEYS.name] = name;
			return result satisfies JsonObject;
		},
		postAct: () => {},
		getState: () => null,
		setState: () => {},
	};
};
