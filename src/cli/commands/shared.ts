// Helpers shared by every CLI command: CliError and fail() as the single error path, print(),
// argument coercions (integer, positive, non-negative, log level, llm mode) and the scan of
// the raw argument list for --plugin.
// 所有 CLI 命令共用的辅助：作为单一错误通路的 CliError 与 fail()、print()、参数转换
//（整数、正数、非负数、日志级别、llm 模式），以及对原始参数列表里 --plugin 的扫描。

import { isLogLevel, type LLMSpec, type LogLevel } from "../../index";

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

const MISSING_PLUGIN = "missing plugin path";

// --plugin is scanned from rawArgs so it can be repeated; the citty args declare it as a single
// string. Both `--plugin x` and `--plugin=x` are accepted, an empty or flag-like value fails.
// --plugin 从 rawArgs 扫描以便重复给出；citty 的参数声明只把它当单个字符串。
// `--plugin x` 与 `--plugin=x` 都接受，空值或像另一个标志的值直接失败。
export const pluginPathsOf = (rawArgs: readonly string[]): readonly string[] => {
	const paths: string[] = [];
	for (const [i, arg] of rawArgs.entries()) {
		if (arg === "--plugin") {
			const next = rawArgs[i + 1];
			if (next === undefined || next.length === 0 || next.startsWith("--"))
				fail(MISSING_PLUGIN);
			else paths.push(next);
		} else if (arg.startsWith("--plugin=")) {
			const value = arg.slice("--plugin=".length);
			if (value.length === 0 || value.startsWith("--")) fail(MISSING_PLUGIN);
			else paths.push(value);
		}
	}
	return paths;
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

export const nonNegativeArg = (name: string, value: string | undefined): number | undefined => {
	const n = integerArg(name, value);
	if (n !== undefined && n < 0) return fail(`--${name} must not be negative, got ${n}`);
	return n;
};

export const logLevelArg = (value: string | undefined): LogLevel | undefined => {
	if (value === undefined) return undefined;
	if (!isLogLevel(value))
		return fail(`--log-level must be one of trace, debug, info, warn, error`);
	return value;
};

export const LLM_MODES: readonly LLMSpec["mode"][] = ["live", "record", "replay"];

export const llmModeArg = (value: string | undefined): LLMSpec["mode"] | undefined => {
	if (value === undefined) return undefined;
	const mode = LLM_MODES.find((m) => m === value);
	if (mode === undefined) return fail(`--llm-mode must be one of ${LLM_MODES.join(", ")}`);
	return mode;
};

// Mirrors --log-level parsing without citty so the top-level catch can still decide whether to
// print a stack when argument parsing itself is what failed.
// 不经 citty 复刻 --log-level 的解析，使最外层 catch 在参数解析本身失败时也能决定是否打印栈。
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
