import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ColumnConflict, Rng, World } from "./protocols";
import { err, ok } from "./result";
import { keyFromLabel } from "./rng";
import type { ColumnDtype, EntityId, PersonaField, PopulationSpec, Result, Scalar } from "./types";

export const PERSONA_OWNER = "persona";
export const PERSONA_PREFIX = `${PERSONA_OWNER}.`;
export const AGENT_ENTITY = "agent";
export const ORDINAL_COLUMN = "ordinal";

export interface PopulationError {
	readonly kind: "PopulationError";
	readonly message: string;
}

type Row = Readonly<Record<string, Scalar>>;

const defaultFor = (dtype: ColumnDtype): Scalar => {
	switch (dtype) {
		case "f64":
		case "i32":
			return 0;
		case "bool":
			return false;
		case "str":
			return "";
		case "strlist":
			return [];
	}
};

const fail = (message: string): Result<never, PopulationError> =>
	err({ kind: "PopulationError", message });

export const coerceScalar = (dtype: ColumnDtype, raw: unknown): Result<Scalar, string> => {
	switch (dtype) {
		case "f64":
		case "i32": {
			const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
			if (!Number.isFinite(n)) return err(`'${String(raw)}' is not a number`);
			if (dtype === "i32" && !Number.isInteger(n))
				return err(`'${String(raw)}' is not an integer`);
			return ok(n);
		}
		case "bool":
			if (typeof raw === "boolean") return ok(raw);
			if (raw === "true" || raw === "1") return ok(true);
			if (raw === "false" || raw === "0" || raw === "") return ok(false);
			return err(`'${String(raw)}' is not a boolean`);
		case "str":
			if (typeof raw === "string") return ok(raw);
			if (typeof raw === "number" || typeof raw === "boolean") return ok(String(raw));
			return err(`'${String(raw)}' is not a string`);
		case "strlist":
			if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) return ok([...raw]);
			if (typeof raw === "string") return ok(raw.length === 0 ? [] : raw.split("|"));
			return err(`'${String(raw)}' is not a string list`);
	}
};

const weightedIndex = (rng: Rng, weights: readonly number[]): number => {
	const total = weights.reduce((a, b) => a + b, 0);
	if (!(total > 0)) return rng.int(weights.length);
	let u = rng.next() * total;
	for (let i = 0; i < weights.length; i += 1) {
		u -= weights[i] ?? 0;
		if (u < 0) return i;
	}
	return weights.length - 1;
};

const sampleField = (field: PersonaField, rng: Rng): Result<Scalar, string> => {
	const s = field.sampling;
	switch (s.kind) {
		case "value":
			return coerceScalar(field.dtype, s.value);
		case "choice": {
			const weights = s.weights ?? s.choices.map(() => 1);
			if (weights.length !== s.choices.length)
				return err(
					`field '${field.name}': ${weights.length} weights for ${s.choices.length} choices`,
				);
			const choice = s.choices[weightedIndex(rng, weights)];
			return coerceScalar(field.dtype, choice ?? null);
		}
		case "range":
			if (field.dtype === "f64") return ok(s.min + rng.next() * (s.max - s.min));
			if (field.dtype === "i32")
				return ok(Math.floor(s.min) + rng.int(Math.floor(s.max) - Math.floor(s.min) + 1));
			return err(`field '${field.name}': range sampling needs a numeric dtype`);
	}
};

const synthesize = (spec: PopulationSpec, rng: Rng): Result<readonly Row[], PopulationError> => {
	const rows: Row[] = [];
	for (let i = 0; i < spec.n; i += 1) {
		const row: Record<string, Scalar> = {};
		for (const field of spec.fields) {
			const value = sampleField(field, rng);
			if (!value.ok) return fail(value.error);
			row[`${PERSONA_PREFIX}${field.name}`] = value.value;
		}
		rows.push(row);
	}
	return ok(rows);
};

export const parseCsv = (text: string): readonly Readonly<Record<string, string>>[] => {
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	let quoted = false;
	let i = 0;
	const endRecord = () => {
		record.push(field);
		field = "";
		if (record.length > 1 || (record[0] ?? "").length > 0) records.push(record);
		record = [];
	};
	while (i < text.length) {
		const c = text[i] ?? "";
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i += 2;
				continue;
			}
			if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			record.push(field);
			field = "";
		} else if (c === "\n") endRecord();
		else if (c !== "\r") field += c;
		i += 1;
	}
	if (field.length > 0 || record.length > 0) endRecord();
	const header = records[0] ?? [];
	return records.slice(1).map((values) => {
		const out: Record<string, string> = {};
		header.forEach((h, k) => {
			out[h] = values[k] ?? "";
		});
		return out;
	});
};

type RawRecord = Readonly<Record<string, unknown>>;

const isRawRecords = (v: unknown): v is readonly RawRecord[] =>
	Array.isArray(v) && v.every((r) => typeof r === "object" && r !== null && !Array.isArray(r));

