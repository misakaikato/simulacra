import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { silentLogger, type Logger } from "../logging/logger";
import { compareEvents, digestEvents, isEventKind } from "./events";
import { sha256Hex } from "./hash";
import type { EventLog } from "./protocols";
import type { EntityId, Event, EventFilter, EventId, JsonValue, Provenance } from "./types";

export const EVENT_LOG_FILE = "events.sqlite";
export const eventLogPath = (runDir: string): string => join(runDir, EVENT_LOG_FILE);

const PROVENANCES: readonly Provenance[] = [
	"llm",
	"surrogate",
	"prototype",
	"cache",
	"rule",
	"manual",
	"interview",
	"kernel",
];

const isProvenance = (s: string): s is Provenance => (PROVENANCES as readonly string[]).includes(s);

const upward = (start: Event, byId: (id: EventId) => Event | undefined): Event[] => {
	const out: Event[] = [];
	const seen = new Set<EventId>([start.eventId]);
	let parent = start.parent;
	while (parent !== undefined && !seen.has(parent)) {
		const e = byId(parent);
		if (e === undefined) break;
		seen.add(e.eventId);
		out.push(e);
		parent = e.parent;
	}
	return out;
};

const downward = (start: Event, childrenOf: (id: EventId) => readonly Event[]): Event[] => {
	const out: Event[] = [];
	const seen = new Set<EventId>([start.eventId]);
	const queue: Event[] = [start];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		for (const child of childrenOf(current.eventId)) {
			if (seen.has(child.eventId)) continue;
			seen.add(child.eventId);
			out.push(child);
			queue.push(child);
		}
	}
	return out;
};

const causalChain = (
	start: Event | undefined,
	byId: (id: EventId) => Event | undefined,
	childrenOf: (id: EventId) => readonly Event[],
): readonly Event[] => {
	if (start === undefined) return [];
	return [...upward(start, byId), start, ...downward(start, childrenOf)].sort(compareEvents);
};

const matches = (e: Event, filter: EventFilter): boolean => {
	if (filter.kind !== undefined && !filter.kind.includes(e.kind)) return false;
	if (filter.agentId !== undefined && e.agentId !== filter.agentId) return false;
	if (filter.tick !== undefined && e.t.tick !== filter.tick) return false;
	if (filter.fromTick !== undefined && e.t.tick < filter.fromTick) return false;
	if (filter.toTick !== undefined && e.t.tick > filter.toTick) return false;
	return true;
};

type EventRow = {
	event_id: string;
	run_id: string;
	tick: number;
	substep: number;
	seq: number;
	kind: string;
	agent_id: string | null;
	parent: string | null;
	seed_path: string;
	provenance: string | null;
	payload: string;
};

const toRow = (e: Event): EventRow => ({
	event_id: e.eventId,
	run_id: e.runId,
	tick: e.t.tick,
	substep: e.t.substep,
	seq: e.t.seq,
	kind: e.kind,
	agent_id: e.agentId ?? null,
	parent: e.parent ?? null,
	seed_path: JSON.stringify(e.seedPath),
	provenance: e.provenance ?? null,
	payload: JSON.stringify(e.payload),
});

const fromRow = (r: EventRow): Event => {
	if (!isEventKind(r.kind)) throw new TypeError(`unknown event kind '${r.kind}' in log`);
	const seedPath = JSON.parse(r.seed_path) as readonly number[];
	const payload = JSON.parse(r.payload) as JsonValue;
	const event = {
		eventId: r.event_id as EventId,
		runId: r.run_id as Event["runId"],
		t: { tick: r.tick, substep: r.substep, seq: r.seq },
		seedPath,
		...(r.agent_id === null ? {} : { agentId: r.agent_id as EntityId }),
		...(r.parent === null ? {} : { parent: r.parent as EventId }),
		...(r.provenance !== null && isProvenance(r.provenance)
			? { provenance: r.provenance }
			: {}),
		kind: r.kind,
		payload,
	};
	return event as Event;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	event_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	tick INTEGER NOT NULL,
	substep INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	agent_id TEXT,
	parent TEXT,
	seed_path TEXT NOT NULL,
	provenance TEXT,
	payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_time ON events(tick, substep, seq);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, tick);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS events_parent ON events(parent);
