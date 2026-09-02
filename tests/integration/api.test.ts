import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import {
	GUI_DIST_DIR,
	RESULT_FILE,
	SCENARIO_FILE,
	createApp,
	createRunRegistry,
	loadAuditPlan,
	parseScenario,
	silentLogger,
	type AgentRow,
	type AuditSummary,
	type Event,
	type Example,
	type GraphSnapshot,
	type JsonObject,
	type MetricSeries,
	type RunRegistry,
	type RunSummary,
	type Scenario,
} from "../../src/index";
import { SLOW_KIND } from "../fixtures/slow_plugin";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/index.ts");
const SLOW_PLUGIN = join(ROOT, "tests/fixtures/slow_plugin.ts");
const PD_AUDIT = join(ROOT, "examples/prisoners_dilemma/audit.yaml");
const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-api-"));

process.env.NO_PROXY ??= "127.0.0.1,localhost";

const scenarioOf = (overrides: JsonObject = {}): Scenario => {
	const parsed = parseScenario({
		scenarioId: "api",
		seed: 3,
		population: {
			n: 200,
			fields: [
				{
					name: "name",
					dtype: "str",
					sampling: { kind: "choice", choices: ["Ann", "Bob"] },
				},
				{ name: "stance", dtype: "f64", sampling: { kind: "range", min: -1, max: 1 } },
				{
					name: "secret",
					dtype: "str",
					private: true,
					sampling: { kind: "value", value: "hidden" },
				},
			],
		},
		modules: [
			{ kind: "socialGraph", options: { meanDegree: 2 } },
			{ kind: "feed", options: { size: 3, recommender: "followingFirst" } },
		],
		executors: [
			{
				kind: "focal",
				name: "people",
				options: {
					provider: "main",
					components: [
						{ kind: "persona" },
						{ kind: "feedObservation", options: { size: 3 } },
					],
				},
			},
		],
		providers: { main: { kind: "mock" } },
		instruments: [{ kind: "actionShare", name: "postShare", options: { action: "post" } }],
		steps: [{ kind: "run", ticks: 4 }],
		...overrides,
	});
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
	return parsed.value;
};

const slowScenario = (): Scenario =>
	scenarioOf({
		scenarioId: "slow",
		plugins: [SLOW_PLUGIN],
		population: { n: 5 },
		providers: { main: { kind: SLOW_KIND } },
		steps: [{ kind: "run", ticks: 6 }],
	});

const json = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

const until = async (check: () => Promise<boolean>, timeoutMs = 20000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(25);
	}
};

const waitDone = async (app: Hono, id: string): Promise<RunSummary> => {
	let summary: RunSummary | undefined;
	await until(async () => {
		summary = (await (
			await app.request(`/api/runs/${encodeURIComponent(id)}`)
		).json()) as RunSummary;
		return summary.progress.status !== "running";
	});
	if (summary === undefined) throw new Error("unreachable");
	return summary;
};

const waitAudit = async (app: Hono, id: string): Promise<AuditSummary> => {
	let summary: AuditSummary | undefined;
	await until(async () => {
		summary = (await (
			await app.request(`/api/audits/${encodeURIComponent(id)}`)
		).json()) as AuditSummary;
		return summary.progress.status !== "running";
	}, 60000);
	if (summary === undefined) throw new Error("unreachable");
	return summary;
};

const frames = (text: string): readonly { readonly event: string; readonly data: string }[] =>
	text
		.split("\n\n")
		.filter((f) => f.length > 0)
		.map((frame) => {
			const lines = frame.split("\n");
			const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
			const data = lines
				.filter((l) => l.startsWith("data: "))
				.map((l) => l.slice(6))
				.join("\n");
			return { event, data };
		});

const setup = (): {
	readonly app: Hono;
	readonly registry: RunRegistry;
	readonly dataDir: string;
} => {
	const dataDir = tempDir();
	const registry = createRunRegistry({ dataDir, logger: silentLogger });
	return { app: createApp({ registry, logger: silentLogger }), registry, dataDir };
};

