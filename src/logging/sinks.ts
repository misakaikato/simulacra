import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { LogLevel, LogRecord, LogSink } from "./logger";

const RESERVED = new Set(["ts", "level", "msg", "data"]);

export const formatJsonl = (record: LogRecord): string => {
	const line: Record<string, unknown> = { ts: record.ts, level: record.level, msg: record.msg };
	for (const [k, v] of Object.entries(record.ctx)) {
		if (!RESERVED.has(k)) line[k] = v;
	}
	if (record.data !== undefined) line.data = record.data;
	return JSON.stringify(line);
};

const COLORS: Readonly<Record<LogLevel, string>> = {
	trace: "[90m",
	debug: "[36m",
	info: "[32m",
	warn: "[33m",
	error: "[31m",
};
const RESET = "[0m";

export const formatPretty = (record: LogRecord, color = false): string => {
	const level = record.level.toUpperCase().padEnd(5);
	const ctx = Object.entries(record.ctx)
		.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" ");
	const data = record.data === undefined ? "" : ` ${JSON.stringify(record.data)}`;
	const head = color ? `${COLORS[record.level]}${level}${RESET}` : level;
	return `${record.ts} ${head} ${ctx.length > 0 ? `[${ctx}] ` : ""}${record.msg}${data}`;
};

export const jsonlSink = (path: string): LogSink => {
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "a");
	let open = true;
	return {
		write(record) {
			if (!open) return;
			writeSync(fd, `${formatJsonl(record)}\n`);
		},
		close() {
			if (!open) return;
			open = false;
			closeSync(fd);
		},
	};
};

export const prettySink = (
	target: WritableStream<string> | ((line: string) => void),
	opts: { readonly color?: boolean } = {},
): LogSink => {
	const color = opts.color ?? false;
	if (typeof target === "function") {
		return {
			write(record) {
				target(formatPretty(record, color));
			},
			close() {},
		};
	}
	const writer = target.getWriter();
	let pending: Promise<void> = Promise.resolve();
	return {
		write(record) {
			const line = `${formatPretty(record, color)}\n`;
			pending = pending.then(() => writer.write(line));
		},
		close() {
			pending = pending.then(() => writer.close());
		},
	};
};

export const memorySink = (): LogSink & { readonly records: readonly LogRecord[] } => {
	const records: LogRecord[] = [];
	return {
		records,
		write(record) {
			records.push(record);
		},
		close() {},
	};
};
