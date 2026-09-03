// Locates the built-in examples shipped under examples/: a directory counts as an example when
// it holds scenario.yaml. Used by the CLI, the API, the MCP tools and doctor.
// 定位随包发布在 examples/ 下的内置示例：目录里有 scenario.yaml 即算一个示例。
// CLI、API、MCP 工具与 doctor 都用它。

import { cpSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { err, ok } from "./core/result";
import type { Result } from "./core/types";

export const EXAMPLES_DIR = resolve(import.meta.dir, "../examples");
export const SCENARIO_YAML = "scenario.yaml";

export const listExamples = (dir = EXAMPLES_DIR): readonly string[] =>
	existsSync(dir)
		? readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, SCENARIO_YAML)))
				.map((e) => e.name)
				.sort()
		: [];

export const examplePath = (name: string, dir = EXAMPLES_DIR): string =>
	join(dir, name, SCENARIO_YAML);

// The whole directory is copied so the audit plan and recordings travel with the scenario; a
// non-empty target is refused rather than merged into.
// 整个目录一起复制，审计计划与录制随场景同行；非空目标直接拒绝而不是合并进去。
export const copyExample = (
	name: string,
	out: string | undefined,
	dir = EXAMPLES_DIR,
): Result<string, string> => {
	if (!listExamples(dir).includes(name)) return err(`unknown example '${name}'`);
	const target = resolve(out ?? name);
	if (existsSync(target) && readdirSync(target).length > 0)
		return err(`${target} exists and is not empty`);
	cpSync(join(dir, name), target, { recursive: true });
	return ok(target);
};
