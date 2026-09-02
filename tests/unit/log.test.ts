import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_KINDS, compareEvents, isEventKind, makeEvent } from "../../src/core/events";
import { makeRunId, newEntityId, newEventId, toEntityId, toEventId } from "../../src/core/ids";
import { createMemoryEventLog, eventLogPath, openSqliteEventLog } from "../../src/core/log";
import type { EventLog } from "../../src/core/protocols";
import { rngFromSeed } from "../../src/core/rng";
import { timeAt } from "../../src/core/time";
import type { EntityId, Event, EventId } from "../../src/core/types";
import { createLogger } from "../../src/logging/logger";
import { memorySink } from "../../src/logging/sinks";

const runId = makeRunId("test", 0);

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-log-"));

const impls: readonly { readonly name: string; readonly open: () => EventLog }[] = [
	{ name: "SqliteEventLog", open: () => openSqliteEventLog(eventLogPath(tempDir())) },
	{ name: "MemoryEventLog", open: () => createMemoryEventLog() },
];

const generate = (
	n: number,
	seed = 1,
): { readonly events: readonly Event[]; readonly agents: readonly EntityId[] } => {
	const rng = rngFromSeed(seed, [0]);
	const agents = Array.from({ length: 5 }, () => newEntityId(rng));
	const events: Event[] = [];
	let lastActivation: EventId | undefined;
	for (let i = 0; i < n; i += 1) {
		const tick = Math.floor(i / 10);
		const t = timeAt(tick, 0, i % 10);
		const agentId = agents[i % agents.length] as EntityId;
		const eventId = newEventId(rng);
		if (i % 10 === 0) {
			lastActivation = eventId;
			events.push(
				makeEvent(
					{ eventId, runId, t, seedPath: [0, tick] },
					{
						kind: "activation",
						payload: { policy: "allAgents", agentIds: agents, modes: {} },
					},
				),
			);
		} else if (i % 3 === 0) {
			events.push(
				makeEvent(
					{ eventId, runId, t, seedPath: [0, tick], agentId, provenance: "kernel" },
					{
						kind: "failure",
						payload: { stage: "run", excType: "E", message: `m${i}`, retryable: false },
					},
				),
			);
		} else {
			events.push(
				makeEvent(
					{
						eventId,
						runId,
						t,
						seedPath: [0, tick],
						agentId,
						...(lastActivation === undefined ? {} : { parent: lastActivation }),
					},
					{
						kind: "decision",
						payload: { action: "post", args: { i }, provider: "mock", parseOk: true },
					},
				),
			);
		}
	}
	return { events, agents };
};

describe("events", () => {
	test("makeEvent only includes optional fields that are present", () => {
		const rng = rngFromSeed(1, []);
		const e = makeEvent(
			{ eventId: newEventId(rng), runId, t: timeAt(0), seedPath: [] },
			{ kind: "checkpoint", payload: { path: "p", worldHash: "h" } },
		);
		expect("agentId" in e).toBe(false);
		expect("parent" in e).toBe(false);
		expect(e.kind).toBe("checkpoint");
		expect(EVENT_KINDS).toHaveLength(12);
		expect(isEventKind("decision")).toBe(true);
		expect(isEventKind("decision_batch")).toBe(true);
		expect(isEventKind("nope")).toBe(false);
	});

	test("compareEvents orders by time then id", () => {
		const { events } = generate(30);
		const shuffled = rngFromSeed(3, []).shuffle(events);
		const sorted = [...shuffled].sort(compareEvents);
		expect(sorted.map((e) => e.eventId)).toEqual(events.map((e) => e.eventId));
	});
});

