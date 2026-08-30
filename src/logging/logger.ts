import type { JsonObject } from "../core/types";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];

const rank = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

export const isLogLevel = (s: string): s is LogLevel =>
	(LOG_LEVELS as readonly string[]).includes(s);

export const levelFromEnv = (
	value = process.env.SIMULACRA_LOG,
	fallback: LogLevel = "info",
): LogLevel => (value !== undefined && isLogLevel(value) ? value : fallback);

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

export const silentLogger: Logger = createLogger({ level: "error", sinks: [] });
