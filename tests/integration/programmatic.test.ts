import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const DIR = resolve(ROOT, "examples/programmatic");

const run = (file: string) => {
	const proc = Bun.spawnSync(["bun", resolve(DIR, file)], {
		cwd: ROOT,
		env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
};

const expectations: Readonly<Record<string, readonly string[]>> = {
	"01-run-and-inspect.ts": ["status succeeded", "activation", "decision"],
	"02-custom-plugin.ts": ["status succeeded", "complete"],
	"03-audit.ts": ["evidence weak", "most sensitive axis", "self-contained HTML"],
	"04-replay-recordings.ts": ["llmCalls 0", "digests equal: true"],
	"05-cohort-scale.ts": ["complete true"],
};

describe("examples/programmatic", () => {
	const files = readdirSync(DIR)
		.filter((f) => f.endsWith(".ts"))
		.sort();
	test("every example program is listed in the expectations", () => {
		expect(files).toEqual(Object.keys(expectations).sort());
	});
	for (const [file, markers] of Object.entries(expectations)) {
		test(`${file} runs and prints ${markers.join(", ")}`, () => {
			const r = run(file);
			expect(r.err).toBe("");
			expect(r.code).toBe(0);
			for (const marker of markers) expect(r.out).toContain(marker);
		}, 120_000);
	}
});
