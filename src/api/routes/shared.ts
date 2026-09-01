import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "hono";
import { z } from "zod";
import {
	err,
	examplePath,
	listExamples,
	ok,
	type Logger,
	type Result,
	type RunRegistry,
} from "../../index";

export interface ApiDeps {
	readonly registry: RunRegistry;
	readonly logger: Logger;
}

export interface ApiIssue {
	readonly path: string;
	readonly message: string;
}

export type ExampleFile = "scenario.yaml" | "audit.yaml";

export const DEFAULT_PAGE = 200;
export const MAX_PAGE = 1000;

export const ProviderSchema = z.enum(["mock", "llm"]);
export const nonNegativeInt = z.coerce.number().int().nonnegative();
export const positiveInt = z.coerce.number().int().positive();

export const issuesOf = (
	issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
	prefix = "",
): readonly ApiIssue[] =>
	issues.map((i) => ({
		path: [prefix, ...i.path.map(String)].filter((s) => s.length > 0).join("."),
		message: i.message,
	}));

export const badRequest = (c: Context, issues: readonly ApiIssue[]): Response =>
	c.json({ issues }, 400);

export const notFound = (c: Context, error: string): Response => c.json({ error }, 404);

export const conflict = (c: Context, error: string): Response => c.json({ error }, 409);

export const readJsonBody = async (c: Context): Promise<Result<unknown, readonly ApiIssue[]>> => {
	try {
		return ok<unknown>(await c.req.json());
	} catch {
		return err([{ path: "", message: "request body must be JSON" }]);
	}
};

export const exampleDirOf = (text: string, file: ExampleFile): string | undefined => {
	for (const name of listExamples()) {
		const dir = dirname(examplePath(name));
		const path = join(dir, file);
		if (existsSync(path) && readFileSync(path, "utf8") === text) return dir;
	}
	return undefined;
};
