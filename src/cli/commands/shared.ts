import { resolve } from "node:path";
import { isLogLevel, type LogLevel } from "../../logging/logger";
import type { Registry } from "../../index";

export class CliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliError";
	}
}

export const fail = (message: string): never => {
	throw new CliError(message);
};

export const print = (line: string): void => {
	console.log(line);
};

export const pluginPathsOf = (rawArgs: readonly string[]): readonly string[] => {
	const paths: string[] = [];
	for (const [i, arg] of rawArgs.entries()) {
		if (arg === "--plugin") {
			const next = rawArgs[i + 1];
			if (next === undefined || next.startsWith("-")) fail("--plugin needs a path");
			else paths.push(next);
		} else if (arg.startsWith("--plugin=")) paths.push(arg.slice("--plugin=".length));
	}
	return paths;
};

const isRegisterModule = (m: unknown): m is { register: (registry: Registry) => unknown } =>
	typeof m === "object" &&
	m !== null &&
	"register" in m &&
	typeof (m as { register: unknown }).register === "function";

const isResult = (v: unknown): v is { readonly ok: boolean; readonly error?: unknown } =>
	typeof v === "object" && v !== null && "ok" in v;

export const loadPlugins = async (registry: Registry, paths: readonly string[]): Promise<void> => {
	for (const path of paths) {
		const absolute = resolve(path);
		let loaded: unknown;
		try {
			loaded = await import(absolute);
		} catch (e) {
			return fail(`plugin ${path}: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (!isRegisterModule(loaded))
			return fail(`plugin ${path}: module does not export register(registry)`);
		const result = await loaded.register(registry);
		if (isResult(result) && !result.ok)
			return fail(`plugin ${path}: register failed: ${JSON.stringify(result.error)}`);
	}
};

export const integerArg = (name: string, value: string | undefined): number | undefined => {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n)) return fail(`--${name} must be an integer, got '${value}'`);
	return n;
};

export const positiveArg = (name: string, value: string | undefined): number | undefined => {
	const n = integerArg(name, value);
	if (n !== undefined && n <= 0) return fail(`--${name} must be positive, got ${n}`);
	return n;
};

export const logLevelArg = (value: string | undefined): LogLevel | undefined => {
	if (value === undefined) return undefined;
	if (!isLogLevel(value))
		return fail(`--log-level must be one of trace, debug, info, warn, error`);
	return value;
};

export const wantsDebug = (rawArgs: readonly string[]): boolean =>
	rawArgs.includes("--log-level=debug") ||
	rawArgs.includes("--log-level=trace") ||
	rawArgs.some(
		(arg, i) =>
			arg === "--log-level" && (rawArgs[i + 1] === "debug" || rawArgs[i + 1] === "trace"),
	);

export const describeFailure = (f: {
	readonly excType: string;
	readonly message: string;
}): string => `${f.excType}: ${f.message}`;
