import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPopulation, coerceScalar, parseCsv } from "../../src/core/population";
import { rngFromSeed } from "../../src/core/rng";
import { PopulationSpecSchema } from "../../src/core/schema";
import type { PopulationSpec } from "../../src/core/types";
import { createWorld } from "../../src/core/world";

const tempDir = () => mkdtempSync(join(tmpdir(), "simulacra-pop-"));

const spec = (input: Record<string, unknown>): PopulationSpec => PopulationSpecSchema.parse(input);

const fields = [
	{
		name: "name",
		dtype: "str",
		sampling: { kind: "choice", choices: ["a", "b"], weights: [1, 3] },
	},
	{ name: "age", dtype: "i32", sampling: { kind: "range", min: 18, max: 20 } },
	{ name: "trust", dtype: "f64", sampling: { kind: "range", min: 0, max: 1 } },
	{ name: "active", dtype: "bool", sampling: { kind: "value", value: true } },
	{ name: "tags", dtype: "strlist", sampling: { kind: "value", value: ["x"] } },
];

describe("buildPopulation", () => {
	test("synthesizes persona columns deterministically with an ordinal column", () => {
		const build = () => {
			const world = createWorld();
			const ids = buildPopulation(spec({ n: 50, fields }), world, rngFromSeed(3, [1]));
			if (!ids.ok) throw new Error(ids.error.message);
			return { world, ids: ids.value };
		};
		const a = build();
		const b = build();
		expect(a.ids).toHaveLength(50);
		expect(a.ids).toEqual(b.ids);
		expect(a.world.hash()).toBe(b.world.hash());
		expect(a.world.columns("agent").map((c) => c.name)).toEqual([
			"ordinal",
			"persona.name",
			"persona.age",
			"persona.trust",
			"persona.active",
			"persona.tags",
		]);
		expect(a.world.column<number>("agent", "ordinal").toArray()).toEqual(
			Array.from({ length: 50 }, (_, i) => i),
		);
		const names = a.world.column<string>("agent", "persona.name").toArray();
		expect(names.filter((n) => n === "b").length).toBeGreaterThan(
			names.filter((n) => n === "a").length,
		);
		const ages = a.world.column<number>("agent", "persona.age").toArray();
		expect(ages.every((x) => Number.isInteger(x) && x >= 18 && x <= 20)).toBe(true);
		expect(new Set(ages).size).toBe(3);
		const trust = a.world.column<number>("agent", "persona.trust").toArray();
		expect(trust.every((x) => x >= 0 && x < 1)).toBe(true);
		expect(a.world.row("agent", a.ids[0]!)).toMatchObject({
			"persona.active": true,
			"persona.tags": ["x"],
		});
	});

	test("stratify assigns quotas by seed", () => {
		const world = createWorld();
		const ids = buildPopulation(
			spec({
				n: 10,
				fields: [
					{ name: "group", dtype: "str", sampling: { kind: "value", value: "z" } },
					{ name: "level", dtype: "i32", sampling: { kind: "value", value: 0 } },
				],
				stratify: { group: { red: 0.7, blue: 0.3 }, level: { "1": 1, "2": 1 } },
			}),
			world,
			rngFromSeed(7, []),
		);
		expect(ids.ok).toBe(true);
		const groups = world.column<string>("agent", "persona.group").toArray();
		expect(groups.filter((g) => g === "red")).toHaveLength(7);
		expect(groups.filter((g) => g === "blue")).toHaveLength(3);
		expect(groups.slice(0, 7)).not.toEqual(Array(7).fill("red"));
		const levels = world.column<number>("agent", "persona.level").toArray();
		expect(levels.filter((l) => l === 1)).toHaveLength(5);
		expect(levels.filter((l) => l === 2)).toHaveLength(5);
		const unknown = buildPopulation(
			spec({ n: 2, fields: [], stratify: { ghost: { a: 1 } } }),
			createWorld(),
			rngFromSeed(1, []),
		);
		expect(unknown.ok).toBe(false);
	});

	test("reads CSV and JSON sources, coercing to declared dtypes", () => {
		const dir = tempDir();
		const csv = join(dir, "people.csv");
		writeFileSync(
			csv,
			'name,age,active,tags\n"Ann, Jr",30,true,a|b\nBob,41,false,\nCy,50,1,c\n',
		);
		const csvFields = [
			{ name: "name", dtype: "str", sampling: { kind: "value", value: "" } },
			{ name: "age", dtype: "i32", sampling: { kind: "value", value: 0 } },
			{ name: "active", dtype: "bool", sampling: { kind: "value", value: false } },
			{ name: "tags", dtype: "strlist", sampling: { kind: "value", value: [] } },
			{ name: "mood", dtype: "f64", sampling: { kind: "value", value: 0.5 } },
		];
		const world = createWorld();
		const ids = buildPopulation(
			spec({ n: 2, fields: csvFields, source: { kind: "csv", path: csv } }),
			world,
			rngFromSeed(1, []),
		);
		expect(ids.ok).toBe(true);
		if (!ids.ok) return;
		expect(world.row("agent", ids.value[0]!)).toMatchObject({
			"persona.name": "Ann, Jr",
			"persona.age": 30,
			"persona.active": true,
			"persona.tags": ["a", "b"],
			"persona.mood": 0.5,
		});
		expect(world.row("agent", ids.value[1]!)).toMatchObject({
			"persona.name": "Bob",
			"persona.tags": [],
		});
		expect(world.count("agent")).toBe(2);

		const json = join(dir, "people.json");
		writeFileSync(json, JSON.stringify([{ name: "Dee", age: 22, active: false, tags: ["q"] }]));
		const jsonWorld = createWorld();
		const fromJson = buildPopulation(
			spec({ n: 1, fields: csvFields, source: { kind: "json", path: json } }),
			jsonWorld,
			rngFromSeed(1, []),
		);
		expect(fromJson.ok).toBe(true);
		if (fromJson.ok)
			expect(jsonWorld.row("agent", fromJson.value[0]!)).toMatchObject({
				"persona.name": "Dee",
				"persona.tags": ["q"],
			});

		const tooFew = buildPopulation(
			spec({ n: 5, fields: csvFields, source: { kind: "csv", path: csv } }),
			createWorld(),
			rngFromSeed(1, []),
		);
		expect(tooFew.ok).toBe(false);
		const relative = buildPopulation(
			spec({ n: 1, fields: [], source: { kind: "csv", path: "people.csv" } }),
			createWorld(),
			rngFromSeed(1, []),
		);
		expect(relative.ok).toBe(false);
		if (!relative.ok) expect(relative.error.message).toContain("absolute");
		const missing = buildPopulation(
			spec({ n: 1, fields: [], source: { kind: "json", path: join(dir, "nope.json") } }),
			createWorld(),
			rngFromSeed(1, []),
		);
		expect(missing.ok).toBe(false);
	});

	test("parseCsv handles quotes, escaped quotes and CRLF", () => {
		expect(parseCsv('a,b\r\n1,"x ""y"" z"\r\n2,\r\n')).toEqual([
			{ a: "1", b: 'x "y" z' },
			{ a: "2", b: "" },
		]);
		expect(coerceScalar("i32", "3.5").ok).toBe(false);
		expect(coerceScalar("bool", "maybe").ok).toBe(false);
		expect(coerceScalar("strlist", "")).toEqual({ ok: true, value: [] });
	});
});