for (const impl of impls) {
	describe(impl.name, () => {
		test("stores 10k events with a correct count and stable queries", () => {
			const log = impl.open();
			const { events, agents } = generate(10000);
			log.beginTick();
			for (const e of events) log.append(e);
			log.endTick();
			expect(log.count()).toBe(10000);
			expect(log.query({ kind: ["activation"] })).toHaveLength(1000);
			expect(log.query({ tick: 3 })).toHaveLength(10);
			expect(log.query({ fromTick: 10, toTick: 19 })).toHaveLength(100);
			expect(
				log.query({ agentId: agents[0] as EntityId, tick: 0 }).map((e) => e.t.seq),
			).toEqual([5]);
			const page = log.query({ limit: 7, offset: 3 });
			expect(page.map((e) => e.t.seq)).toEqual([3, 4, 5, 6, 7, 8, 9]);
			expect(log.query({ kind: [] })).toEqual([]);
			const all = log.query({});
			expect(all).toHaveLength(10000);
			expect(all[0]).toEqual(events[0] as Event);
			expect(all[9999]).toEqual(events[9999] as Event);
			log.close();
		});

		test("chain collects ancestors and descendants sorted by time", () => {
			const log = impl.open();
			const rng = rngFromSeed(5, []);
			const id = () => newEventId(rng);
			const fields = (eventId: EventId, seq: number, parent?: EventId) => ({
				eventId,
				runId,
				t: timeAt(1, 0, seq),
				seedPath: [1],
				...(parent === undefined ? {} : { parent }),
			});
			const [root, obs, dec, eff1, eff2, other] = [id(), id(), id(), id(), id(), id()];
			const events: Event[] = [
				makeEvent(fields(root, 0), {
					kind: "activation",
					payload: { policy: "p", agentIds: [], modes: {} },
				}),
				makeEvent(fields(obs, 1, root), {
					kind: "observation",
					payload: { contentSha: "s", refs: [], truncated: false },
				}),
				makeEvent(fields(dec, 2, obs), {
					kind: "decision",
					payload: { action: "a", args: {}, provider: "mock", parseOk: true },
				}),
				makeEvent(fields(eff1, 3, dec), {
					kind: "effect",
					payload: { effects: [], rejected: [] },
				}),
				makeEvent(fields(eff2, 4, dec), {
					kind: "effect",
					payload: { effects: [], rejected: [] },
				}),
				makeEvent(fields(other, 5, root), {
					kind: "observation",
					payload: { contentSha: "t", refs: [], truncated: false },
				}),
			];
			for (const e of rngFromSeed(6, []).shuffle(events)) log.append(e);
			expect(log.chain(dec).map((e) => e.eventId)).toEqual([root, obs, dec, eff1, eff2]);
			expect(log.chain(obs).map((e) => e.eventId)).toEqual([root, obs, dec, eff1, eff2]);
			expect(log.chain(eff2).map((e) => e.eventId)).toEqual([root, obs, dec, eff2]);
			expect(log.chain(root).map((e) => e.eventId)).toEqual([
				root,
				obs,
				dec,
				eff1,
				eff2,
				other,
			]);
			expect(log.chain(toEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV"))).toEqual([]);
			log.close();
		});

		test("batchesOf finds batch events by agentIds membership, not by agentId", () => {
			const log = impl.open();
			const rng = rngFromSeed(7, []);
			const [a, b, c] = ["A", "B", "C"].map(toEntityId) as [EntityId, EntityId, EntityId];
			const cost = {
				llmCalls: 0,
				promptTokens: 0,
				completionTokens: 0,
				cachedTokens: 0,
				wallMs: 0,
			};
			const at = (tick: number, seq: number, agentId?: EntityId) => ({
				eventId: newEventId(rng),
				runId,
				t: timeAt(tick, 1, seq),
				seedPath: [tick],
				...(agentId === undefined ? {} : { agentId }),
			});
			const events: Event[] = [
				makeEvent(at(1, 0), {
					kind: "observation_batch",
					payload: { executor: "crowd", agentIds: [a, b], count: 2 },
				}),
				makeEvent(at(1, 1), {
					kind: "decision_batch",
					payload: {
						executor: "crowd",
						provider: "rule",
						agentIds: [a, b],
						actions: ["post", "silent"],
						provenance: "rule",
						parseFailures: 0,
						cost,
					},
				}),
				makeEvent(at(1, 2, a), {
					kind: "decision",
					payload: { action: "post", args: {}, provider: "mock", parseOk: true },
				}),
				makeEvent(at(2, 0), {
					kind: "observation_batch",
					payload: { executor: "crowd", agentIds: [b], count: 1 },
				}),
			];
			log.beginTick();
			for (const e of events) log.append(e);
			log.endTick();
			expect(log.batchesOf(a).map((e) => e.kind)).toEqual([
				"observation_batch",
				"decision_batch",
			]);
			expect(log.batchesOf(b).map((e) => e.t.tick)).toEqual([1, 1, 2]);
			expect(log.batchesOf(b, { tick: 2 })).toEqual([events[3] as Event]);
			expect(log.batchesOf(b, { kind: ["decision_batch"] })).toHaveLength(1);
			expect(log.batchesOf(b, { kind: [] })).toEqual([]);
			expect(log.batchesOf(b, { limit: 1, offset: 1 }).map((e) => e.kind)).toEqual([
				"decision_batch",
			]);
			expect(log.batchesOf(c)).toEqual([]);
			expect(log.query({ agentId: a }).map((e) => e.kind)).toEqual(["decision"]);
			log.close();
		});

		test("digest is stable across instances and append order, and sensitive to content", () => {
			const { events } = generate(200, 9);
			const a = impl.open();
			for (const e of events) a.append(e);
			const b = impl.open();
			for (const e of rngFromSeed(2, []).shuffle(events)) b.append(e);
			expect(a.digest()).toBe(b.digest());
			expect(a.digest()).toBe(a.digest());
			const c = impl.open();
			for (const e of events.slice(0, 199)) c.append(e);
			expect(c.digest()).not.toBe(a.digest());
			a.close();
			b.close();
			c.close();
		});

		test("content store is addressed by sha256", () => {
			const log = impl.open();
			const sha = log.putContent("hello world");
			expect(sha).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
			expect(log.putContent("hello world")).toBe(sha);
			expect(log.getContent(sha)).toBe("hello world");
			expect(log.getContent("missing")).toBeUndefined();
			log.close();
		});
	});
}

describe("log implementations agree", () => {
	test("sqlite and memory logs produce the same digest and query results", () => {
		const { events } = generate(500, 4);
		const sqlite = openSqliteEventLog(eventLogPath(tempDir()));
		const memory = createMemoryEventLog();
		for (const e of events) {
			sqlite.append(e);
			memory.append(e);
		}
		expect(sqlite.digest()).toBe(memory.digest());
		expect(sqlite.query({ kind: ["failure"], fromTick: 2, toTick: 4 })).toEqual(
			memory.query({ kind: ["failure"], fromTick: 2, toTick: 4 }),
		);
		sqlite.close();
		memory.close();
	});
});

describe("sql", () => {
	test("sqlite runs read-only SQL and refuses writes", () => {
		const log = openSqliteEventLog(eventLogPath(tempDir()));
		const { events } = generate(50);
		for (const e of events) log.append(e);
		const rows = log.sql<{ kind: string; n: number }>(
			"SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY kind",
		);
		expect(rows).toEqual([
			{ kind: "activation", n: 5 },
			{ kind: "decision", n: 30 },
			{ kind: "failure", n: 15 },
		]);
		expect(
			log.sql<{ tick: number }>("SELECT tick FROM events WHERE tick = ? LIMIT 1", [2]),
		).toEqual([{ tick: 2 }]);
		expect(() => log.sql("DELETE FROM events")).toThrow();
		expect(log.count()).toBe(50);
		log.append({ ...(events[0] as Event), eventId: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV") });
		expect(log.count()).toBe(51);
		log.close();
	});

	test("memory log returns no rows and logs a warning", () => {
		const sink = memorySink();
		const log = createMemoryEventLog(createLogger({ level: "warn", sinks: [sink] }));
		expect(log.sql("SELECT 1")).toEqual([]);
		expect(sink.records).toHaveLength(1);
		expect(sink.records[0]?.level).toBe("warn");
	});
});

describe("tick batches", () => {
	test("sqlite rejects unbalanced beginTick/endTick and commits on close", () => {
		const path = eventLogPath(tempDir());
		const log = openSqliteEventLog(path);
		const { events } = generate(20);
		log.beginTick();
		expect(() => log.beginTick()).toThrow();
		for (const e of events) log.append(e);
		log.close();
		const reopened = openSqliteEventLog(path);
		expect(reopened.count()).toBe(20);
		expect(() => reopened.endTick()).toThrow();
		reopened.close();
	});
});

describe("digest and failure stacks", () => {
	test("stack traces are kept on failure events but excluded from the digest", () => {
		const build = (stack: string) => {
			const log = createMemoryEventLog();
			log.append(
				makeEvent(
					{
						eventId: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
						runId: makeRunId("d", 0),
						t: timeAt(0, 1, 1),
						seedPath: [0],
					},
					{
						kind: "failure",
						payload: {
							stage: "resolve",
							excType: "ActionRejected",
							message: "unknown post",
							stack,
							retryable: false,
						},
					},
				),
			);
			return log;
		};
		const a = build("Error: x\n    at a (file.ts:1:1)");
		const b = build("Error: x\n    at b (other.ts:9:9)");
		expect(a.digest()).toBe(b.digest());
		const stored = a.query({ kind: ["failure"] })[0];
		expect(stored?.kind === "failure" && stored.payload.stack).toContain("file.ts");
	});
});
