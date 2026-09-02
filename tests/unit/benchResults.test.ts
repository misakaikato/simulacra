import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULTS_TITLE, metaLines, upsertSection, writeSection } from "../../bench/results";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-bench-results-"));

describe("upsertSection", () => {
	test("creates the document with a title when the text is empty", () => {
		expect(upsertSection("", "Kernel", "| a |\n")).toBe(
			`${RESULTS_TITLE}\n\n## Kernel\n\n| a |\n`,
		);
		expect(upsertSection("  \n\n", "Kernel", "x")).toBe(`${RESULTS_TITLE}\n\n## Kernel\n\nx\n`);
	});

	test("appends a new section after the existing ones", () => {
		const first = upsertSection("", "Kernel", "k1");
		expect(upsertSection(first, "LLM", "l1")).toBe(
			`${RESULTS_TITLE}\n\n## Kernel\n\nk1\n\n## LLM\n\nl1\n`,
		);
	});

	test("replaces a section in place and keeps its neighbours", () => {
		const two = upsertSection(upsertSection("", "Kernel", "k1\nk1b"), "LLM", "l1");
		expect(upsertSection(two, "Kernel", "k2")).toBe(
			`${RESULTS_TITLE}\n\n## Kernel\n\nk2\n\n## LLM\n\nl1\n`,
		);
		expect(upsertSection(two, "LLM", "l2\n\nmore")).toBe(
			`${RESULTS_TITLE}\n\n## Kernel\n\nk1\nk1b\n\n## LLM\n\nl2\n\nmore\n`,
		);
	});

	test("does not confuse deeper headings with section boundaries", () => {
		const text = `${RESULTS_TITLE}\n\n## Kernel\n\n### detail\n\nd\n\n## LLM\n\nl\n`;
		expect(upsertSection(text, "Kernel", "k")).toBe(
			`${RESULTS_TITLE}\n\n## Kernel\n\nk\n\n## LLM\n\nl\n`,
		);
	});
});

describe("writeSection", () => {
	test("creates the file and its directory, then updates the section on rewrite", () => {
		const file = join(tempDir(), "nested", "RESULTS.md");
		expect(existsSync(file)).toBe(false);
		writeSection(file, "Kernel", "one");
		expect(readFileSync(file, "utf8")).toBe(`${RESULTS_TITLE}\n\n## Kernel\n\none\n`);
		writeSection(file, "LLM", "two");
		writeSection(file, "Kernel", "three");
		expect(readFileSync(file, "utf8")).toBe(
			`${RESULTS_TITLE}\n\n## Kernel\n\nthree\n\n## LLM\n\ntwo\n`,
		);
	});
});

describe("metaLines", () => {
	test("lists date, simulacra, bun and machine, then the extras", () => {
		const lines = metaLines({ model: "m" });
		expect(lines.map((l) => l.split(":")[0])).toEqual([
			"- date",
			"- simulacra",
			"- bun",
			"- machine",
			"- model",
		]);
		expect(lines[0]).toMatch(/^- date: \d{4}-\d{2}-\d{2}$/);
		expect(lines[2]).toBe(`- bun: ${Bun.version}`);
		expect(lines[4]).toBe("- model: m");
	});
});
