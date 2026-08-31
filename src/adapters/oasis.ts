import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEvent } from "../core/events";
import { ZERO_EVENT_ID, makeRunId, newEventId, toEntityId } from "../core/ids";
import { EVENT_LOG_FILE, eventLogPath, openSqliteEventLog } from "../core/log";
import { AGENT_ENTITY, ORDINAL_COLUMN, PERSONA_OWNER, PERSONA_PREFIX } from "../core/population";
import type { Adapter, EventLog, Metric, Registry, RunFn, World } from "../core/protocols";
import { applyEffects } from "../core/resolver";
import { err, ok } from "../core/result";
import { keyFromLabel, rngFromSeed } from "../core/rng";
import { RESULT_FILE } from "../core/run";
import { SCENARIO_FILE, writeRunScenario } from "../core/runDir";
import { parseScenario, scenarioHash } from "../core/scenario";
import { TIME_ZERO } from "../core/time";
import type {
	ColumnDecl,
	Cost,
	Effect,
	EntityId,
	EventId,
	FailureInfo,
	InstrumentSpec,
	JsonObject,
	JsonValue,
	Result,
	RunId,
	RunResult,
	Scalar,
	Scenario,
} from "../core/types";
import { createWorld } from "../core/world";
import { silentLogger, type Logger } from "../logging/logger";
import { FEED_KIND, POST_COLUMNS, POST_ENTITY } from "../modules/posts";
import { EDGE_COLUMNS, EDGE_ENTITY, FOLLOW_KIND, SOCIAL_GRAPH_KIND } from "../modules/socialGraph";
import {
	createScriptAdapter,
	executeScript,
	failedScriptResult,
	type ScriptAdapterOptions,
} from "./script";

export const OASIS_ADAPTER_KIND = "oasis";
export const OASIS_SCENARIO_ID = "oasis";
export const OASIS_PROVIDER = "oasis";
export const OASIS_DB_FILE = "oasis.db";
export const OASIS_WORLD_FILE = "world.json";
export const OASIS_REFRESH = "REFRESH";
export const OASIS_ID_PREFIX = "oasis:";

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

export const oasisAgentId = (userId: unknown): EntityId =>
	toEntityId(`${OASIS_ID_PREFIX}${String(userId)}`);
export const oasisPostId = (postId: unknown): EntityId =>
	toEntityId(`${OASIS_ID_PREFIX}post:${String(postId)}`);
export const oasisEdgeId = (key: unknown): EntityId =>
	toEntityId(`${OASIS_ID_PREFIX}edge:${String(key)}`);

type Row = Readonly<Record<string, unknown>>;

const stringOf = (v: unknown): string =>
	v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);
const numberOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const tickOf = (createdAt: unknown, fallback: number): number => {
	if (typeof createdAt === "number" && Number.isInteger(createdAt)) return createdAt;
	if (typeof createdAt === "string" && /^-?\d+$/.test(createdAt.trim()))
		return Number.parseInt(createdAt.trim(), 10);
	return fallback;
};

const isObject = (v: JsonValue): v is JsonObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

interface ParsedInfo {
	readonly value: JsonValue;
	readonly ok: boolean;
}

export const parseInfo = (info: unknown): ParsedInfo => {
	if (info === null || info === undefined) return { value: {}, ok: true };
	if (typeof info !== "string") return { value: stringOf(info), ok: false };
	try {
		return { value: JSON.parse(info) as JsonValue, ok: true };
	} catch {
		return { value: info, ok: false };
	}
};

