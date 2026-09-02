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
