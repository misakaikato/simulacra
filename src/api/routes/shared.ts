// Helpers shared by the route modules: the ApiDeps bag, page limits, coerced query-number
// schemas, the issues[] and error envelopes, JSON body reading and the lookup that maps a
// POSTed YAML text back to the built-in example directory it was copied from.
// 各路由模块共用的辅助：ApiDeps、分页上限、查询参数数字转换 schema、issues[] 与 error 信封、
// JSON 请求体读取，以及把 POST 的 YAML 文本映射回其所来自的内置示例目录的查找。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "hono";
import { z } from "zod";
import {
	err,
	examplePath,
	listExamples,
	ok,
	type ApiIssue,
	type Logger,
	type Result,
	type RunRegistry,
} from "../../index";

export interface ApiDeps {
	readonly registry: RunRegistry;
	readonly logger: Logger;
}

export type ExampleFile = "scenario.yaml" | "audit.yaml";

export const DEFAULT_PAGE = 200;
export const MAX_PAGE = 1000;

export const nonNegativeInt = z.coerce.number().int().nonnegative();
export const positiveInt = z.coerce.number().int().positive();

// zod paths are arrays; the contract flattens them to dotted strings, with an optional prefix
// naming the body field (scenario, plan) that a nested parser validated.
// zod 的 path 是数组；契约把它压成点分字符串，可选前缀指明嵌套解析器校验的是哪个请求体字段
//（scenario、plan）。
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

// A POSTed document identical to a built-in example resolves its relative paths (plugins,
// recordings) against that example's directory; anything else resolves against the server cwd.
// 与内置示例逐字相同的 POST 文档，其相对路径（插件、录制）按该示例目录解析；
// 其它按服务进程的 cwd 解析。
export const exampleDirOf = (text: string, file: ExampleFile): string | undefined => {
	for (const name of listExamples()) {
		const dir = dirname(examplePath(name));
		const path = join(dir, file);
		if (existsSync(path) && readFileSync(path, "utf8") === text) return dir;
	}
	return undefined;
};