export const traceEffects = (
	action: string,
	agentId: EntityId,
	args: JsonObject,
	tick: number,
	index: number,
	cause: EventId,
): readonly Effect[] => {
	switch (action) {
		case "CREATE_POST":
			return [
				{
					op: "create",
					entity: POST_ENTITY,
					id:
						args.post_id === undefined
							? oasisPostId(`trace:${index}`)
							: oasisPostId(args.post_id),
					row: {
						[POST_COLUMNS.author]: agentId,
						[POST_COLUMNS.content]: stringOf(args.content),
						[POST_COLUMNS.t]: tick,
						[POST_COLUMNS.likes]: 0,
						[POST_COLUMNS.reposts]: 0,
						[POST_COLUMNS.parent]: "",
					},
					cause,
				},
			];
		case "LIKE_POST":
			return args.post_id === undefined
				? []
				: [
						{
							op: "inc",
							entity: POST_ENTITY,
							id: oasisPostId(args.post_id),
							column: POST_COLUMNS.likes,
							value: 1,
							cause,
						},
					];
		case "FOLLOW": {
			const followee = args.followee_id ?? args.user_id;
			return followee === undefined
				? []
				: [
						{
							op: "create",
							entity: EDGE_ENTITY,
							id: oasisEdgeId(`trace:${index}`),
							row: {
								[EDGE_COLUMNS.src]: agentId,
								[EDGE_COLUMNS.dst]: oasisAgentId(followee),
								[EDGE_COLUMNS.kind]: FOLLOW_KIND,
							},
							cause,
						},
					];
		}
		default:
			return [];
	}
};

// World: the user table becomes the agent table, post becomes post, follow becomes edge

const DECLS: readonly ColumnDecl[] = [
	{
		entity: AGENT_ENTITY,
		name: ORDINAL_COLUMN,
		dtype: "i32",
		default: 0,
		owner: "kernel",
		merge: "last",
	},
	{
		entity: AGENT_ENTITY,
		name: "name",
		dtype: "str",
		default: "",
		owner: PERSONA_OWNER,
		merge: "last",
	},
	{
		entity: AGENT_ENTITY,
		name: "bio",
		dtype: "str",
		default: "",
		owner: PERSONA_OWNER,
		merge: "last",
	},
	{
		entity: POST_ENTITY,
		name: "author",
		dtype: "str",
		default: "",
		owner: FEED_KIND,
		merge: "last",
	},
	{
		entity: POST_ENTITY,
		name: "content",
		dtype: "str",
		default: "",
		owner: FEED_KIND,
		merge: "last",
	},
	{ entity: POST_ENTITY, name: "t", dtype: "i32", default: 0, owner: FEED_KIND, merge: "last" },
	{
		entity: POST_ENTITY,
		name: "likes",
		dtype: "i32",
		default: 0,
		owner: FEED_KIND,
		merge: "sum",
	},
	{
		entity: POST_ENTITY,
		name: "reposts",
		dtype: "i32",
		default: 0,
		owner: FEED_KIND,
		merge: "sum",
	},
	{
		entity: POST_ENTITY,
		name: "parent",
		dtype: "str",
		default: "",
		owner: FEED_KIND,
		merge: "last",
	},
	{
		entity: EDGE_ENTITY,
		name: "src",
		dtype: "str",
		default: "",
		owner: SOCIAL_GRAPH_KIND,
		merge: "last",
	},
	{
		entity: EDGE_ENTITY,
		name: "dst",
		dtype: "str",
		default: "",
		owner: SOCIAL_GRAPH_KIND,
		merge: "last",
	},
	{
		entity: EDGE_ENTITY,
		name: "kind",
		dtype: "str",
		default: "",
		owner: SOCIAL_GRAPH_KIND,
		merge: "last",
	},
];

const agentRow = (user: Row, index: number): Readonly<Record<string, Scalar>> => ({
	[ORDINAL_COLUMN]: index,
	[`${PERSONA_PREFIX}name`]: stringOf(user.name ?? user.user_name),
	[`${PERSONA_PREFIX}bio`]: stringOf(user.bio),
});

const postRow = (post: Row, index: number): Readonly<Record<string, Scalar>> => ({
	[POST_COLUMNS.author]: oasisAgentId(post.user_id),
	[POST_COLUMNS.content]: stringOf(post.content),
	[POST_COLUMNS.t]: tickOf(post.created_at, index),
	[POST_COLUMNS.likes]: numberOf(post.num_likes),
	[POST_COLUMNS.reposts]: numberOf(post.num_shares),
	[POST_COLUMNS.parent]:
		post.original_post_id === null || post.original_post_id === undefined
			? ""
			: oasisPostId(post.original_post_id),
});

