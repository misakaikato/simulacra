import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { examplePath, listExamples, type Example } from "../../index";

export const examplesRoutes = (): Hono =>
	new Hono().get("/", (c) => {
		const examples: Example[] = listExamples().map((name) => ({
			name,
			yaml: readFileSync(examplePath(name), "utf8"),
		}));
		return c.json(examples);
	});
