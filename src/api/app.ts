// Assembles the Hono app: error and 404 envelopes, the API routes, the SSE stream and the static
// GUI from gui/dist (or a plain-text note when it has not been built). listen() wraps Bun.serve
// with idleTimeout 0 so long-lived SSE connections are never cut by the server itself.
// 装配 Hono 应用：错误与 404 信封、API 路由、SSE 流，以及 gui/dist 的静态 GUI
//（未构建时返回一段纯文本说明）。listen() 包装 Bun.serve 并设 idleTimeout 0，
// 长连接的 SSE 不会被服务器自己掐断。

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

	// API paths always answer with a JSON envelope ({error} or {issues}) so the GUI can show any
	// failure; non-API paths get plain text. Handler exceptions are logged at error level.
	// API 路径一律以 JSON 信封（{error} 或 {issues}）应答，GUI 才能展示任何失败；
	// 非 API 路径返回纯文本。处理器抛出的异常记 error 日志。
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
	// The SSE route sits on the root app ahead of the runs router; sseKeepaliveMs lets tests
	// shorten the 15 s heartbeat without touching the route.
	// SSE 路由挂在根应用上、位于 runs 路由之前；sseKeepaliveMs 让测试能缩短 15 秒心跳而不改路由。
	app.get("/api/runs/:id/stream", (c) => {
		const runId = toRunId(c.req.param("id"));
		if (registry.getRun(runId) === undefined)
			return c.json({ error: `unknown run ${c.req.param("id")}` }, 404);
		return streamRun(c, registry, runId, keepaliveMs);
	});
	app.route("/api/runs", runRoutes(deps));
	app.route("/api/audits", auditRoutes(deps));

	// Static files are mounted only when index.html exists, so a source checkout without a GUI
	// build still answers on / with instructions instead of a bare 404.
	// 只有 index.html 存在才挂静态文件，没构建 GUI 的源码检出在 / 上仍能给出说明而不是裸 404。
	if (existsSync(join(guiDir, INDEX_HTML))) app.use("/*", serveStatic({ root: guiDir }));
	else app.get("/", (c) => c.text(GUI_MISSING_NOTE));

	return app;
};
