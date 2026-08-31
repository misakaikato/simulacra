import { join } from "node:path";
import { defineCommand } from "citty";
import {
	AUDIT_FILE,
	REPORT_FILE,
	audit,
	createLogger,
	jsonlSink,
	kernelRunFn,
	levelFromEnv,
	loadAuditPlan,
	type AuditError,
	type LogSink,
} from "../../index";
import { fail, logLevelArg, pluginPathsOf, positiveArg, print } from "./shared";

export const AUDIT_LOG_FILE = "log.jsonl";

// Opens the file on the first record so the output directory stays empty until the runner has checked it
const lazyJsonlSink = (path: string): LogSink => {
	let inner: LogSink | undefined;
	return {
		write(record) {
			inner ??= jsonlSink(path);
			inner.write(record);
		},
		close() {
			inner?.close();
		},
	};
};

const describeAuditError = (e: AuditError): string => {
	switch (e.kind) {
		case "UnknownOverride":
			return `unknown axis target '${e.path}'`;
		case "InvalidOverride":
			return `axis target '${e.path}' produced an invalid scenario: ${e.issues
				.map((i) => `${i.path.join(".")} ${i.message}`)
				.join("; ")}`;
		case "OutputDirNotEmpty":
			return `output directory ${e.path} is not empty; pass --overwrite to replace it`;
	}
};

export const auditCommand = defineCommand({
	meta: {
		name: "audit",
		description: "Run an audit plan: conditions x replications, statistics and an HTML report",
	},
	args: {
		plan: { type: "positional", description: "path to audit.yaml", required: true },
		out: { type: "string", description: "output directory", required: true },
		replications: { type: "string", description: "override the plan's replications" },
		concurrency: { type: "string", description: "override the plan's concurrency" },
		provider: {
			type: "enum",
			options: ["mock", "llm"],
			description: "replace every provider with this kind",
		},
		"include-incomplete": {
			type: "boolean",
			description: "keep runs with integrity.complete=false in the statistics",
		},
		plugin: { type: "string", description: "module exporting register(registry); repeatable" },
		overwrite: { type: "boolean", description: "replace a non-empty output directory" },
		"log-level": { type: "string", description: "trace, debug, info, warn or error" },
	},
	run: async ({ args, rawArgs }) => {
		const loaded = loadAuditPlan(args.plan);
		if (!loaded.ok)
			return fail(
				`${args.plan}: ${loaded.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
			);
		const plugins = pluginPathsOf(rawArgs);
		const replications = positiveArg("replications", args.replications);
		const concurrency = positiveArg("concurrency", args.concurrency);
		const logLevel = logLevelArg(args["log-level"]);
		const sink = lazyJsonlSink(join(args.out, AUDIT_LOG_FILE));
		const logger = createLogger({ level: logLevel ?? levelFromEnv(), sinks: [sink] });
		try {
			const result = await audit(
				loaded.value,
				kernelRunFn({
					plugins,
					...(args.provider === undefined ? {} : { providerOverride: args.provider }),
					...(logLevel === undefined ? {} : { logLevel }),
				}),
				args.out,
				{
					logger,
					overwrite: args.overwrite === true,
					includeIncomplete: args["include-incomplete"] === true,
					...(args.provider === undefined ? {} : { providerOverride: args.provider }),
					...(replications === undefined ? {} : { replications }),
					...(concurrency === undefined ? {} : { concurrency }),
				},
			);
			if (!result.ok) return fail(describeAuditError(result.error));
			const report = result.value;
			const i = report.integritySummary;
			print(`audit ${report.planHash.slice(0, 12)} ${report.evidenceGrade}`);
			print(`conditions: ${report.conditions.length}`);
			print(
				`runs: ${report.runs.length} (failed: ${i.failed ?? 0}, incomplete: ${i.incomplete ?? 0}, excluded: ${i.excluded ?? 0})`,
			);
			print(`pairwise: ${report.pairwise.length}`);
			print(`evidenceGrade: ${report.evidenceGrade}`);
			print(`audit: ${join(args.out, AUDIT_FILE)}`);
			print(`report: ${join(args.out, REPORT_FILE)}`);
		} finally {
			sink.close();
		}
	},
});
