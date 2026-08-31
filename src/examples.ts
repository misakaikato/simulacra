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
