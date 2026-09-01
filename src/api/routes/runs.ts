import { Hono } from "hono";
import { z } from "zod";
import {
	AGENT_ENTITY,
	EDGE_COLUMNS,
	EDGE_ENTITY,
	PERSONA_PREFIX,
	isEventKind,
	ok,
	parseScenario,
	parseScenarioYaml,
	readRunScenario,
	replayWorld,
	resolveScenarioPlugins,
	toEntityId,
	toEventId,
	toRunId,
	withRunLog,
	type Event,
	type EventFilter,
	type EventKind,
	type Result,
	type RunId,
	type Scalar,
	type Scenario,
} from "../../index";
import {
	DEFAULT_PAGE,
	MAX_PAGE,
	ProviderSchema,
	badRequest,
	conflict,
	exampleDirOf,
	issuesOf,
	nonNegativeInt,
	notFound,
	positiveInt,
	readJsonBody,
	type ApiDeps,
	type ApiIssue,
} from "./shared";

const NewRunSchema = z.object({
	scenario: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
	seed: z.number().int(),
	ticks: z.number().int().positive().optional(),
	provider: ProviderSchema.optional(),
});

const EventsQuerySchema = z.object({
	kind: z.string().optional(),
	agent: z.string().min(1).optional(),
	tick: nonNegativeInt.optional(),
	fromTick: nonNegativeInt.optional(),
	toTick: nonNegativeInt.optional(),
	limit: positiveInt.optional(),
	offset: nonNegativeInt.optional(),
});

const GraphQuerySchema = z.object({ tick: nonNegativeInt.optional() });

interface AgentCount {
	readonly agent_id: string;
	readonly kind: string;
	readonly n: number;
}

const AGENT_COUNTS_SQL =
	"SELECT agent_id, kind, COUNT(*) AS n FROM events WHERE agent_id IS NOT NULL AND kind IN ('decision', 'failure') GROUP BY agent_id, kind";

const scenarioOf = (
	raw: string | Record<string, unknown>,
): Result<Scenario, readonly ApiIssue[]> => {
	if (typeof raw !== "string") {
		const parsed = parseScenario(raw);
		if (!parsed.ok) return { ok: false, error: issuesOf(parsed.error, "scenario") };
		return ok(resolveScenarioPlugins(parsed.value, process.cwd()));
	}
	const parsed = parseScenarioYaml(raw);
	if (!parsed.ok) return { ok: false, error: issuesOf(parsed.error, "scenario") };
	return ok(
		resolveScenarioPlugins(parsed.value, exampleDirOf(raw, "scenario.yaml") ?? process.cwd()),
	);
};

const kindsOf = (raw: string | undefined): Result<readonly EventKind[] | undefined, ApiIssue> => {
	if (raw === undefined) return ok(undefined);
	const kinds: EventKind[] = [];
	for (const kind of raw.split(",").filter((k) => k.length > 0)) {
		if (!isEventKind(kind))
			return { ok: false, error: { path: "kind", message: `unknown event kind '${kind}'` } };
		kinds.push(kind);
	}
	return ok(kinds);
};

const hiddenPersonaColumns = (scenario: Scenario): ReadonlySet<string> =>
	new Set(
		scenario.population.fields
			.filter((f) => f.private === true)
			.map((f) => `${PERSONA_PREFIX}${f.name}`),
	);

const metricSeries = (
	events: readonly Event[],
): Record<string, { tick: number; value: number }[]> => {
	const series: Record<string, { tick: number; value: number }[]> = {};
	for (const e of events) {
		if (e.kind !== "measurement" || typeof e.payload.value !== "number") continue;
		(series[e.payload.name] ??= []).push({ tick: e.t.tick, value: e.payload.value });
	}
	return series;
};

