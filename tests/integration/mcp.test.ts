import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	createLogger,
	createMcpServer,
	createRunRegistry,
	silentLogger,
	type Event,
	type InspectResult,
	type Logger,
} from "../../src/index";
import { memorySink } from "../../src/logging/sinks";

process.env.NO_PROXY ??= "127.0.0.1,localhost";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/index.ts");
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-mcp-"));

const childEnv = (): Record<string, string> => {
	const env: Record<string, string> = { NO_PROXY: "127.0.0.1,localhost" };
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	return env;
};

interface ToolReply {
	readonly isError: boolean;
	readonly text: string;
	readonly json: unknown;
}

const connect = async (logger: Logger = silentLogger): Promise<Client> => {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMcpServer({
		registry: createRunRegistry({ dataDir: tempDir(), logger }),
		logger,
	});
	await server.connect(serverTransport);
	const client = new Client({ name: "simulacra-test", version: "0.0.0" });
	await client.connect(clientTransport);
	return client;
};

const call = async (
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolReply> => {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as readonly { readonly type: string; readonly text?: string }[];
	const text = content.map((c) => c.text ?? "").join("\n");
	const at = text.indexOf("\n\n");
	let json: unknown;
	try {
		json = JSON.parse(at < 0 ? text : text.slice(at + 2));
	} catch {
		json = undefined;
	}
	return { isError: result.isError === true, text, json };
};

describe("MCP server", () => {
	test("lists tools and examples, runs a scenario, traces an agent, queries events and reads resources", async () => {
		const client = await connect();
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name).sort()).toEqual([
			"doctor",
			"get_agent_trace",
			"get_audit",
			"get_run",
			"list_examples",
			"query_events",
			"run_audit",
			"run_scenario",
		]);
		expect(tools.tools.find((t) => t.name === "run_scenario")?.inputSchema).toMatchObject({
			type: "object",
			required: ["seed"],
		});

		const examples = await call(client, "list_examples", {});
		expect(examples.isError).toBe(false);
		expect(examples.text).toContain("prisoners_dilemma");
		expect(examples.json).toMatchObject([
			{ name: "echo_chamber" },
			{ name: "prisoners_dilemma" },
		]);

		const run = await call(client, "run_scenario", {
			example: "prisoners_dilemma",
			seed: 1,
			ticks: 3,
			provider: "mock",
		});
		expect(run.isError).toBe(false);
		expect(run.text).toContain("run prisoners_dilemma-s1:0 succeeded (tick 3/3, 2 agents)");
		expect(run.text).toContain("resource: simulacra://runs/prisoners_dilemma-s1:0/result");
		expect(run.json).toMatchObject({
			runId: "prisoners_dilemma-s1:0",
			progress: { tick: 3, ticks: 3, status: "succeeded" },
			result: { status: "succeeded", integrity: { complete: true } },
		});

		const got = await call(client, "get_run", { runId: "prisoners_dilemma-s1:0" });
		expect(got.isError).toBe(false);
		expect(got.json).toEqual(run.json);
		const sameSeed = await call(client, "run_scenario", {
			example: "prisoners_dilemma",
			seed: 1,
			ticks: 1,
			provider: "mock",
		});
		expect(sameSeed.isError).toBe(true);
		expect(sameSeed.json).toMatchObject({
			error: "run prisoners_dilemma-s1:0 already exists",
			issues: [{ path: "name" }],
		});
		const reseeded = await call(client, "run_scenario", {
			example: "prisoners_dilemma",
			seed: 5,
			ticks: 1,
			provider: "mock",
		});
		expect(reseeded.isError).toBe(false);
		expect(reseeded.json).toMatchObject({ runId: "prisoners_dilemma-s5:0" });
		const named = await call(client, "run_scenario", {
			example: "prisoners_dilemma",
			name: "pd-named",
			seed: 5,
			ticks: 1,
			provider: "mock",
		});
		expect(named.isError).toBe(false);
		expect(named.json).toMatchObject({ runId: "pd-named:0", result: { seed: 5 } });
		const badName = await call(client, "run_scenario", {
			example: "prisoners_dilemma",
			name: "../x",
			seed: 6,
		});
		expect(badName.isError).toBe(true);
		expect(badName.text).toContain("name");

		const decisions = await call(client, "query_events", {
			runId: "prisoners_dilemma-s1:0",
			kind: "decision",
			limit: 3,
		});
		expect(decisions.isError).toBe(false);
		expect(decisions.text).toContain("3 events of run prisoners_dilemma-s1:0");
		const events = decisions.json as Event[];
		expect(events).toHaveLength(3);
		expect(events.every((e) => e.kind === "decision")).toBe(true);
		const first = events[0];
		expect(first?.agentId).toBeDefined();
		if (first?.agentId === undefined) return;
		const byAgent = await call(client, "query_events", {
			runId: "prisoners_dilemma-s1:0",
			agentId: first.agentId,
			tick: 1,
			limit: 1000,
		});
		expect(
			(byAgent.json as Event[]).every((e) => e.agentId === first.agentId && e.t.tick === 1),
		).toBe(true);
		const all = await call(client, "query_events", {
			runId: "prisoners_dilemma-s1:0",
			limit: 5000,
		});
		expect((all.json as Event[]).length).toBeLessThanOrEqual(1000);

		const trace = await call(client, "get_agent_trace", {
			runId: "prisoners_dilemma-s1:0",
			agentId: first.agentId,
			tick: 2,
		});
		expect(trace.isError).toBe(false);
		expect(trace.text).toContain(`agent ${first.agentId} tick 2`);
		for (const section of ["observation:", "prompt:", "decision:", "effects:", "chain:"])
			expect(trace.text).toContain(section);
		const inspected = trace.json as InspectResult;
		expect(inspected.tick).toBe(2);
		expect(inspected.chain.length).toBeGreaterThan(0);
		const latest = await call(client, "get_agent_trace", {
			runId: "prisoners_dilemma-s1:0",
			agentId: first.agentId,
		});
		expect((latest.json as InspectResult).tick).toBe(2);

		const resources = await client.listResources();
		expect(resources.resources.map((r) => r.uri)).toEqual([
			"simulacra://runs/pd-named:0/result",
			"simulacra://runs/prisoners_dilemma-s1:0/result",
			"simulacra://runs/prisoners_dilemma-s5:0/result",
		]);
		const resource = await client.readResource({
			uri: "simulacra://runs/prisoners_dilemma-s1:0/result",
		});
		const body = resource.contents[0];
		expect(body?.mimeType).toBe("application/json");
		expect(JSON.parse(body !== undefined && "text" in body ? body.text : "")).toMatchObject({
			runId: "prisoners_dilemma-s1:0",
			result: { status: "succeeded" },
		});
		await expect(
			client.readResource({ uri: "simulacra://runs/nope:0/result" }),
		).rejects.toThrow();

		const health = await call(client, "doctor", {});
		expect(health.isError).toBe(false);
		expect(health.text).toContain("ok   examples");
		const checks = health.json as readonly { readonly name: string; readonly ok: boolean }[];
		expect(checks.map((c) => c.name)).toEqual(["simulacra", "bun", "cwd writable", "examples"]);
		expect(checks.every((c) => c.ok)).toBe(true);
		await client.close();
	}, 30000);

	test("invalid or unknown inputs come back as isError with issues", async () => {
		const client = await connect();
		const badSeed = await call(client, "run_scenario", {
			example: "prisoners_dilemma",
			seed: "x",
		});
		expect(badSeed.isError).toBe(true);
		expect(badSeed.text).toContain("seed");
		const neither = await call(client, "run_scenario", { seed: 1 });
		expect(neither.isError).toBe(true);
		expect(neither.json).toMatchObject({ issues: [{ path: "scenarioYaml" }] });
		const both = await call(client, "run_scenario", {
			seed: 1,
			example: "prisoners_dilemma",
			scenarioYaml: "scenarioId: x",
		});
		expect(both.isError).toBe(true);
		const unknownExample = await call(client, "run_scenario", { seed: 1, example: "nope" });
		expect(unknownExample.isError).toBe(true);
		expect(unknownExample.json).toMatchObject({ issues: [{ path: "example" }] });
		const badYaml = await call(client, "run_scenario", {
			seed: 1,
			scenarioYaml: "scenarioId: x\nseed: 1\npopulation: { n: 0 }\n",
		});
		expect(badYaml.isError).toBe(true);
		expect(badYaml.json).toMatchObject({ issues: [{ path: "scenarioYaml.population.n" }] });
		const unknownRun = await call(client, "get_run", { runId: "nope:0" });
		expect(unknownRun.isError).toBe(true);
		expect(unknownRun.text).toContain("unknown run nope:0");
		const badKind = await call(client, "query_events", { runId: "nope:0", kind: "bogus" });
		expect(badKind.isError).toBe(true);
		expect(badKind.text).toContain("kind");
		const missingAgent = await call(client, "get_agent_trace", { runId: "nope:0" });
		expect(missingAgent.isError).toBe(true);
		expect(missingAgent.text).toContain("agentId");
		const unknownAudit = await call(client, "get_audit", { auditId: "nope" });
		expect(unknownAudit.isError).toBe(true);
		const badPlan = await call(client, "run_audit", { planYaml: "axes: [" });
		expect(badPlan.isError).toBe(true);
		expect(badPlan.json).toMatchObject({
			issues: [{ path: expect.stringContaining("planYaml") }],
		});
		await client.close();
	}, 30000);

	test("a resource variable that is not valid percent-encoding is used verbatim and logged", async () => {
		const sink = memorySink();
		const client = await connect(createLogger({ level: "warn", sinks: [sink] }));
		await expect(
			client.readResource({ uri: "simulacra://runs/%E0%A4%A/result" }),
		).rejects.toThrow("unknown run %E0%A4%A");
		const warning = sink.records.find((r) => r.level === "warn");
		expect(warning?.msg).toContain("percent-encoding");
		expect(warning?.data).toMatchObject({ raw: "%E0%A4%A" });
		await client.close();
	});

	test("runs an example audit plan to completion and exposes the report as a resource", async () => {
		const client = await connect();
		const audit = await call(client, "run_audit", {
			examplePlan: "prisoners_dilemma",
			replications: 2,
			provider: "mock",
			name: "pd",
		});
		expect(audit.isError).toBe(false);
		expect(audit.text).toContain("audit pd succeeded (20/20 runs)");
		expect(audit.text).toContain("evidenceGrade: weak");
		expect(audit.json).toMatchObject({
			auditId: "pd",
			progress: { completed: 20, total: 20, status: "succeeded" },
			report: { evidenceGrade: "weak", runs: 20 },
		});
		const duplicate = await call(client, "run_audit", {
			examplePlan: "prisoners_dilemma",
			name: "pd",
		});
		expect(duplicate.isError).toBe(true);
		expect(duplicate.json).toMatchObject({ issues: [{ path: "name" }] });
		const got = await call(client, "get_audit", { auditId: "pd" });
		expect(got.json).toEqual(audit.json);
		const resources = await client.listResources();
		expect(resources.resources.map((r) => r.uri)).toContain("simulacra://audits/pd/report");
		const report = await client.readResource({ uri: "simulacra://audits/pd/report" });
		const reportBody = report.contents[0];
		expect(
			JSON.parse(reportBody !== undefined && "text" in reportBody ? reportBody.text : ""),
		).toMatchObject({
			auditId: "pd",
			report: { evidenceGrade: "weak", pairwise: expect.any(Array) },
		});
		await client.close();
	}, 120000);

	test("simulacra mcp serves the same tools over stdio", async () => {
		const transport = new StdioClientTransport({
			command: "bun",
			args: [CLI, "mcp", "--data", tempDir()],
			cwd: ROOT,
			env: childEnv(),
			stderr: "pipe",
		});
		const client = new Client({ name: "simulacra-stdio-test", version: "0.0.0" });
		await client.connect(transport);
		try {
			const tools = await client.listTools();
			expect(tools.tools.map((t) => t.name)).toContain("run_scenario");
			const examples = await call(client, "list_examples", {});
			expect(examples.isError).toBe(false);
			expect(examples.text).toContain("echo_chamber");
			const run = await call(client, "run_scenario", {
				example: "prisoners_dilemma",
				seed: 2,
				ticks: 2,
				provider: "mock",
			});
			expect(run.isError).toBe(false);
			expect(run.text).toContain("run prisoners_dilemma-s2:0 succeeded");
		} finally {
			await client.close();
		}
	}, 30000);
});
