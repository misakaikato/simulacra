import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observableLog } from "../../src/core/bus";
import { makeEvent } from "../../src/core/events";
import { toEventId, toRunId } from "../../src/core/ids";
import { createMemoryEventLog } from "../../src/core/log";
import { replayWorld } from "../../src/core/replay";
import { runScenario } from "../../src/core/run";
import { openRunLog } from "../../src/core/runDir";
import type { Event } from "../../src/core/types";
import { gatewayFactory, kernelRegistry, kernelScenario } from "../helpers/kernel";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-bus-"));

const eventAt = (n: number): Event =>
	makeEvent(
		{
			eventId: toEventId(`0000000000000000000000000${n}`),
			runId: toRunId("bus:0"),
			t: { tick: n, substep: 0, seq: 0 },
			seedPath: [],
		},
		{ kind: "checkpoint", payload: { path: `checkpoints/${n}`, worldHash: "h" } },
	);

describe("observableLog", () => {
	test("forwards every appended event and delegates the rest of the interface", () => {
		const inner = createMemoryEventLog();
		const seen: Event[] = [];
		const log = observableLog(inner, (e) => seen.push(e));
		log.beginTick();
		log.append(eventAt(1));
		log.append(eventAt(2));
		log.endTick();
		expect(seen.map((e) => e.t.tick)).toEqual([1, 2]);
		expect(log.count()).toBe(2);
		expect(inner.count()).toBe(2);
		expect(log.query({ tick: 2 })).toHaveLength(1);
		expect(log.digest()).toBe(inner.digest());
		const sha = log.putContent("hello");
		expect(log.getContent(sha)).toBe("hello");
		expect(inner.getContent(sha)).toBe("hello");
		expect(log.chain(eventAt(1).eventId)).toHaveLength(1);
		expect(log.sql("SELECT 1")).toEqual([]);
	});

	test("runScenario's onEvent sees exactly the events written to the run log, in order", async () => {
		const out = tempDir();
		const fixture = kernelRegistry();
		const seen: Event[] = [];
		const r = await runScenario(kernelScenario(), fixture.registry, out, {
			createGateway: gatewayFactory,
			onEvent: (e) => seen.push(e),
		});
		expect(r.ok && r.value.status).toBe("succeeded");
		const stored = openRunLog(out);
		expect(stored.ok).toBe(true);
		if (!stored.ok) return;
		try {
			const all = stored.value.query({});
			expect(seen.map((e) => e.eventId)).toEqual(all.map((e) => e.eventId));
			expect(seen.filter((e) => e.kind === "activation")).toHaveLength(3);
		} finally {
			stored.value.close();
		}
		const replayed = replayWorld(out);
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) return;
		expect(replayed.value.tick).toBe(3);
		expect(replayed.value.world.count("agent")).toBe(3);
		expect(replayed.value.world.hash()).toBe(replayed.value.worldHash);
		const early = replayWorld(out, 1);
		expect(early.ok && early.value.tick).toBe(1);
		expect(early.ok && early.value.world.column<number>("agent", "score").toArray()).toEqual([
			1, 1, 1,
		]);
	});
});