const edgeRow = (follow: Row): Readonly<Record<string, Scalar>> => ({
	[EDGE_COLUMNS.src]: oasisAgentId(follow.follower_id),
	[EDGE_COLUMNS.dst]: oasisAgentId(follow.followee_id),
	[EDGE_COLUMNS.kind]: FOLLOW_KIND,
});

const hasTable = (db: Database, name: string): boolean =>
	db
		.query<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
		)
		.get(name)?.n === 1;

const rowsOf = (db: Database, table: string): readonly Row[] =>
	db.query<Row, []>(`SELECT * FROM "${table}" ORDER BY rowid`).all();

const buildWorld = (
	users: readonly Row[],
	posts: readonly Row[],
	follows: readonly Row[],
): Result<{ readonly world: World; readonly rejected: number }, string> => {
	const world = createWorld();
	for (const decl of DECLS) {
		const declared = world.declare(decl);
		if (!declared.ok) return err(declared.error.message);
	}
	const effects: Effect[] = [
		...users.map((u, i): Effect => ({
			op: "create",
			entity: AGENT_ENTITY,
			id: oasisAgentId(u.user_id),
			row: agentRow(u, i),
			cause: ZERO_EVENT_ID,
		})),
		...posts.map((p, i): Effect => ({
			op: "create",
			entity: POST_ENTITY,
			id: oasisPostId(p.post_id ?? `row:${i}`),
			row: postRow(p, i),
			cause: ZERO_EVENT_ID,
		})),
		...follows.map((f, i): Effect => ({
			op: "create",
			entity: EDGE_ENTITY,
			id: oasisEdgeId(f.follow_id ?? `row:${i}`),
			row: edgeRow(f),
			cause: ZERO_EVENT_ID,
		})),
	];
	const report = applyEffects(world, effects, TIME_ZERO);
	return ok({ world, rejected: report.rejected.length });
};

// Trace: REFRESH becomes an observation, every other action a decision plus its effects

interface TraceSummary {
	readonly observations: number;
	readonly decisions: number;
	readonly parseFailures: number;
}

const importTrace = (traces: readonly Row[], log: EventLog, runId: RunId): TraceSummary => {
	const rng = rngFromSeed(0, [keyFromLabel("oasis-import")]);
	const seqByTick = new Map<number, number>();
	const nextSeq = (tick: number): number => {
		const seq = seqByTick.get(tick) ?? 0;
		seqByTick.set(tick, seq + 1);
		return seq;
	};
	let observations = 0;
	let decisions = 0;
	let parseFailures = 0;
	log.beginTick();
	try {
		traces.forEach((row, index) => {
			const tick = tickOf(row.created_at, index);
			const agentId = oasisAgentId(row.user_id);
			const action = stringOf(row.action);
			const base = { runId, seedPath: [], agentId } as const;
			if (action === OASIS_REFRESH) {
				const contentSha = log.putContent(stringOf(row.info));
				log.append(
					makeEvent(
						{
							...base,
							eventId: newEventId(rng),
							t: { tick, substep: 0, seq: nextSeq(tick) },
							provenance: "llm",
						},
						{
							kind: "observation",
							payload: { contentSha, refs: [], truncated: false },
						},
					),
				);
				observations += 1;
				return;
			}
			const info = parseInfo(row.info);
			const args: JsonObject = isObject(info.value) ? info.value : { info: info.value };
			const decisionId = newEventId(rng);
			log.append(
				makeEvent(
					{
						...base,
						eventId: decisionId,
						t: { tick, substep: 0, seq: nextSeq(tick) },
						provenance: "llm",
					},
					{
						kind: "decision",
						payload: {
							action: action.toLowerCase(),
							args,
							provider: OASIS_PROVIDER,
							parseOk: info.ok,
						},
					},
				),
			);
			log.append(
				makeEvent(
					{
						...base,
						eventId: newEventId(rng),
						t: { tick, substep: 0, seq: nextSeq(tick) },
						parent: decisionId,
						provenance: "kernel",
					},
					{
						kind: "effect",
						payload: {
							effects: traceEffects(action, agentId, args, tick, index, decisionId),
							rejected: [],
						},
					},
				),
			);
			decisions += 1;
			if (!info.ok) parseFailures += 1;
		});
	} finally {
		log.endTick();
	}
	return { observations, decisions, parseFailures };
};