describe("HTTP API", () => {
	test("health, examples, empty listings and JSON 404 for unknown API routes", async () => {
		const { app } = setup();
		const health = await app.request("/api/health");
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ ok: true, version: expect.any(String) });
		const examples = await app.request("/api/examples");
		expect(examples.status).toBe(200);
		const list = (await examples.json()) as readonly Example[];
		expect(list.map((e) => e.name)).toEqual(["echo_chamber", "prisoners_dilemma"]);
		expect(list[0]?.yaml).toContain("scenarioId: echo_chamber");
		expect(await (await app.request("/api/runs")).json()).toEqual([]);
		expect(await (await app.request("/api/audits")).json()).toEqual([]);
		const missing = await app.request("/api/nope");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "no route for GET /api/nope" });
		for (const path of [
			"/api/runs/x%3A0",
			"/api/runs/x%3A0/events",
			"/api/runs/x%3A0/stream",
			"/api/runs/x%3A0/agents",
			"/api/runs/x%3A0/graph",
			"/api/runs/x%3A0/metrics",
			"/api/runs/x%3A0/events/e/chain",
			"/api/runs/x%3A0/content/s",
			"/api/audits/x",
			"/api/audits/x/report.html",
		]) {
			const res = await app.request(path);
			expect([path, res.status]).toEqual([path, 404]);
			expect(await res.json()).toMatchObject({ error: expect.any(String) });
		}
	});

	test("a run directory with an unreadable result.json is listed as failed with the error", async () => {
		const { app, dataDir } = setup();
		const runDir = join(dataDir, "runs", "x__0");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, SCENARIO_FILE), JSON.stringify(scenarioOf({ scenarioId: "x" })));
		writeFileSync(join(runDir, RESULT_FILE), "{");
		const listed = (await (await app.request("/api/runs")).json()) as RunSummary[];
		expect(listed).toHaveLength(1);
		const first = listed[0];
		expect(first?.error).toContain(join(runDir, RESULT_FILE));
		expect(first).toMatchObject({
			runId: "x:0",
			progress: { tick: 0, ticks: 4, status: "failed" },
		});
		const one = (await (await app.request("/api/runs/x%3A0")).json()) as RunSummary;
		expect(one.error).toBe(first?.error ?? "");
	});

	test("POST /api/runs validates its body and reports issues", async () => {
		const { app } = setup();
		const notJson = await app.request("/api/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(notJson.status).toBe(400);
		expect(await notJson.json()).toEqual({
			issues: [{ path: "", message: "request body must be JSON" }],
		});
		const noSeed = await app.request("/api/runs", json({ scenario: "scenarioId: x" }));
		expect(noSeed.status).toBe(400);
		expect((await noSeed.json()) as { issues: { path: string }[] }).toMatchObject({
			issues: [{ path: "seed" }],
		});
		const badYaml = await app.request(
			"/api/runs",
			json({ scenario: "scenarioId: [", seed: 1 }),
		);
		expect(badYaml.status).toBe(400);
		const badYamlBody = (await badYaml.json()) as {
			issues: { path: string; message: string }[];
		};
		expect(badYamlBody.issues[0]?.path).toBe("scenario");
		expect(badYamlBody.issues[0]?.message).toContain("YAML");
		const invalid = await app.request(
			"/api/runs",
			json({ scenario: "scenarioId: x\nseed: 1\npopulation: { n: 0 }\n", seed: 1 }),
		);
		expect(invalid.status).toBe(400);
		expect((await invalid.json()) as { issues: { path: string }[] }).toMatchObject({
			issues: [{ path: "scenario.population.n" }],
		});
		const badProvider = await app.request(
			"/api/runs",
			json({ scenario: scenarioOf(), seed: 1, provider: "gpt" }),
		);
		expect(badProvider.status).toBe(400);
		expect((await badProvider.json()) as { issues: { path: string }[] }).toMatchObject({
			issues: [{ path: "provider" }],
		});
		const badTicks = await app.request(
			"/api/runs",
			json({ scenario: scenarioOf(), seed: 1, ticks: 0 }),
		);
		expect(badTicks.status).toBe(400);
	});

	test("a slow run is listed as running, streams live events over SSE and refuses a duplicate runId", async () => {
		const { app, registry } = setup();
		let unsubscribed = 0;
		const spied: RunRegistry = {
			...registry,
			subscribe: (runId, handler) => {
				const unsubscribe = registry.subscribe(runId, handler);
				if (unsubscribe === undefined) return undefined;
				return () => {
					unsubscribed += 1;
					unsubscribe();
				};
			},
		};
		const spiedApp = createApp({ registry: spied, logger: silentLogger });
		const created = await spiedApp.request(
			"/api/runs",
			json({ scenario: slowScenario(), seed: 1, ticks: 6 }),
		);
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({ runId: "slow-s1:0" });
		const duplicate = await app.request(
			"/api/runs",
			json({ scenario: slowScenario(), seed: 1 }),
		);
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toEqual({
			error: "run slow-s1:0 already exists; pass a different name or seed",
		});
		const badName = await app.request(
			"/api/runs",
			json({ scenario: slowScenario(), seed: 1, name: "../x" }),
		);
		expect(badName.status).toBe(400);
		expect((await badName.json()) as { issues: { path: string }[] }).toMatchObject({
			issues: [{ path: "name" }],
		});
		const running = (await (await app.request("/api/runs/slow-s1%3A0")).json()) as RunSummary;
		expect(String(running.runId)).toBe("slow-s1:0");
		expect(running.progress.status).toBe("running");
		expect(running.progress.ticks).toBe(6);
		expect(running.agentCount).toBe(5);
		const listed = (await (await app.request("/api/runs")).json()) as RunSummary[];
		expect(listed.map((r) => String(r.runId))).toEqual(["slow-s1:0"]);

		const dropped = await spiedApp.request("/api/runs/slow-s1%3A0/stream");
		expect(dropped.status).toBe(200);
		const reader = dropped.body?.getReader();
		expect(reader).toBeDefined();
		if (reader === undefined) return;
		await reader.read();
		await reader.cancel();
		await until(async () => unsubscribed === 1, 5000);

		const live = await spiedApp.request("/api/runs/slow-s1%3A0/stream");
		expect(live.status).toBe(200);
		expect(live.headers.get("content-type")).toContain("text/event-stream");
		const received = frames(await live.text());
		const events = received.filter((f) => f.event === "event");
		expect(events.length).toBeGreaterThan(0);
		expect(String((JSON.parse(events[0]?.data ?? "{}") as Event).runId)).toBe("slow-s1:0");
		expect(received.at(-1)).toEqual({
			event: "done",
			data: JSON.stringify({ runId: "slow-s1:0", status: "succeeded" }),
		});
		expect(unsubscribed).toBe(2);
		const done = await waitDone(app, "slow-s1:0");
		expect(done.progress).toEqual({ tick: 6, ticks: 6, status: "succeeded" });
		expect(done.result?.integrity.complete).toBe(true);
		expect(done.result?.status).toBe("succeeded");
		const reseeded = await app.request(
			"/api/runs",
			json({ scenario: slowScenario(), seed: 2, ticks: 1 }),
		);
		expect(reseeded.status).toBe(201);
		expect(await reseeded.json()).toEqual({ runId: "slow-s2:0" });
		const named = await app.request(
			"/api/runs",
			json({ scenario: slowScenario(), seed: 2, ticks: 1, name: "custom.run" }),
		);
		expect(named.status).toBe(201);
		expect(await named.json()).toEqual({ runId: "custom.run:0" });
		const sameName = await app.request(
			"/api/runs",
			json({ scenario: slowScenario(), seed: 9, ticks: 1, name: "custom.run" }),
		);
		expect(sameName.status).toBe(409);
		expect((await waitDone(app, "slow-s2:0")).result?.seed).toBe(2);
		expect((await waitDone(app, "custom.run:0")).result?.seed).toBe(2);
		expect(
			((await (await app.request("/api/runs")).json()) as RunSummary[]).map((r) =>
				String(r.runId),
			),
		).toEqual(["custom.run:0", "slow-s1:0", "slow-s2:0"]);
	}, 30000);

	test("run detail routes: events paging, chain, content, agents, graph, metrics and replayed SSE", async () => {
		const { app } = setup();
		const created = await app.request("/api/runs", json({ scenario: scenarioOf(), seed: 3 }));
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({ runId: "api-s3:0" });
		const done = await waitDone(app, "api-s3:0");
		expect(done.progress).toEqual({ tick: 4, ticks: 4, status: "succeeded" });
		const base = "/api/runs/api-s3%3A0";

		const page = (await (await app.request(`${base}/events`)).json()) as Event[];
		expect(page).toHaveLength(200);
		const big = (await (await app.request(`${base}/events?limit=5000`)).json()) as Event[];
		expect(big).toHaveLength(1000);
		const second = (await (
			await app.request(`${base}/events?limit=200&offset=200`)
		).json()) as Event[];
		expect(second[0]?.eventId).toBe(big[200]?.eventId);
		for (let i = 1; i < big.length; i += 1) {
			const a = big[i - 1];
			const b = big[i];
			if (a === undefined || b === undefined) continue;
			const before =
				a.t.tick < b.t.tick ||
				(a.t.tick === b.t.tick &&
					(a.t.substep < b.t.substep ||
						(a.t.substep === b.t.substep && a.t.seq <= b.t.seq)));
			expect(before).toBe(true);
		}
		const measurements = (await (
			await app.request(`${base}/events?kind=measurement&limit=1000`)
		).json()) as Event[];
		expect(measurements).toHaveLength(4);
		expect(measurements.every((e) => e.kind === "measurement")).toBe(true);
		const tick2 = (await (
			await app.request(`${base}/events?tick=2&kind=activation`)
		).json()) as Event[];
		expect(tick2).toHaveLength(1);
		const ranged = (await (
			await app.request(
				`${base}/events?kind=activation,measurement&fromTick=1&toTick=2&limit=1000`,
			)
		).json()) as Event[];
		expect(ranged.map((e) => e.t.tick)).toEqual([1, 1, 2, 2]);
		const badKind = await app.request(`${base}/events?kind=activation,bogus`);
		expect(badKind.status).toBe(400);
		expect(await badKind.json()).toEqual({
			issues: [{ path: "kind", message: "unknown event kind 'bogus'" }],
		});
		const badLimit = await app.request(`${base}/events?limit=0`);
		expect(badLimit.status).toBe(400);
		expect((await badLimit.json()) as { issues: { path: string }[] }).toMatchObject({
			issues: [{ path: "limit" }],
		});
		const badTick = await app.request(`${base}/events?tick=x`);
		expect(badTick.status).toBe(400);

		const decision = big.find((e) => e.kind === "decision");
		expect(decision).toBeDefined();
		if (decision === undefined || decision.agentId === undefined) return;
		const byAgent = (await (
			await app.request(`${base}/events?agent=${decision.agentId}&limit=1000`)
		).json()) as Event[];
		expect(byAgent.length).toBeGreaterThan(0);
		expect(byAgent.every((e) => e.agentId === decision.agentId)).toBe(true);
		const chain = (await (
			await app.request(`${base}/events/${decision.eventId}/chain`)
		).json()) as Event[];
		expect(chain.map((e) => e.kind)).toContain("observation");
		expect(chain.some((e) => e.eventId === decision.eventId)).toBe(true);
		const noChain = await app.request(`${base}/events/00000000000000000000000000/chain`);
		expect(noChain.status).toBe(404);
		const observation = chain.find((e) => e.kind === "observation");
		expect(observation?.kind).toBe("observation");
		if (observation?.kind !== "observation") return;
		const content = await app.request(`${base}/content/${observation.payload.contentSha}`);
		expect(content.status).toBe(200);
		expect(content.headers.get("content-type")).toContain("text/plain");
		expect((await content.text()).length).toBeGreaterThan(0);
		expect((await app.request(`${base}/content/deadbeef`)).status).toBe(404);

		const agents = (await (await app.request(`${base}/agents`)).json()) as AgentRow[];
		expect(agents).toHaveLength(200);
		const first = agents[0];
		expect(first).toBeDefined();
		if (first === undefined) return;
		expect(Object.keys(first.columns).sort()).toEqual([
			"decisions",
			"failures",
			"persona.name",
			"persona.stance",
		]);
		expect(typeof first.columns["persona.stance"]).toBe("number");
		expect(agents.reduce((sum, a) => sum + Number(a.columns.decisions), 0)).toBe(
			done.result?.integrity.activated ?? -1,
		);

		const graph = (await (await app.request(`${base}/graph`)).json()) as GraphSnapshot;
		expect(graph.tick).toBe(4);
		expect(graph.edges.length).toBeGreaterThan(0);
		expect(graph.edges[0]).toMatchObject({
			src: expect.any(String),
			dst: expect.any(String),
			kind: "follow",
		});
		const early = (await (await app.request(`${base}/graph?tick=2`)).json()) as GraphSnapshot;
		expect(early.tick).toBe(2);
		const beyond = (await (await app.request(`${base}/graph?tick=99`)).json()) as GraphSnapshot;
		expect(beyond.tick).toBe(4);
		expect((await app.request(`${base}/graph?tick=x`)).status).toBe(400);

		const metrics = (await (await app.request(`${base}/metrics`)).json()) as MetricSeries;
		expect(Object.keys(metrics)).toEqual(["postShare"]);
		expect(metrics.postShare?.map((p) => p.tick)).toEqual([0, 1, 2, 3]);

		const replayed = frames(await (await app.request(`${base}/stream`)).text());
		expect(replayed.filter((f) => f.event === "event")).toHaveLength(
			done.result === undefined
				? 0
				: big.length +
						(
							(await (
								await app.request(`${base}/events?limit=1000&offset=1000`)
							).json()) as Event[]
						).length,
		);
		expect(replayed.at(-1)).toEqual({
			event: "done",
			data: JSON.stringify({ runId: "api-s3:0", status: "succeeded" }),
		});
		const ticks = replayed
			.filter((f) => f.event === "event")
			.map((f) => (JSON.parse(f.data) as Event).t.tick);
		expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
	}, 60000);

	test("example YAML posted verbatim resolves its plugins against the example directory", async () => {
		const { app } = setup();
		const examples = (await (await app.request("/api/examples")).json()) as readonly Example[];
		const pd = examples.find((e) => e.name === "prisoners_dilemma");
		expect(pd).toBeDefined();
		if (pd === undefined) return;
		const created = await app.request(
			"/api/runs",
			json({ scenario: pd.yaml, seed: 1, ticks: 3, provider: "mock" }),
		);
		expect(created.status).toBe(201);
		const done = await waitDone(app, "prisoners_dilemma-s1:0");
		expect(done.progress).toEqual({ tick: 3, ticks: 3, status: "succeeded" });
		expect(done.result?.metrics.cooperationRate).toBeDefined();
	}, 30000);

	test("audits: validation, background execution with progress, report.html and 409 on a duplicate name", async () => {
		const { app } = setup();
		const bad = await app.request("/api/audits", json({ plan: "axes: [" }));
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { issues: { path: string }[] }).issues[0]?.path).toBe("plan");
		const badName = await app.request(
			"/api/audits",
			json({ plan: readFileSync(PD_AUDIT, "utf8"), name: "../x" }),
		);
		expect(badName.status).toBe(400);
		expect((await badName.json()) as { issues: { path: string }[] }).toMatchObject({
			issues: [{ path: "name" }],
		});
		const created = await app.request(
			"/api/audits",
			json({
				plan: readFileSync(PD_AUDIT, "utf8"),
				name: "pd",
				replications: 2,
				provider: "mock",
			}),
		);
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({ auditId: "pd" });
		const duplicate = await app.request(
			"/api/audits",
			json({ plan: readFileSync(PD_AUDIT, "utf8"), name: "pd", replications: 1 }),
		);
		expect(duplicate.status).toBe(409);
		const running = (await (await app.request("/api/audits/pd")).json()) as AuditSummary;
		expect(running.progress.total).toBe(20);
		expect(running.plan?.replications).toBe(2);
		const noReport = await app.request("/api/audits/pd/report.html");
		expect(noReport.status).toBe(404);
		const done = await waitAudit(app, "pd");
		expect(done.progress).toEqual({ completed: 20, total: 20, status: "succeeded" });
		expect(done.report?.runs).toHaveLength(20);
		expect(done.report?.pairwise.length).toBeGreaterThan(0);
		const listed = (await (await app.request("/api/audits")).json()) as AuditSummary[];
		expect(listed.map((a) => a.auditId)).toEqual(["pd"]);
		const report = await app.request("/api/audits/pd/report.html");
		expect(report.status).toBe(200);
		expect(report.headers.get("content-type")).toContain("text/html");
		expect(await report.text()).toContain("cooperationRate");

		const plan = loadAuditPlan(PD_AUDIT);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const asObject = await app.request(
			"/api/audits",
			json({ plan: plan.value, replications: 1, provider: "mock" }),
		);
		expect(asObject.status).toBe(201);
		const { auditId } = (await asObject.json()) as { auditId: string };
		expect(auditId).toMatch(/^[0-9a-f]{12}$/);
		const hashed = await waitAudit(app, auditId);
		expect(hashed.progress).toEqual({ completed: 10, total: 10, status: "succeeded" });
	}, 120000);

	test("GET / serves the built GUI, or a note when gui/dist is missing", async () => {
		if (!existsSync(join(GUI_DIST_DIR, "index.html"))) {
			const built = Bun.spawnSync(["bun", "run", "build:gui"], { cwd: ROOT });
			expect(built.exitCode).toBe(0);
		}
		const { app } = setup();
		const index = await app.request("/");
		expect(index.status).toBe(200);
		expect(await index.text()).toContain('<div id="root">');
		const asset = readFileSync(join(GUI_DIST_DIR, "index.html"), "utf8").match(
			/src="([^"]+\.js)"/,
		)?.[1];
		expect(asset).toBeDefined();
		if (asset !== undefined) {
			const js = await app.request(asset);
			expect(js.status).toBe(200);
			expect(js.headers.get("content-type")).toContain("javascript");
		}
		expect((await app.request("/nope.txt")).status).toBe(404);
		const bare = createApp({
			registry: createRunRegistry({ dataDir: tempDir(), logger: silentLogger }),
			logger: silentLogger,
			guiDir: join(tempDir(), "missing"),
		});
		const note = await bare.request("/");
		expect(note.status).toBe(200);
		expect(await note.text()).toContain("build:gui");
	}, 60000);

	test("simulacra serve listens on the given port and serves the API and GUI", async () => {
		const dataDir = tempDir();
		const proc = Bun.spawn(["bun", CLI, "serve", "--port", "0", "--data", dataDir], {
			cwd: ROOT,
			env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const reader = proc.stdout.getReader();
			let out = "";
			while (!out.includes("\n")) {
				const { value, done } = await reader.read();
				if (done) break;
				out += new TextDecoder().decode(value);
			}
			const url = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
			expect(url).toBeDefined();
			if (url === undefined) return;
			const health = await fetch(`${url}/api/health`);
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ ok: true });
			const index = await fetch(url);
			expect(index.status).toBe(200);
			expect(await index.text()).toContain('<div id="root">');
			const runs = await fetch(`${url}/api/runs`);
			expect(await runs.json()).toEqual([]);
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 30000);
});
