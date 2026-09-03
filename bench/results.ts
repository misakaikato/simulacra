// Writes bench tables into bench/RESULTS.md by section: upsertSection replaces the
// "## <heading>" block in place (or appends it), so the kernel and LLM benches update
// independently, and metaLines stamps date, versions and machine on every table.
// 按节把基准表格写进 bench/RESULTS.md：upsertSection 原地替换（或追加）"## <heading>" 块，
// 内核与 LLM 基准可以各自独立更新；metaLines 为每张表盖上日期、版本与机器。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { version } from "../src/index";

export const RESULTS_FILE = join(import.meta.dir, "RESULTS.md");
export const RESULTS_TITLE = "# Bench results";

const SECTION_PREFIX = "## ";

const finish = (lines: readonly string[]): string => `${lines.join("\n").trimEnd()}\n`;

export const upsertSection = (text: string, heading: string, body: string): string => {
	const existing = text.trimEnd();
	const lines = existing.length === 0 ? [RESULTS_TITLE] : existing.split("\n");
	const marker = `${SECTION_PREFIX}${heading}`;
	const section = [marker, "", body.trim(), ""];
	const start = lines.indexOf(marker);
	if (start < 0) return finish([...lines, "", ...section]);
	const next = lines.findIndex((line, i) => i > start && line.startsWith(SECTION_PREFIX));
	const end = next < 0 ? lines.length : next;
	return finish([...lines.slice(0, start), ...section, ...lines.slice(end)]);
};

export const writeSection = (file: string, heading: string, body: string): void => {
	const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, upsertSection(existing, heading, body));
};

// The CPU brand string on macOS, arch and platform elsewhere: enough to tell two machines apart
// when comparing rows.
// macOS 上取 CPU 品牌字符串，其它平台取架构与平台名：对比行时足以区分两台机器。
export const machineModel = (): string => {
	if (process.platform === "darwin") {
		const proc = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"]);
		const text = proc.success ? proc.stdout.toString().trim() : "";
		if (text.length > 0) return text;
	}
	return `${process.arch} (${process.platform})`;
};

export const metaLines = (extra: Readonly<Record<string, string>> = {}): readonly string[] =>
	Object.entries({
		date: new Date().toISOString().slice(0, 10),
		simulacra: version,
		bun: Bun.version,
		machine: machineModel(),
		...extra,
	}).map(([key, value]) => `- ${key}: ${value}`);