CREATE TABLE IF NOT EXISTS content (sha TEXT PRIMARY KEY, text TEXT NOT NULL);
`;

const ORDER = "ORDER BY tick, substep, seq, event_id";

class SqliteEventLog implements EventLog {
	private readonly db: Database;
	private inTick = false;
	private readonly insertEvent;
	private readonly insertContent;
	private readonly selectContent;
	private readonly selectById;
	private readonly selectChildren;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.insertEvent = this.db.query<void, EventRow>(
			`INSERT INTO events (event_id, run_id, tick, substep, seq, kind, agent_id, parent, seed_path, provenance, payload)
			 VALUES ($event_id, $run_id, $tick, $substep, $seq, $kind, $agent_id, $parent, $seed_path, $provenance, $payload)`,
		);
		this.insertContent = this.db.query<void, { sha: string; text: string }>(
			"INSERT OR IGNORE INTO content (sha, text) VALUES ($sha, $text)",
		);
		this.selectContent = this.db.query<{ text: string }, [string]>(
			"SELECT text FROM content WHERE sha = ?",
		);
		this.selectById = this.db.query<EventRow, [string]>(
			"SELECT * FROM events WHERE event_id = ?",
		);
		this.selectChildren = this.db.query<EventRow, [string]>(
			`SELECT * FROM events WHERE parent = ? ${ORDER}`,
		);
	}

	append(e: Event): void {
		this.insertEvent.run(toRow(e));
	}

	beginTick(): void {
		if (this.inTick) throw new Error("beginTick called while a tick batch is open");
		this.db.exec("BEGIN");
		this.inTick = true;
	}

	endTick(): void {
		if (!this.inTick) throw new Error("endTick called without an open tick batch");
		this.db.exec("COMMIT");
		this.inTick = false;
	}

	putContent(text: string): string {
		const sha = sha256Hex(text);
		this.insertContent.run({ sha, text });
		return sha;
	}

	getContent(sha: string): string | undefined {
		return this.selectContent.get(sha)?.text;
	}

	query(filter: EventFilter): readonly Event[] {
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (filter.kind !== undefined) {
			if (filter.kind.length === 0) return [];
			clauses.push(`kind IN (${filter.kind.map(() => "?").join(", ")})`);
			params.push(...filter.kind);
		}
		if (filter.agentId !== undefined) {
			clauses.push("agent_id = ?");
			params.push(filter.agentId);
		}
		if (filter.tick !== undefined) {
			clauses.push("tick = ?");
			params.push(filter.tick);
		}
		if (filter.fromTick !== undefined) {
			clauses.push("tick >= ?");
			params.push(filter.fromTick);
		}
		if (filter.toTick !== undefined) {
			clauses.push("tick <= ?");
			params.push(filter.toTick);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const limit = filter.limit === undefined ? -1 : filter.limit;
		const offset = filter.offset ?? 0;
		const rows = this.db
			.query<EventRow, (string | number)[]>(
				`SELECT * FROM events ${where} ${ORDER} LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset);
		return rows.map(fromRow);
	}

	sql<T>(sql: string, params: readonly (string | number)[] = []): readonly T[] {
		this.db.exec("PRAGMA query_only = 1");
		try {
			return this.db.query<T, (string | number)[]>(sql).all(...params);
		} finally {
			this.db.exec("PRAGMA query_only = 0");
		}
	}

	chain(eventId: EventId): readonly Event[] {
		const byId = (id: EventId): Event | undefined => {
			const row = this.selectById.get(id);
			return row === null ? undefined : fromRow(row);
		};
		const childrenOf = (id: EventId): readonly Event[] =>
			this.selectChildren.all(id).map(fromRow);
		return causalChain(byId(eventId), byId, childrenOf);
	}

	digest(): string {
		const rows = this.db.query<EventRow, []>(`SELECT * FROM events ${ORDER}`);
		const events = (function* () {
			for (const row of rows.iterate()) yield fromRow(row);
		})();
		return digestEvents(events);
	}

	count(): number {
		return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
	}

	close(): void {
		if (this.inTick) this.endTick();
		this.db.close();
	}
}

export const openSqliteEventLog = (path: string): EventLog => new SqliteEventLog(path);

class MemoryEventLog implements EventLog {
	private readonly events: Event[] = [];
	private readonly byId = new Map<EventId, Event>();
	private readonly children = new Map<EventId, Event[]>();
	private readonly content = new Map<string, string>();
	private readonly logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger;
	}

	append(e: Event): void {
		if (this.byId.has(e.eventId)) throw new Error(`duplicate event id ${e.eventId}`);
		this.events.push(e);
		this.byId.set(e.eventId, e);
		if (e.parent !== undefined) {
			const siblings = this.children.get(e.parent);
			if (siblings === undefined) this.children.set(e.parent, [e]);
			else siblings.push(e);
		}
	}

	beginTick(): void {}

	endTick(): void {}

	putContent(text: string): string {
		const sha = sha256Hex(text);
		if (!this.content.has(sha)) this.content.set(sha, text);
		return sha;
	}

	getContent(sha: string): string | undefined {
		return this.content.get(sha);
	}

	query(filter: EventFilter): readonly Event[] {
		const sorted = this.events.filter((e) => matches(e, filter)).sort(compareEvents);
		const offset = filter.offset ?? 0;
		const end = filter.limit === undefined ? sorted.length : offset + filter.limit;
		return sorted.slice(offset, end);
	}

	sql<T>(sql: string): readonly T[] {
		this.logger.warn("MemoryEventLog does not support sql()", { sql });
		return [];
	}

	chain(eventId: EventId): readonly Event[] {
		return causalChain(
			this.byId.get(eventId),
			(id) => this.byId.get(id),
			(id) => [...(this.children.get(id) ?? [])].sort(compareEvents),
		);
	}

	digest(): string {
		return digestEvents([...this.events].sort(compareEvents));
	}

	count(): number {
		return this.events.length;
	}

	close(): void {}
}

export const createMemoryEventLog = (logger: Logger = silentLogger): EventLog =>
	new MemoryEventLog(logger);
