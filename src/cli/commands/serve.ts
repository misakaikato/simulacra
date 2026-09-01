import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
	DEFAULT_DATA_DIR,
	createApp,
	createLogger,
	createRunRegistry,
	levelFromEnv,
	prettySink,
} from "../../index";
import { logLevelArg, nonNegativeArg, print } from "./shared";

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";

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
		const app = createApp({ registry, logger });
		const server = Bun.serve({ port, hostname: DEFAULT_HOST, fetch: app.fetch });
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
