import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { examplePath, listExamples } from "../../index";

export const examplesRoutes = (): Hono =>
	new Hono().get("/", (c) =>
		c.json(
			listExamples().map((name) => ({
				name,
				yaml: readFileSync(examplePath(name), "utf8"),
			})),
		),
	);
