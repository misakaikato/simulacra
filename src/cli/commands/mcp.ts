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
