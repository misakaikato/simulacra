// Log sinks: jsonlSink appends one JSON object per line to a file with ctx keys flattened
// beside ts, level and msg; prettySink renders a human-readable line to a WritableStream or
// a callback; memorySink keeps records for tests.
// 日志 sink：jsonlSink 向文件追加每行一个 JSON 对象，ctx 的键与 ts、level、msg 平铺在一起；
// prettySink 向 WritableStream 或回调输出人读的一行；memorySink 为测试保留记录。

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { LogLevel, LogRecord, LogSink } from "./logger";

// Context keys that collide with the fixed fields are dropped rather than overwriting them,
// so ts, level, msg and data always mean what a reader expects.
// 与固定字段同名的上下文键被丢弃而不是覆盖，ts、level、msg 与 data 的含义始终符合读者预期。
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

// Writes are synchronous so the last records before a crash reach the file.
// 同步写入，崩溃前的最后几条记录能落到文件里。
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
	// Stream writes are chained on one promise so lines keep their order although write() is
	// synchronous for callers; close waits for the chain to drain.
	// 流写入串在同一个 promise 链上，write() 对调用方是同步的但行序得以保持；close 等链排空。
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
