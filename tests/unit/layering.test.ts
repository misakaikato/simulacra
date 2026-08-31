import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../src");
const CORE = join(SRC, "core");
const ENTRIES = ["cli", "api", "mcp"];
const PUBLIC_ENTRY = new Set(["../index", "../../index"]);
const FORBIDDEN =
	/from\s+"\.\.\/(agents|providers|modules|policies|metrics|instruments|harness|adapters|cli|api|mcp|llm)\//;
const UPWARD_IMPORT = /from\s+"(\.\.\/[^"]*)"/g;

const sourceFiles = (dir: string): readonly string[] => {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
};

describe("layering", () => {
	test("src/core imports no top-level directory other than logging", () => {
		const offenders = sourceFiles(CORE).filter((path) =>
			FORBIDDEN.test(readFileSync(path, "utf8")),
		);
		expect(offenders).toEqual([]);
	});

	test("entry directories (cli, api, mcp) import only the public index", () => {
		const offenders: string[] = [];
		for (const name of ENTRIES) {
			const dir = join(SRC, name);
			if (!existsSync(dir)) continue;
			for (const path of sourceFiles(dir)) {
				for (const match of readFileSync(path, "utf8").matchAll(UPWARD_IMPORT)) {
					const target = match[1] ?? "";
					if (!PUBLIC_ENTRY.has(target)) offenders.push(`${path}: ${target}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
