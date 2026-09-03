// `simulacra mcp`: serves the MCP tools and resources over stdio with a run registry on --data.
// Logs go to stderr because stdout is the MCP transport; the command returns when the client
// closes the connection.
// `simulacra mcp`：以 --data 上的运行注册表通过 stdio 提供 MCP 工具与资源。
// 日志写到 stderr，因为 stdout 就是 MCP 传输通道；客户端关闭连接后命令返回。

import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineCommand } from "citty";
import {
	DEFAULT_DATA_DIR,
	createLogger,
	createMcpServer,
	createRunRegistry,
	levelFromEnv,
	prettySink,
} from "../../index";
import { logLevelArg } from "./shared";

export const mcpCommand = defineCommand({
	meta: {
		name: "mcp",
		description: "Serve the MCP tools and resources over stdio",
	},
	args: {
		data: { type: "string", description: `data directory (default ${DEFAULT_DATA_DIR})` },
		"log-level": { type: "string", description: "trace, debug, info, warn or error" },
	},
	run: async ({ args }) => {
		const dataDir = resolve(args.data ?? DEFAULT_DATA_DIR);
		const logLevel = logLevelArg(args["log-level"]);
		const logger = createLogger({
			level: logLevel ?? levelFromEnv(),
			sinks: [prettySink((line) => console.error(line))],
		});
		const registry = createRunRegistry({
			dataDir,
			logger,
			...(logLevel === undefined ? {} : { logLevel }),
		});
		const server = createMcpServer({ registry, logger });
		const transport = new StdioServerTransport();
		await server.connect(transport);
		logger.info("mcp server connected", { dataDir });
		await new Promise<void>((resolveClosed) => {
			server.server.onclose = () => resolveClosed();
		});
	},
});
