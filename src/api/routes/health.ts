// GET /api/health: {ok, version}, the cheapest way to confirm an address serves simulacra.
// GET /api/health：{ok, version}，确认某个地址跑的是 simulacra 的最便宜方式。

import { Hono } from "hono";
import { version } from "../../index";

export const healthRoutes = (): Hono => new Hono().get("/", (c) => c.json({ ok: true, version }));
