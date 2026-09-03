#!/usr/bin/env bun
// Entry point of the simulacra CLI: wires the citty sub-commands, answers --version and
// --help, and turns any thrown error into exit code 1 plus one `error:` line (the stack is
// printed only at debug or trace level). Like every tool it imports only src/index.
// simulacra CLI 入口：装配 citty 子命令，应答 --version 与 --help，把任何抛出的错误变成
// 退出码 1 加一行 `error:`（只在 debug 或 trace 级别打印栈）。与所有入口一样只导入 src/index。

import { defineCommand, runCommand, runMain } from "citty";
import { version } from "../index";
import { auditCommand } from "./commands/audit";
import { digestCommand } from "./commands/digest";
import { doctorCommand } from "./commands/doctor";
import { examplesCommand } from "./commands/examples";
import { importOasisCommand } from "./commands/importOasis";
import { inspectCommand } from "./commands/inspect";
import { mcpCommand } from "./commands/mcp";
import { replayCommand } from "./commands/replay";
import { reportCommand } from "./commands/report";
import { resumeCommand } from "./commands/resume";
import { runCommand as runScenarioCommand } from "./commands/run";
import { serveCommand } from "./commands/serve";
import { pluginPathsOf, wantsDebug } from "./commands/shared";

const subCommands = {
	run: runScenarioCommand,
	replay: replayCommand,
	resume: resumeCommand,
	inspect: inspectCommand,
	digest: digestCommand,
	audit: auditCommand,
	report: reportCommand,
	"import-oasis": importOasisCommand,
	doctor: doctorCommand,
	examples: examplesCommand,
	serve: serveCommand,
	mcp: mcpCommand,
};

const main = defineCommand({
	meta: {
		name: "simulacra",
		version,
		description: "Typed, event-sourced LLM social simulation kernel",
	},
	subCommands,
});

// Version and help are answered before any command runs, so neither loads a scenario or a
// plugin; -h is normalised to --help before citty renders the usage. pluginPathsOf runs
// first so a malformed --plugin fails through the same error path as a command failure.
// 版本与帮助在任何命令执行前应答，两者都不会加载场景或插件；-h 在 citty 渲染用法前统一成 --help。
// pluginPathsOf 先跑一遍，写坏的 --plugin 走与命令失败相同的错误通路。
const cli = async (rawArgs: readonly string[]): Promise<number> => {
	if (rawArgs.includes("--version") || rawArgs[0] === "-v") {
		console.log(version);
		return 0;
	}
	if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
		await runMain(main, { rawArgs: [...rawArgs.filter((a) => a !== "-h"), "--help"] });
		return 0;
	}
	try {
		pluginPathsOf(rawArgs);
		await runCommand(main, { rawArgs: [...rawArgs] });
		return 0;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(`error: ${message}`);
		if (wantsDebug(rawArgs) && e instanceof Error && e.stack !== undefined)
			console.error(e.stack);
		return 1;
	}
};

process.exit(await cli(process.argv.slice(2)));