const readSource = (
	source: Exclude<PopulationSpec["source"], { readonly kind: "synthetic" }>,
): Result<readonly RawRecord[], PopulationError> => {
	if (!isAbsolute(source.path))
		return fail(`population source path must be absolute, got '${source.path}'`);
	let text: string;
	try {
		text = readFileSync(source.path, "utf8");
	} catch (e) {
		return fail(`cannot read population source: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (source.kind === "csv") return ok(parseCsv(text));
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return fail(`population source is not JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!isRawRecords(parsed)) return fail("population JSON must be an array of objects");
	return ok(parsed);
};

const loadedRows = (
	spec: PopulationSpec,
	raw: readonly RawRecord[],
	rng: Rng,
): Result<readonly Row[], PopulationError> => {
	if (raw.length < spec.n)
		return fail(`population source has ${raw.length} rows, population.n is ${spec.n}`);
	const rows: Row[] = [];
	for (const record of raw.slice(0, spec.n)) {
		const row: Record<string, Scalar> = {};
		for (const field of spec.fields) {
			const present = field.name in record && record[field.name] !== undefined;
			const value = present
				? coerceScalar(field.dtype, record[field.name])
				: sampleField(field, rng);
			if (!value.ok) return fail(`field '${field.name}': ${value.error}`);
			row[`${PERSONA_PREFIX}${field.name}`] = value.value;
		}
		rows.push(row);
	}
	return ok(rows);
};

const sourceRows = (spec: PopulationSpec, rng: Rng): Result<readonly Row[], PopulationError> => {
	if (spec.source.kind === "synthetic") return synthesize(spec, rng.fork(keyFromLabel("sample")));
	const raw = readSource(spec.source);
	if (!raw.ok) return raw;
	return loadedRows(spec, raw.value, rng.fork(keyFromLabel("fill")));
};

const apportion = (n: number, weights: readonly number[]): readonly number[] => {
	const total = weights.reduce((a, b) => a + b, 0);
	if (!(total > 0)) return weights.map(() => 0);
	const exact = weights.map((w) => (n * w) / total);
	const counts = exact.map(Math.floor);
	let remaining = n - counts.reduce((a, b) => a + b, 0);
	const order = exact
		.map((x, i) => ({ i, frac: x - Math.floor(x) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (const { i } of order) {
		if (remaining <= 0) break;
		counts[i] = (counts[i] ?? 0) + 1;
		remaining -= 1;
	}
	return counts;
};

const stratified = (
	spec: PopulationSpec,
	rows: readonly Row[],
	rng: Rng,
): Result<readonly Row[], PopulationError> => {
	if (spec.stratify === undefined) return ok(rows);
	let out = rows.map((r) => ({ ...r }));
	for (const [name, quotas] of Object.entries(spec.stratify)) {
		const field = spec.fields.find((f) => f.name === name);
		if (field === undefined) return fail(`stratify refers to unknown field '${name}'`);
		const keys = Object.keys(quotas);
		const counts = apportion(
			rows.length,
			keys.map((k) => quotas[k] ?? 0),
		);
		const values: Scalar[] = [];
		for (const [k, key] of keys.entries()) {
			const value = coerceScalar(field.dtype, key);
			if (!value.ok) return fail(`stratify '${name}': ${value.error}`);
			for (let c = 0; c < (counts[k] ?? 0); c += 1) values.push(value.value);
		}
		const assignment = rng.fork(keyFromLabel(`stratify:${name}`)).shuffle(values);
		out = out.map((row, i) => {
			const value = assignment[i];
			return value === undefined ? row : { ...row, [`${PERSONA_PREFIX}${name}`]: value };
		});
	}
	return ok(out);
};

const declareColumns = (spec: PopulationSpec, world: World): Result<void, ColumnConflict> => {
	const ordinal = world.declare({
		entity: AGENT_ENTITY,
		name: ORDINAL_COLUMN,
		dtype: "i32",
		default: 0,
		owner: "kernel",
		merge: "last",
	});
	if (!ordinal.ok) return ordinal;
	for (const field of spec.fields) {
		const declared = world.declare({
			entity: AGENT_ENTITY,
			name: field.name,
			dtype: field.dtype,
			default: defaultFor(field.dtype),
			owner: PERSONA_OWNER,
			merge: "last",
		});
		if (!declared.ok) return declared;
	}
	return ok(undefined);
};

export const buildPopulation = (
	spec: PopulationSpec,
	world: World,
	rng: Rng,
): Result<readonly EntityId[], PopulationError | ColumnConflict> => {
	const declared = declareColumns(spec, world);
	if (!declared.ok) return declared;
	const rows = sourceRows(spec, rng);
	if (!rows.ok) return rows;
	const finalRows = stratified(spec, rows.value, rng);
	if (!finalRows.ok) return finalRows;
	const withOrdinal = finalRows.value.map((row, i) => ({ ...row, [ORDINAL_COLUMN]: i }));
	try {
		return ok(world.create(AGENT_ENTITY, withOrdinal, rng.fork(keyFromLabel("ids"))));
	} catch (e) {
		return fail(`create agents: ${e instanceof Error ? e.message : String(e)}`);
	}
};