export const runRoutes = (deps: ApiDeps): Hono => {
	const { registry } = deps;
	const app = new Hono();

	const locate = (id: string): { readonly runId: RunId; readonly dir: string } | undefined => {
		const runId = toRunId(id);
		return registry.getRun(runId) === undefined
			? undefined
			: { runId, dir: registry.runDir(runId) };
	};

	app.get("/", (c) => c.json(registry.listRuns()));

	app.post("/", async (c) => {
		const body = await readJsonBody(c);
		if (!body.ok) return badRequest(c, body.error);
		const parsed = NewRunSchema.safeParse(body.value);
		if (!parsed.success) return badRequest(c, issuesOf(parsed.error.issues));
		const scenario = scenarioOf(parsed.data.scenario);
		if (!scenario.ok) return badRequest(c, scenario.error);
		const started = registry.startRun({
			scenario: scenario.value,
			seed: parsed.data.seed,
			...(parsed.data.ticks === undefined ? {} : { ticks: parsed.data.ticks }),
			...(parsed.data.provider === undefined ? {} : { provider: parsed.data.provider }),
		});
		if (!started.ok) return conflict(c, `run ${started.error.runId} already exists`);
		return c.json({ runId: started.value.runId }, 201);
	});

	app.get("/:id", (c) => {
		const summary = registry.getRun(toRunId(c.req.param("id")));
		return summary === undefined
			? notFound(c, `unknown run ${c.req.param("id")}`)
			: c.json(summary);
	});

	app.get("/:id/events", (c) => {
		const run = locate(c.req.param("id"));
		if (run === undefined) return notFound(c, `unknown run ${c.req.param("id")}`);
		const query = EventsQuerySchema.safeParse(c.req.query());
		if (!query.success) return badRequest(c, issuesOf(query.error.issues));
		const kinds = kindsOf(query.data.kind);
		if (!kinds.ok) return badRequest(c, [kinds.error]);
		const filter: EventFilter = {
			...(kinds.value === undefined ? {} : { kind: kinds.value }),
			...(query.data.agent === undefined ? {} : { agentId: toEntityId(query.data.agent) }),
			...(query.data.tick === undefined ? {} : { tick: query.data.tick }),
			...(query.data.fromTick === undefined ? {} : { fromTick: query.data.fromTick }),
			...(query.data.toTick === undefined ? {} : { toTick: query.data.toTick }),
			limit: Math.min(query.data.limit ?? DEFAULT_PAGE, MAX_PAGE),
			offset: query.data.offset ?? 0,
		};
		const events = withRunLog(run.dir, (log) => ok(log.query(filter)));
		return events.ok ? c.json(events.value) : notFound(c, events.error);
	});

	app.get("/:id/events/:eventId/chain", (c) => {
		const run = locate(c.req.param("id"));
		if (run === undefined) return notFound(c, `unknown run ${c.req.param("id")}`);
		const eventId = c.req.param("eventId");
		const chain = withRunLog(run.dir, (log) => ok(log.chain(toEventId(eventId))));
		if (!chain.ok) return notFound(c, chain.error);
		return chain.value.length === 0
			? notFound(c, `unknown event ${eventId}`)
			: c.json(chain.value);
	});

	app.get("/:id/content/:sha", (c) => {
		const run = locate(c.req.param("id"));
		if (run === undefined) return notFound(c, `unknown run ${c.req.param("id")}`);
		const sha = c.req.param("sha");
		const content = withRunLog(run.dir, (log) => ok(log.getContent(sha)));
		if (!content.ok) return notFound(c, content.error);
		return content.value === undefined
			? notFound(c, `unknown content ${sha}`)
			: c.text(content.value, 200, { "content-type": "text/plain; charset=utf-8" });
	});

	app.get("/:id/agents", (c) => {
		const run = locate(c.req.param("id"));
		if (run === undefined) return notFound(c, `unknown run ${c.req.param("id")}`);
		const scenario = readRunScenario(run.dir);
		if (!scenario.ok) return notFound(c, scenario.error);
		const replayed = replayWorld(run.dir);
		if (!replayed.ok) return notFound(c, replayed.error);
		const counts = withRunLog(run.dir, (log) => ok(log.sql<AgentCount>(AGENT_COUNTS_SQL)));
		if (!counts.ok) return notFound(c, counts.error);
		const decisions = new Map<string, number>();
		const failures = new Map<string, number>();
		for (const row of counts.value)
			(row.kind === "decision" ? decisions : failures).set(row.agent_id, row.n);
		const hidden = hiddenPersonaColumns(scenario.value);
		const world = replayed.value.world;
		const rows = world.ids(AGENT_ENTITY).map((id) => {
			const columns: Record<string, Scalar> = {};
			for (const [name, value] of Object.entries(world.row(AGENT_ENTITY, id) ?? {}))
				if (name.startsWith(PERSONA_PREFIX) && !hidden.has(name)) columns[name] = value;
			columns.decisions = decisions.get(id) ?? 0;
			columns.failures = failures.get(id) ?? 0;
			return { id, columns };
		});
		return c.json(rows);
	});

	app.get("/:id/graph", (c) => {
		const run = locate(c.req.param("id"));
		if (run === undefined) return notFound(c, `unknown run ${c.req.param("id")}`);
		const query = GraphQuerySchema.safeParse(c.req.query());
		if (!query.success) return badRequest(c, issuesOf(query.error.issues));
		const replayed = replayWorld(run.dir, query.data.tick);
		if (!replayed.ok) return notFound(c, replayed.error);
		const world = replayed.value.world;
		const edges: { src: string; dst: string; kind: string }[] = [];
		if (
			world.entities.includes(EDGE_ENTITY) &&
			world.columns(EDGE_ENTITY).some((col) => col.name === EDGE_COLUMNS.src)
		) {
			const src = world.column<string>(EDGE_ENTITY, EDGE_COLUMNS.src);
			const dst = world.column<string>(EDGE_ENTITY, EDGE_COLUMNS.dst);
			const kind = world.column<string>(EDGE_ENTITY, EDGE_COLUMNS.kind);
			for (let i = 0; i < world.count(EDGE_ENTITY); i += 1)
				edges.push({ src: src.at(i), dst: dst.at(i), kind: kind.at(i) });
		}
		return c.json({ tick: replayed.value.tick, edges });
	});

	app.get("/:id/metrics", (c) => {
		const run = locate(c.req.param("id"));
		if (run === undefined) return notFound(c, `unknown run ${c.req.param("id")}`);
		const events = withRunLog(run.dir, (log) => ok(log.query({ kind: ["measurement"] })));
		return events.ok ? c.json(metricSeries(events.value)) : notFound(c, events.error);
	});

	return app;
};
