// Loads plugin modules named on the command line or in a scenario: each must export
// register(registry). Paths are resolved to absolute before import and deduplicated, so a
// plugin listed by both the scenario and --plugin registers once.
// 加载命令行或场景里指定的插件模块：每个模块必须导出 register(registry)。路径先解析为绝对路径
// 再导入并去重，因此场景与 --plugin 同时列出的插件只注册一次。

import { resolve } from "node:path";
import type { Registry } from "./core/protocols";
import { err, ok } from "./core/result";
import type { Result } from "./core/types";

export interface PluginLoadError {
	readonly path: string;
	readonly message: string;
}

const isRegisterModule = (m: unknown): m is { register: (registry: Registry) => unknown } =>
	typeof m === "object" &&
	m !== null &&
	"register" in m &&
	typeof (m as { register: unknown }).register === "function";

// register may return void or a Result; a returned err (typically a duplicate kind) and a throw
// during import are both reported with the plugin path so the operator knows which one broke.
// register 可以返回 void 或 Result；返回的 err（通常是 kind 重复）与导入时的异常都带插件路径报告，
// 操作者才知道坏的是哪一个。
const isResult = (v: unknown): v is { readonly ok: boolean; readonly error?: unknown } =>
	typeof v === "object" && v !== null && "ok" in v;

export const loadPlugins = async (
	registry: Registry,
	paths: readonly string[],
): Promise<Result<void, PluginLoadError>> => {
	const seen = new Set<string>();
	for (const path of paths) {
		const absolute = resolve(path);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		let loaded: unknown;
		try {
			loaded = await import(absolute);
		} catch (e) {
			return err({ path, message: e instanceof Error ? e.message : String(e) });
		}
		if (!isRegisterModule(loaded))
			return err({ path, message: "module does not export register(registry)" });
		const result = await loaded.register(registry);
		if (isResult(result) && !result.ok)
			return err({ path, message: `register failed: ${JSON.stringify(result.error)}` });
	}
	return ok(undefined);
};
