import { cpSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { fail, print } from "./shared";

export const EXAMPLES_DIR = resolve(import.meta.dir, "../../../examples");

export const listExamples = (dir = EXAMPLES_DIR): readonly string[] =>
	readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "scenario.yaml")))
		.map((e) => e.name)
		.sort();

export const copyExample = (name: string, out: string | undefined, dir = EXAMPLES_DIR): string => {
	if (!listExamples(dir).includes(name)) return fail(`unknown example '${name}'`);
	const target = resolve(out ?? name);
	if (existsSync(target) && readdirSync(target).length > 0)
		return fail(`${target} exists and is not empty`);
	cpSync(join(dir, name), target, { recursive: true });
	return target;
};

export const examplesCommand = defineCommand({
	meta: {
		name: "examples",
		description: "List the built-in examples or copy one to a directory",
	},
	args: {
		name: { type: "positional", description: "example to copy", required: false },
		out: { type: "string", description: "destination directory (default: ./<name>)" },
	},
	run: ({ args }) => {
		if (args.name === undefined) {
			for (const name of listExamples())
				print(`${name}\t${join(EXAMPLES_DIR, name, "scenario.yaml")}`);
			return;
		}
		print(`copied ${args.name} to ${copyExample(args.name, args.out)}`);
	},
});
