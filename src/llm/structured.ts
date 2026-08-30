import { err, ok } from "../core/result";
import type { JsonValue, Result } from "../core/types";

const balancedObjectBlocks = (text: string): readonly string[] => {
	const blocks: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (depth > 0 && c === '"') {
			inString = true;
			continue;
		}
		if (c === "{") {
			if (depth === 0) start = i;
			depth += 1;
		} else if (c === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				blocks.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return blocks;
};

export const extractLastJsonBlock = (text: string): Result<JsonValue, string> => {
	const blocks = balancedObjectBlocks(text);
	const last = blocks[blocks.length - 1];
	if (last === undefined) return err("no balanced JSON object in response");
	try {
		return ok(JSON.parse(last) as JsonValue);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err(`last JSON object is not valid JSON: ${message}`);
	}
};

export const schemaInstruction = (schema: JsonValue): string =>
	[
		"Respond with exactly one JSON object and nothing else.",
		"The object must conform to this JSON schema:",
		"```json",
		JSON.stringify(schema),
		"```",
	].join("\n");
