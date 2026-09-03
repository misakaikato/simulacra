// `simulacra audit`: loads an audit plan, runs it through the harness with the kernel run
// function and prints the report summary. The JSONL log sink opens lazily so the runner's
// empty-directory check still sees an empty output directory.
// `simulacra audit`：加载审计计划，用内核运行函数交给 harness 执行并打印报告摘要。
// JSONL 日志 sink 延迟打开，使 runner 的空目录检查仍能看到空的输出目录。

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
import {
	LLM_MODES,
	fail,
	llmModeArg,
	logLevelArg,
	pluginPathsOf,
	positiveArg,
	print,
} from "./shared";

export const AUDIT_LOG_FILE = "log.jsonl";

// Opens the file on the first record so the output directory stays empty until the runner has checked it
// 首条记录才打开文件，输出目录在 runner 检查完之前保持为空
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
		"llm-mode": {
			type: "enum",
			options: [...LLM_MODES],
			description: "gateway mode for every run: live, record into llm.recordDir or replay",
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
		const mode = llmModeArg(args["llm-mode"]);
		const sink = lazyJsonlSink(join(args.out, AUDIT_LOG_FILE));
		const logger = createLogger({ level: logLevel ?? levelFromEnv(), sinks: [sink] });
		try {
			// providerOverride goes to both places on purpose: kernelRunFn applies it to every run,
			// the audit options record it in the report so a reader knows which provider produced
			// the numbers.
			// providerOverride 有意传两处：kernelRunFn 让它作用于每次运行，audit 选项把它记进报告，
			// 读者才知道数字出自哪个 provider。
			const result = await audit(
				loaded.value,
				kernelRunFn({
					plugins,
					...(args.provider === undefined ? {} : { providerOverride: args.provider }),
					...(mode === undefined ? {} : { llmOverride: { mode } }),
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
