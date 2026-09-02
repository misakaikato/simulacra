import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { toRunId, type Logger, type RunRegistry } from "../index";
import { auditRoutes } from "./routes/audits";
import { examplesRoutes } from "./routes/examples";
import { healthRoutes } from "./routes/health";
import { runRoutes } from "./routes/runs";
import { KEEPALIVE_MS, streamRun } from "./sse";

export const GUI_DIST_DIR = resolve(import.meta.dir, "../../gui/dist");
const INDEX_HTML = "index.html";
const API_PREFIX = "/api/";
const GUI_MISSING_NOTE =
	"simulacra API is running, but the GUI has not been built.\n" +
	"Run `bun run build:gui` and restart `simulacra serve` to serve it from this address.\n" +
	"The API is available under /api (see /api/health).\n";

export interface AppOptions {
	readonly registry: RunRegistry;
	readonly logger: Logger;
	readonly guiDir?: string;
	readonly sseKeepaliveMs?: number;
}

export interface ListenOptions {
	readonly port: number;
	readonly hostname: string;
}

export const listen = (app: Hono, opts: ListenOptions): ReturnType<typeof Bun.serve> =>
	Bun.serve({ port: opts.port, hostname: opts.hostname, idleTimeout: 0, fetch: app.fetch });

export const createApp = (opts: AppOptions): Hono => {
	const { registry } = opts;
	const logger = opts.logger.child({ component: "api" });
	const deps = { registry, logger };
	const guiDir = opts.guiDir ?? GUI_DIST_DIR;
	const keepaliveMs = opts.sseKeepaliveMs ?? KEEPALIVE_MS;
	const app = new Hono();

	app.onError((e, c) => {
		logger.error("request failed", {
			method: c.req.method,
			path: c.req.path,
			error: e.message,
		});
		return c.json({ error: e.message }, 500);
	});
	app.notFound((c) =>
		c.req.path.startsWith(API_PREFIX)
			? c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404)
			: c.text(`no page at ${c.req.path}\n`, 404),
	);

	app.route("/api/health", healthRoutes());
	app.route("/api/examples", examplesRoutes());
	app.get("/api/runs/:id/stream", (c) => {
		const runId = toRunId(c.req.param("id"));
		if (registry.getRun(runId) === undefined)
			return c.json({ error: `unknown run ${c.req.param("id")}` }, 404);
		return streamRun(c, registry, runId, keepaliveMs);
	});
	app.route("/api/runs", runRoutes(deps));
	app.route("/api/audits", auditRoutes(deps));

	if (existsSync(join(guiDir, INDEX_HTML))) app.use("/*", serveStatic({ root: guiDir }));
	else app.get("/", (c) => c.text(GUI_MISSING_NOTE));

	return app;
};
