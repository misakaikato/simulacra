#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from "citty";
import { version } from "../index";
import { auditCommand } from "./commands/audit";
import { digestCommand } from "./commands/digest";
import { doctorCommand } from "./commands/doctor";
import { examplesCommand } from "./commands/examples";
import { importOasisCommand } from "./commands/importOasis";
import { inspectCommand } from "./commands/inspect";
import { replayCommand } from "./commands/replay";
import { reportCommand } from "./commands/report";
import { resumeCommand } from "./commands/resume";
import { runCommand as runScenarioCommand } from "./commands/run";
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
};

const main = defineCommand({
	meta: {
		name: "simulacra",
		version,
		description: "Typed, event-sourced LLM social simulation kernel",
	},
	subCommands,
});

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