// Metrics

export type MetricRequest = string | InstrumentSpec;

const specOf = (m: MetricRequest): InstrumentSpec => (typeof m === "string" ? { kind: m } : m);

const createMetrics = (
	specs: readonly InstrumentSpec[],
	registry: Registry,
	scenario: Scenario,
	logger: Logger,
): Result<readonly (readonly [string, Metric])[], string> => {
	const out: (readonly [string, Metric])[] = [];
	for (const spec of specs) {
		const created = registry.metrics.create(spec, { scenario, registry, logger });
		if (!created.ok) return err(`metric '${spec.kind}': ${JSON.stringify(created.error)}`);
		out.push([spec.name ?? spec.kind, created.value]);
	}
	return ok(out);
};

export interface OasisImportOptions {
	readonly logger?: Logger | undefined;
	readonly overwrite?: boolean | undefined;
}

export const OASIS_OUTPUT_FILES: readonly string[] = [
	EVENT_LOG_FILE,
	`${EVENT_LOG_FILE}-wal`,
	`${EVENT_LOG_FILE}-shm`,
	RESULT_FILE,
	SCENARIO_FILE,
	OASIS_WORLD_FILE,
];

export interface OasisImportSummary {
	readonly result: RunResult;
	readonly outDir: string;
	readonly agents: number;
	readonly posts: number;
	readonly edges: number;
	readonly observations: number;
	readonly decisions: number;
	readonly parseFailures: number;
}

// With overwrite only the importer's own files are replaced; other files in the directory are kept
const prepareOutDir = (outDir: string, overwrite: boolean): Result<void, string> => {
	if (existsSync(outDir) && readdirSync(outDir).length > 0) {
		if (!overwrite)
			return err(`output directory ${outDir} is not empty; pass overwrite to replace it`);
		for (const file of OASIS_OUTPUT_FILES) rmSync(join(outDir, file), { force: true });
	}
	mkdirSync(outDir, { recursive: true });
	return ok(undefined);
};

