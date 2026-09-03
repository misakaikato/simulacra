// Structured logger: a level filter, child contexts merged into every record, and span(),
// which records start, end with duration, and error with the exception before rethrowing.
// Records go to sinks; the logger itself formats nothing.
// 结构化日志器：级别过滤、合并进每条记录的子上下文，以及 span()：记录开始、带耗时的结束，
// 以及带异常的错误后重新抛出。记录交给 sink；日志器本身不做格式化。

import type { JsonObject } from "../core/types";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];

const rank = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

export const isLogLevel = (s: string): s is LogLevel =>
	(LOG_LEVELS as readonly string[]).includes(s);

// SIMULACRA_LOG picks the level for every entry point; an unknown value falls back rather
// than failing startup over a typo.
// SIMULACRA_LOG 为所有入口选定级别；无法识别的值退回默认，不会因为一个拼写错误而启动失败。
export const levelFromEnv = (
	value = process.env.SIMULACRA_LOG,
	fallback: LogLevel = "info",
): LogLevel => (value !== undefined && isLogLevel(value) ? value : fallback);

// ctx is the accumulated child context (runId, tick, component); data is per-call payload.
// ctx 是逐层累积的子上下文（runId、tick、component）；data 是单次调用附带的负载。
export interface LogRecord {
	readonly ts: string;
	readonly level: LogLevel;
	readonly msg: string;
	readonly ctx: JsonObject;
	readonly data?: JsonObject;
}

export interface LogSink {
	write(record: LogRecord): void;
	close(): void;
}

export interface Logger {
	readonly level: LogLevel;
	child(ctx: JsonObject): Logger;
	log(level: LogLevel, msg: string, data?: JsonObject): void;
	trace(msg: string, data?: JsonObject): void;
	debug(msg: string, data?: JsonObject): void;
	info(msg: string, data?: JsonObject): void;
	warn(msg: string, data?: JsonObject): void;
	error(msg: string, data?: JsonObject): void;
	span<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

const describeError = (e: unknown): string =>
	e instanceof Error ? `${e.name}: ${e.message}` : String(e);

class SinkLogger implements Logger {
	readonly level: LogLevel;
	private readonly sinks: readonly LogSink[];
	private readonly ctx: JsonObject;

	constructor(level: LogLevel, sinks: readonly LogSink[], ctx: JsonObject) {
		this.level = level;
		this.sinks = sinks;
		this.ctx = ctx;
	}

	child(ctx: JsonObject): Logger {
		return new SinkLogger(this.level, this.sinks, { ...this.ctx, ...ctx });
	}

	log(level: LogLevel, msg: string, data?: JsonObject): void {
		if (rank(level) < rank(this.level)) return;
		const record: LogRecord =
			data === undefined
				? { ts: new Date().toISOString(), level, msg, ctx: this.ctx }
				: { ts: new Date().toISOString(), level, msg, ctx: this.ctx, data };
		for (const sink of this.sinks) sink.write(record);
	}

	trace(msg: string, data?: JsonObject): void {
		this.log("trace", msg, data);
	}

	debug(msg: string, data?: JsonObject): void {
		this.log("debug", msg, data);
	}

	info(msg: string, data?: JsonObject): void {
		this.log("info", msg, data);
	}

	warn(msg: string, data?: JsonObject): void {
		this.log("warn", msg, data);
	}

	error(msg: string, data?: JsonObject): void {
		this.log("error", msg, data);
	}

	// span observes and never swallows: debug at start and end, error with the exception on
	// throw, then the exception continues to the caller.
	// span 只观察、从不吞掉：开始与结束记 debug，抛出时记带异常的 error，然后异常继续向调用方传播。
	async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const start = performance.now();
		this.debug(name, { span: "start" });
		try {
			const value = await fn();
			this.debug(name, { span: "end", ms: performance.now() - start });
			return value;
		} catch (e) {
			this.error(name, {
				span: "error",
				ms: performance.now() - start,
				error: describeError(e),
			});
			throw e;
		}
	}
}

export const createLogger = (opts: {
	readonly level: LogLevel;
	readonly sinks: readonly LogSink[];
	readonly ctx?: JsonObject;
}): Logger => new SinkLogger(opts.level, opts.sinks, opts.ctx ?? {});

// A logger with no sinks for library callers that pass none; nothing is written anywhere.
// 供未传日志器的库调用方使用的无 sink 日志器；不会向任何地方写入。
export const silentLogger: Logger = createLogger({ level: "error", sinks: [] });
