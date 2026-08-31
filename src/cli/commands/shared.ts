import { isLogLevel, type LogLevel } from "../../index";

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
