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
