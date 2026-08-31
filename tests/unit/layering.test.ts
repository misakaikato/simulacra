import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CORE = join(import.meta.dir, "../../src/core");
const FORBIDDEN =
	/from\s+"\.\.\/(agents|providers|modules|policies|metrics|instruments|harness|adapters|cli|api|mcp|llm)\//;

describe("layering", () => {
	test("src/core imports no top-level directory other than logging", () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith(".ts") && FORBIDDEN.test(readFileSync(path, "utf8")))
					offenders.push(path);
			}
		};
		walk(CORE);
		expect(offenders).toEqual([]);
	});
});
