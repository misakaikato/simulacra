// `simulacra serve`: builds the run registry and the Hono app from the public API and binds
// Bun.serve to 127.0.0.1 only; --port 0 picks a free port and the actual address is printed.
// The process stays alive until SIGINT or SIGTERM stops the server.
// `simulacra serve`：用公共 API 构建运行注册表与 Hono 应用，Bun.serve 只绑定 127.0.0.1；
// --port 0 取空闲端口并打印实际地址。进程一直存活，直到 SIGINT 或 SIGTERM 停止服务器。

import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
	DEFAULT_DATA_DIR,
	createApp,
	createLogger,
	createRunRegistry,
	levelFromEnv,
	listen,
	prettySink,
} from "../../index";
import { fail, logLevelArg, nonNegativeArg, print } from "./shared";

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";
export const MAX_PORT = 65535;

export const serveCommand = defineCommand({
	meta: {
		name: "serve",
		description: "Serve the HTTP API and the GUI",
	},
	args: {
		port: { type: "string", description: `port to listen on (default ${DEFAULT_PORT})` },
		data: { type: "string", description: `data directory (default ${DEFAULT_DATA_DIR})` },
		"log-level": { type: "string", description: "trace, debug, info, warn or error" },
	},
	run: async ({ args }) => {
		const port = nonNegativeArg("port", args.port) ?? DEFAULT_PORT;
		if (port > MAX_PORT) return fail(`--port must be between 0 and ${MAX_PORT}, got ${port}`);
		const dataDir = resolve(args.data ?? DEFAULT_DATA_DIR);
		const logLevel = logLevelArg(args["log-level"]);
		// Logs go to stderr through the pretty sink so stdout carries only the address and data
		// lines, which scripts can read.
		// 日志经 pretty sink 写到 stderr，stdout 只有地址与数据目录两行，便于脚本读取。
		const logger = createLogger({
			level: logLevel ?? levelFromEnv(),
			sinks: [prettySink((line) => console.error(line))],
		});
		const registry = createRunRegistry({
			dataDir,
			logger,
			...(logLevel === undefined ? {} : { logLevel }),
		});
		const app = createApp({ registry, logger });
		const server = listen(app, { port, hostname: DEFAULT_HOST });
		print(`listening on http://${DEFAULT_HOST}:${server.port}`);
		print(`data: ${dataDir}`);
		await new Promise<void>((resolveStop) => {
			const stop = (): void => {
				server.stop();
				resolveStop();
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
	},
});
