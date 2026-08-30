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
