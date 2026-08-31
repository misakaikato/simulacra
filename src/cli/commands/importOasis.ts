import { defineCommand } from "citty";
import { createDefaultRegistry, importOasis } from "../../index";
import { fail, print } from "./shared";

export const metricsArg = (value: string | undefined): readonly string[] =>
	value === undefined
		? []
		: value
				.split(",")
				.map((m) => m.trim())
				.filter((m) => m.length > 0);

export const importOasisCommand = defineCommand({
	meta: {
		name: "import-oasis",
		description: "Import an OASIS SQLite database as a run: events.sqlite plus result.json",
	},
	args: {
		db: {
			type: "positional",
			description: "path to the OASIS SQLite database",
			required: true,
		},
		out: { type: "string", description: "run directory to write", required: true },
		metrics: { type: "string", description: "comma-separated metric kinds to compute" },
		overwrite: { type: "boolean", description: "replace a non-empty output directory" },
	},
	run: ({ args }) => {
		const imported = importOasis(
			args.db,
			args.out,
			metricsArg(args.metrics),
			createDefaultRegistry(),
			{
				overwrite: args.overwrite === true,
			},
		);
		if (!imported.ok) return fail(imported.error);
		const s = imported.value;
		print(`imported ${args.db} into ${s.outDir}`);
		print(`agents: ${s.agents} posts: ${s.posts} edges: ${s.edges}`);
		print(`observations: ${s.observations}`);
		print(`decisions: ${s.decisions}`);
		print(`parseFailures: ${s.parseFailures}`);
		const metrics = Object.entries(s.result.metrics)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		print(`metrics: ${metrics.length === 0 ? "none" : metrics}`);
		if (s.result.status === "failed")
			return fail(`import failed: ${s.result.failure?.message ?? "unknown"}`);
	},
});
