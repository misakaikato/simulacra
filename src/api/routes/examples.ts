// GET /api/examples: the built-in example names with their scenario.yaml text, which the GUI's
// new-run form offers as starting points.
// GET /api/examples：内置示例名及其 scenario.yaml 文本，GUI 的新建运行表单以它们为起点。

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
