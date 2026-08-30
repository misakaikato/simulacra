import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_FILES, loadCheckpoint, saveCheckpoint } from "../../src/core/checkpoint";
import { toEventId } from "../../src/core/ids";
import { applyEffects } from "../../src/core/resolver";
import { rngFromSeed } from "../../src/core/rng";
import { timeAt } from "../../src/core/time";
import type { ColumnDecl } from "../../src/core/types";
import { createWorld } from "../../src/core/world";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-ckpt-"));
const cause = toEventId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

const buildWorld = () => {
	const world = createWorld();
	const decls: ColumnDecl[] = [
		{
			entity: "agent",
			name: "score",
			dtype: "f64",
			default: 0,
			owner: "kernel",
			merge: "last",
		},
		{
			entity: "agent",
			name: "tags",
			dtype: "strlist",
			default: [],
			owner: "feed",
			merge: "append",
		},
		{ entity: "post", name: "text", dtype: "str", default: "", owner: "feed", merge: "last" },
	];
	for (const d of decls) {
		const r = world.declare(d);
		if (!r.ok) throw new Error(r.error.message);
	}
	const rng = rngFromSeed(3, [1]);
	const ids = world.create("agent", [{ score: 1 }, { score: 2, "feed.tags": ["a"] }], rng);
	world.create("post", [{ "feed.text": "hello" }], rng);
	applyEffects(
		world,
		[
			{
				op: "set",
				entity: "agent",
				id: ids[0] as (typeof ids)[number],
				column: "score",
				value: 5,
				cause,
			},
			{ op: "envSet", key: "calendar.current", value: { day: 4 }, cause },
		],
		timeAt(2),
	);
	return world;
};

const input = (dir: string) => {
	const world = buildWorld();
	const state = {
		world,
		clock: { now: timeAt(3) },
		executors: { focal: { memory: ["x"] } },
		providers: { mock: { calls: 12 } },
		rngPaths: { tick: [7, 3] },
		scenarioHash: "scenario-abc",
		digest: "digest-1",
		lastEventId: toEventId("01ARZ3NDEKTSV4RRFFQ69G5FB2"),
	};
	return { state, saved: saveCheckpoint(state, dir) };
};

describe("checkpoint", () => {
	test("save then load restores an identical world and the recorded state", () => {
		const dir = tempDir();
		const { state, saved } = input(dir);
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		expect(saved.value.worldHash).toBe(state.world.hash());
		for (const name of Object.values(CHECKPOINT_FILES)) {
			expect(() => JSON.parse(readFileSync(join(dir, name), "utf8"))).not.toThrow();
		}
		const loaded = loadCheckpoint(dir, "scenario-abc");
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.value.worldHash).toBe(saved.value.worldHash);
		expect(loaded.value.world.hash()).toBe(state.world.hash());
		expect(loaded.value.world.count("agent")).toBe(2);
		expect(loaded.value.world.env("calendar.current")).toEqual({ day: 4 });
		expect(loaded.value.clock.now).toEqual(timeAt(3));
		expect(loaded.value.executors).toEqual({ focal: { memory: ["x"] } });
		expect(loaded.value.providers).toEqual({ mock: { calls: 12 } });
		expect(loaded.value.rngPaths).toEqual({ tick: [7, 3] });
		expect(loaded.value.digest).toBe("digest-1");
		expect(String(loaded.value.lastEventId)).toBe("01ARZ3NDEKTSV4RRFFQ69G5FB2");
	});

	test("refuses to save in the middle of a tick", () => {
		const dir = tempDir();
		const state = { ...input(tempDir()).state, clock: { now: timeAt(3, 1, 0) } };
		expect(saveCheckpoint(state, dir).ok).toBe(false);
		expect(saveCheckpoint({ ...state, clock: { now: timeAt(3, 0, 4) } }, dir).ok).toBe(false);
	});

	test("a different scenario hash is ConfigDrift", () => {
		const dir = tempDir();
		input(dir);
		const loaded = loadCheckpoint(dir, "scenario-other");
		expect(loaded.ok).toBe(false);
		if (!loaded.ok) expect(loaded.error.kind).toBe("ConfigDrift");
	});

	test("missing, malformed or tampered files are Corrupt", () => {
		const missing = loadCheckpoint(join(tempDir(), "nope"), "scenario-abc");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.kind).toBe("Corrupt");

		const badJson = tempDir();
		input(badJson);
		writeFileSync(join(badJson, CHECKPOINT_FILES.world), "{not json");
		const malformed = loadCheckpoint(badJson, "scenario-abc");
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.error.kind).toBe("Corrupt");

		const tampered = tempDir();
		input(tampered);
		const worldPath = join(tampered, CHECKPOINT_FILES.world);
		const snapshot = JSON.parse(readFileSync(worldPath, "utf8")) as {
			env: Record<string, unknown>;
		};
		snapshot.env["calendar.current"] = { day: 5 };
		writeFileSync(worldPath, JSON.stringify(snapshot));
		const drifted = loadCheckpoint(tampered, "scenario-abc");
		expect(drifted.ok).toBe(false);
		if (!drifted.ok) {
			expect(drifted.error.kind).toBe("Corrupt");
			expect(drifted.error.message).toContain("hashes to");
		}

		const wrongShape = tempDir();
		input(wrongShape);
		writeFileSync(join(wrongShape, CHECKPOINT_FILES.meta), JSON.stringify({ version: 2 }));
		const shape = loadCheckpoint(wrongShape, "scenario-abc");
		expect(shape.ok).toBe(false);
		if (!shape.ok) expect(shape.error.kind).toBe("Corrupt");
	});
});
