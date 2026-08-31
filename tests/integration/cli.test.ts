import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINTS_DIR } from "../../src/core/runDir";
import { eventLogPath, openSqliteEventLog } from "../../src/core/log";
import { doctor } from "../../src/index";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/index.ts");
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-cli-"));

interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const cliEnv = (env: Readonly<Record<string, string>>): Record<string, string | undefined> => ({
	...process.env,
	NO_PROXY: "127.0.0.1,localhost",
	...env,
});

const cli = (args: readonly string[], env: Readonly<Record<string, string>> = {}): Ran => {
	const proc = Bun.spawnSync(["bun", CLI, ...args], {
		cwd: ROOT,
		env: cliEnv(env),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode,
		stdout: new TextDecoder().decode(proc.stdout),
		stderr: new TextDecoder().decode(proc.stderr),
	};
};

const cliAsync = async (
	args: readonly string[],
	env: Readonly<Record<string, string>> = {},
): Promise<Ran> => {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd: ROOT,
		env: cliEnv(env),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
};

const lineValue = (out: string, key: string): string | undefined =>
	out
		.split("\n")
		.find((l) => l.startsWith(`${key}: `))
		?.slice(key.length + 2);

const worldHashAt = (dir: string, tick: number): string =>
	(
		JSON.parse(readFileSync(join(dir, CHECKPOINTS_DIR, String(tick), "meta.json"), "utf8")) as {
			worldHash: string;
		}
	).worldHash;

const ECHO = "examples/echo_chamber/scenario.yaml";
const PD = "examples/prisoners_dilemma/scenario.yaml";
const PD_PLUGIN = "examples/prisoners_dilemma/rules.ts";

describe("simulacra CLI", () => {
	const a = tempDir();
	const b = tempDir();
	const c = tempDir();

	test("run twice with the same seed under mock gives the same digest", () => {
		const ra = cli(["run", ECHO, "--seed", "7", "--provider", "mock", "--out", a]);
		expect(ra.stderr).toBe("");
		expect(ra.code).toBe(0);
		expect(ra.stdout).toContain("run echo_chamber:0 succeeded");
		expect(ra.stdout).toContain("complete=true");
		const rb = cli(["run", ECHO, "--seed", "7", "--provider", "mock", "--out", b]);
		expect(rb.code).toBe(0);
		const da = cli(["digest", a]);
		const db = cli(["digest", b]);
		expect(da.code).toBe(0);
		expect(da.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
		expect(da.stdout).toBe(db.stdout);
		expect(lineValue(ra.stdout, "digest")).toBe(da.stdout.trim());
	});

	test("replay to tick 10 matches the tick 10 checkpoint", () => {
		const r = cli(["replay", a, "--to-tick", "10"]);
		expect(r.code).toBe(0);
		expect(lineValue(r.stdout, "worldHash")).toBe(worldHashAt(a, 10));
		expect(lineValue(r.stdout, "tick")).toBe("10");
		expect(lineValue(r.stdout, "from")).toBe("checkpoint 0");
		const negative = cli(["replay", a, "--to-tick", "-1"]);
		expect(negative.code).toBe(1);
		expect(negative.stderr).toContain("must not be negative");
		const beyond = cli(["replay", a, "--to-tick", "99"]);
		expect(beyond.code).toBe(0);
		expect(lineValue(beyond.stdout, "tick")).toBe("15");
		expect(lineValue(beyond.stdout, "requested")).toBe("99 (run ends at tick 15)");
	});

	test("resume from the tick 5 checkpoint reaches the same tick 10 world hash", () => {
		const r = cli(["resume", join(a, CHECKPOINTS_DIR, "5"), "--ticks", "5", "--out", c]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(existsSync(join(c, CHECKPOINTS_DIR, "10", "meta.json"))).toBe(true);
		expect(worldHashAt(c, 10)).toBe(worldHashAt(a, 10));
		const d = tempDir();
		const direct10 = cli([
			"run",
			ECHO,
			"--seed",
			"7",
			"--provider",
			"mock",
			"--ticks",
			"10",
			"--out",
			d,
		]);
		expect(direct10.code).toBe(0);
		expect(lineValue(r.stdout, "digest")).toBe(cli(["digest", d]).stdout.trim());
		const replayed = cli(["replay", c, "--to-tick", "10"]);
		expect(replayed.code).toBe(0);
		expect(lineValue(replayed.stdout, "worldHash")).toBe(worldHashAt(a, 10));
		expect(lineValue(replayed.stdout, "from")).toBe("checkpoint 5");
		const early = cli(["replay", c, "--to-tick", "3"]);
		expect(early.code).toBe(1);
		expect(early.stderr).toContain("no checkpoint at or before tick 3");
	});

	test("inspect prints observation, prompt, decision and effects", () => {
		const log = openSqliteEventLog(eventLogPath(a));
		const post = log
			.query({ kind: ["decision"] })
			.find((e) => e.kind === "decision" && e.payload.action === "post");
		log.close();
		expect(post?.agentId).toBeDefined();
		if (post?.agentId === undefined) return;
		const r = cli(["inspect", a, "--agent", post.agentId, "--tick", String(post.t.tick)]);
		expect(r.code).toBe(0);
		for (const section of ["observation:", "prompt:", "decision:", "effects: 1"])
			expect(r.stdout).toContain(section);
		expect(r.stdout).toContain(`action=post`);
		expect(r.stdout).toContain("create post");
		const byEvent = cli(["inspect", a, "--agent", post.agentId, "--event", post.eventId]);
		expect(byEvent.code).toBe(0);
		expect(byEvent.stdout).toContain(post.eventId);
		const missing = cli(["inspect", a, "--agent", "nobody"]);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("error: agent nobody has no decision");
	});

	test("prisoners dilemma loads its declared plugin, --plugin appends, and both are deterministic", () => {
		const x = tempDir();
		const y = tempDir();
		const z = tempDir();
		const args = [PD, "--seed", "1", "--provider", "mock"];
		const rx = cli(["run", ...args, "--plugin", PD_PLUGIN, "--out", x]);
		expect(rx.stderr).toBe("");
		expect(rx.code).toBe(0);
		expect(rx.stdout).toContain("run prisoners_dilemma:0 succeeded");
		expect(rx.stdout).toContain("cooperationRate=");
		expect(rx.stdout).toContain("rejectedActions=0");
		const ry = cli(["run", ...args, "--plugin", PD_PLUGIN, "--out", y]);
		expect(ry.code).toBe(0);
		const without = cli(["run", ...args, "--out", z]);
		expect(without.stderr).toBe("");
		expect(without.code).toBe(0);
		const dx = cli(["digest", x]).stdout;
		expect(cli(["digest", y]).stdout).toBe(dx);
		expect(cli(["digest", z]).stdout).toBe(dx);
		for (const bad of [
			["run", ...args, "--out", tempDir(), "--plugin"],
			["run", ...args, "--plugin", "--out", tempDir()],
			["run", ...args, "--plugin=", "--out", tempDir()],
		]) {
			const r = cli(bad);
			expect(r.code).toBe(1);
			expect(r.stderr).toContain("error: missing plugin path");
		}
		const broken = cli(["run", ...args, "--plugin", "nope.ts", "--out", tempDir()]);
		expect(broken.code).toBe(1);
		expect(broken.stderr).toContain("PluginLoad: plugin nope.ts");
	});

	test("failures exit non-zero with an error line, and --log-level debug adds the stack", () => {
		const missing = cli(["run", "nope.yaml", "--out", tempDir()]);
		expect(missing.code).toBe(1);
		expect(missing.stderr.startsWith("error: nope.yaml: file not found")).toBe(true);
		expect(missing.stderr.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
		const debug = cli(["run", "nope.yaml", "--out", tempDir(), "--log-level", "debug"]);
		expect(debug.code).toBe(1);
		expect(debug.stderr).toContain("    at ");
		const nonEmpty = cli(["run", ECHO, "--provider", "mock", "--out", a]);
		expect(nonEmpty.code).toBe(1);
		expect(nonEmpty.stderr).toContain("OutputDirNotEmpty");
		const unknown = cli(["frobnicate"]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("error:");
	});

	test("examples lists and copies built-in examples", () => {
		const list = cli(["examples"]);
		expect(list.code).toBe(0);
		expect(list.stdout).toContain("echo_chamber");
		expect(list.stdout).toContain("prisoners_dilemma");
		const dest = join(tempDir(), "pd-copy");
		const copy = cli(["examples", "prisoners_dilemma", "--out", dest]);
		expect(copy.code).toBe(0);
		expect(existsSync(join(dest, "scenario.yaml"))).toBe(true);
		expect(existsSync(join(dest, "rules.ts"))).toBe(true);
		expect(cli(["examples", "nope", "--out", tempDir()]).code).toBe(1);
	});

	test("help and version", () => {
		expect(cli(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		const help = cli(["--help"]);
		expect(help.code).toBe(0);
		expect(`${help.stdout}${help.stderr}`).toContain("run");
	});
});

describe("doctor", () => {
	test("environment checks pass without --llm", async () => {
		const checks = await doctor({ llm: false, cwd: tempDir() });
		expect(checks.ok).toBe(true);
		if (!checks.ok) return;
		expect(checks.value.map((c) => c.name)).toEqual([
			"simulacra",
			"bun",
			"cwd writable",
			"examples",
		]);
		expect(checks.value.every((c) => c.ok)).toBe(true);
		const r = cli(["doctor"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("ok   examples");
	});

	test("--llm without a key fails; against a fake endpoint it probes structured output, concurrency and cache", async () => {
		const noKeyResult = await doctor({ llm: true, env: {}, cwd: tempDir() });
		expect(noKeyResult.ok).toBe(false);
		if (!noKeyResult.ok) expect(noKeyResult.error).toContain("SIMULACRA_LLM_API_KEY");
		let calls = 0;
		let maxInFlight = 0;
		let inFlight = 0;
		const authorizations = new Set<string | null>();
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				calls += 1;
				authorizations.add(req.headers.get("authorization"));
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Bun.sleep(30);
				inFlight -= 1;
				const body = (await req.json()) as { response_format?: unknown };
				const content = body.response_format === undefined ? "ready" : '{"ok": true}';
				return Response.json({
					model: "fake",
					choices: [{ message: { content } }],
					usage: {
						prompt_tokens: 120,
						completion_tokens: 2,
						prompt_tokens_details: { cached_tokens: calls > 1 ? 64 : 0 },
					},
				});
			},
		});
		try {
			const baseUrl = `http://127.0.0.1:${server.port}/v1`;
			const probed = await doctor({
				llm: true,
				baseUrl,
				model: "fake",
				cwd: tempDir(),
				env: { SIMULACRA_LLM_API_KEY: "test-key" },
			});
			expect(probed.ok).toBe(true);
			if (!probed.ok) return;
			expect(authorizations).toEqual(new Set(["Bearer test-key"]));
			const byName = Object.fromEntries(probed.value.map((c) => [c.name, c]));
			expect(byName.endpoint?.ok).toBe(true);
			expect(byName.json_schema?.ok).toBe(true);
			expect(byName.concurrency?.ok).toBe(true);
			expect(byName.cached_tokens?.detail).toContain("reported on");
			expect(byName.calls?.ok).toBe(true);
			expect(calls).toBeLessThanOrEqual(6);
			expect(calls).toBe(5);
			expect(maxInFlight).toBeGreaterThan(1);
			const r = await cliAsync(
				["doctor", "--llm", "--base-url", baseUrl, "--model", "fake"],
				{
					SIMULACRA_LLM_API_KEY: "test-key",
				},
			);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("ok   json_schema");
			expect(calls).toBe(10);
			const noKey = await cliAsync(["doctor", "--llm", "--base-url", baseUrl], {
				SIMULACRA_LLM_API_KEY: "",
			});
			expect(noKey.code).toBe(1);
			expect(noKey.stderr).toContain("SIMULACRA_LLM_API_KEY");
		} finally {
			server.stop(true);
		}
	}, 20000);
});
