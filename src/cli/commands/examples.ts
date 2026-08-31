import { defineCommand } from "citty";
import { copyExample, examplePath, listExamples } from "../../index";
import { fail, print } from "./shared";

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
			for (const name of listExamples()) print(`${name}\t${examplePath(name)}`);
			return;
		}
		const copied = copyExample(args.name, args.out);
		if (!copied.ok) return fail(copied.error);
		print(`copied ${args.name} to ${copied.value}`);
	},
});
