import { Hono } from "hono";
import { version } from "../../index";

export const healthRoutes = (): Hono => new Hono().get("/", (c) => c.json({ ok: true, version }));