const openReadonly = (dbPath: string): Result<Database, string> => {
	if (!existsSync(dbPath)) return err(`${dbPath}: file not found`);
	try {
		return ok(new Database(dbPath, { readonly: true }));
	} catch (e) {
		return err(`${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
	}
};

export const importOasis = (
	dbPath: string,
	outDir: string,
	metrics: readonly MetricRequest[],
	registry: Registry,
	opts: OasisImportOptions = {},
): Result<OasisImportSummary, string> => {
	const logger = (opts.logger ?? silentLogger).child({ component: "adapter:oasis" });
	const opened = openReadonly(dbPath);
	if (!opened.ok) return opened;
	const db = opened.value;
	try {
		for (const table of ["user", "post", "trace"])
			if (!hasTable(db, table)) return err(`${dbPath}: table '${table}' is missing`);
		const users = rowsOf(db, "user");
		const posts = rowsOf(db, "post");
		const traces = rowsOf(db, "trace");
		const follows = hasTable(db, "follow") ? rowsOf(db, "follow") : [];
		const specs = metrics.map(specOf);
		const parsed = parseScenario({
			scenarioId: OASIS_SCENARIO_ID,
			seed: 0,
			population: { n: Math.max(1, users.length) },
			params: { source: dbPath },
			instruments: specs,
		});
		if (!parsed.ok)
			return err(parsed.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
		const scenario = parsed.value;
		const created = createMetrics(specs, registry, scenario, logger);
		if (!created.ok) return created;
		const built = buildWorld(users, posts, follows);
		if (!built.ok) return built;
		const prepared = prepareOutDir(outDir, opts.overwrite ?? false);
		if (!prepared.ok) return prepared;
		writeRunScenario(outDir, scenario);
		const runId = makeRunId(scenario.scenarioId, scenario.replicationId);
		const log = openSqliteEventLog(eventLogPath(outDir));
		let summary: TraceSummary;
		const metricValues: Record<string, number> = {};
		const distributions: Record<string, readonly number[]> = {};
		let failure: FailureInfo | undefined;
		try {
			summary = importTrace(traces, log, runId);
			for (const [name, metric] of created.value) {
				try {
					const value = metric.compute(built.value.world, log, runId);
					if (typeof value === "number") metricValues[name] = value;
					else distributions[name] = value;
				} catch (e) {
					failure = {
						stage: "extract",
						excType: e instanceof Error ? e.name : "Error",
						message: `metric '${name}': ${e instanceof Error ? e.message : String(e)}`,
						stack: e instanceof Error ? (e.stack ?? "") : "",
					};
					logger.error("metric failed", { metric: name, message: failure.message });
					break;
				}
			}
		} finally {
			log.close();
		}
		writeFileSync(join(outDir, OASIS_WORLD_FILE), JSON.stringify(built.value.world.snapshot()));
		const result: RunResult = {
			runId,
			scenarioHash: scenarioHash(scenario),
			seed: scenario.seed,
			status: failure === undefined ? "succeeded" : "failed",
			...(failure === undefined ? {} : { failure }),
			metrics: metricValues,
			distributions,
			integrity: {
				activated: summary.decisions,
				ok: summary.decisions,
				failed: 0,
				parseFailures: summary.parseFailures,
				llmCalls: 0,
				llmFailures: 0,
				droppedEffects: built.value.rejected,
				rejectedActions: 0,
				complete: true,
			},
			cost: ZERO_COST,
			logPath: eventLogPath(outDir),
		};
		writeFileSync(join(outDir, RESULT_FILE), JSON.stringify(result, null, "\t"));
		logger.info("oasis import finished", {
			agents: users.length,
			posts: posts.length,
			edges: follows.length,
			observations: summary.observations,
			decisions: summary.decisions,
		});
		return ok({
			result,
			outDir,
			agents: users.length,
			posts: posts.length,
			edges: follows.length,
			observations: summary.observations,
			decisions: summary.decisions,
			parseFailures: summary.parseFailures,
		});
	} finally {
		db.close();
	}
};

export interface OasisAdapterOptions extends ScriptAdapterOptions {
	readonly metrics: readonly MetricRequest[];
	readonly registry: Registry;
	readonly dbFile?: string | undefined;
	readonly logger?: Logger | undefined;
}

// Runs the external OASIS script, then imports the database it wrote into the run directory

export const createOasisAdapter = (options: OasisAdapterOptions): Adapter => {
	const script = createScriptAdapter({ ...options, name: options.name ?? OASIS_ADAPTER_KIND });
	const run: RunFn = async (scenario, seed, outDir) => {
		const executed = await executeScript(options, scenario, seed, outDir);
		if (executed.failure !== undefined)
			return failedScriptResult(executed.scenario, outDir, executed.failure, executed.wallMs);
		const imported = importOasis(
			join(outDir, options.dbFile ?? OASIS_DB_FILE),
			outDir,
			options.metrics,
			options.registry,
			{ overwrite: true, logger: options.logger },
		);
		if (!imported.ok)
			return failedScriptResult(
				executed.scenario,
				outDir,
				{ stage: "extract", excType: "OasisImport", message: imported.error, stack: "" },
				executed.wallMs,
			);
		const result = imported.value.result;
		return {
			...result,
			runId: makeRunId(executed.scenario.scenarioId, executed.scenario.replicationId),
			scenarioHash: scenarioHash(executed.scenario),
			seed: executed.scenario.seed,
			cost: { ...result.cost, wallMs: executed.wallMs },
		};
	};
	return { name: script.name, toScenario: script.toScenario, run };
};
