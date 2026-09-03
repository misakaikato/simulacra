// Layout of a run directory: scenario.json, events.sqlite and checkpoints/<tick>. The helpers
// here open those files; they know nothing about running a simulation.
// run 目录的布局：scenario.json、events.sqlite 与 checkpoints/<tick>。这里的辅助函数只负责打开这些
// 文件，不涉及模拟的运行。

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { eventLogPath, openSqliteEventLog } from "./log";
import type { EventLog } from "./protocols";
import { err, ok } from "./result";
import { parseScenario } from "./scenario";
import type { Result, Scenario } from "./types";

export const SCENARIO_FILE = "scenario.json";
export const CHECKPOINTS_DIR = "checkpoints";

export const checkpointDirOf = (runDir: string, tick: number): string =>
	join(runDir, CHECKPOINTS_DIR, String(tick));

export const runDirOfCheckpoint = (checkpointDir: string): string =>
	dirname(dirname(resolve(checkpointDir)));

// Numeric sort, so tick 10 follows tick 9 and replay picks the right latest checkpoint.
// 按数值排序，tick 10 排在 tick 9 之后，回放才能选中正确的最近检查点。
export const checkpointTicks = (runDir: string): readonly number[] => {
	const dir = join(runDir, CHECKPOINTS_DIR);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
		.map((e) => Number(e.name))
		.sort((a, b) => a - b);
};

export const writeRunScenario = (runDir: string, scenario: Scenario): void => {
	writeFileSync(join(runDir, SCENARIO_FILE), JSON.stringify(scenario, null, "\t"));
};

export const readRunScenario = (runDir: string): Result<Scenario, string> => {
	const path = join(runDir, SCENARIO_FILE);
	if (!existsSync(path)) return err(`${path} does not exist; is ${runDir} a run directory?`);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return err(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = parseScenario(raw);
	if (!parsed.ok)
		return err(
			`${path}: ${parsed.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
		);
	return ok(parsed.value);
};

export const openRunLog = (runDir: string): Result<EventLog, string> => {
	const path = eventLogPath(runDir);
	if (!existsSync(path)) return err(`${path} does not exist; is ${runDir} a run directory?`);
	return ok(openSqliteEventLog(path));
};

export const withRunLog = <T>(
	runDir: string,
	fn: (log: EventLog) => Result<T, string>,
): Result<T, string> => {
	const opened = openRunLog(runDir);
	if (!opened.ok) return opened;
	try {
		return fn(opened.value);
	} finally {
		opened.value.close();
	}
};

export const digestRun = (runDir: string): Result<string, string> =>
	withRunLog(runDir, (log) => ok(log.digest()));
