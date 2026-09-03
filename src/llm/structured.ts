// Structured-output helpers for prompt mode: the schema instruction appended to the system
// message, and extraction of the last balanced JSON object from free text, since models often
// wrap the answer in explanation.
// prompt 模式的结构化输出辅助：追加到 system 消息的 schema 指令，以及从自由文本中提取最后一个
// 平衡 JSON 对象，因为模型常把答案裹在解释里。

import { err, ok } from "../core/result";
import type { JsonValue, Result } from "../core/types";

// A brace scanner rather than a parser: depth is tracked outside strings so a brace inside a
// quoted value cannot end a block. The last complete block is taken as the answer.
// 用花括号扫描器而不是解析器：在字符串之外跟踪深度，引号内的花括号不会结束块。
// 取最后一个完整块作为答案。
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
