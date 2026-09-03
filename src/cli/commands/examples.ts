// `simulacra examples`: without a name lists the built-in examples with their scenario paths;
// with a name copies that example directory (scenario, plan, recordings) to --out or ./<name>.
// `simulacra examples`：不带名字时列出内置示例及其场景路径；带名字时把该示例目录
//（场景、计划、录制）复制到 --out 或 ./<name>。

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
