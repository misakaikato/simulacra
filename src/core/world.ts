// Columnar world state and its single write path: typed column stores per entity, capacity
// doubling, same-tick merge by the column's rule with dtype re-validation, swap-remove delete,
// and a snapshot encoding whose canonical hash is the run's worldHash. Writes reach this file
// only through applyEffects (resolver.ts) via the internal handle.
// 列式世界状态与它唯一的写路径：每个实体的类型化列存储、容量翻倍、同 tick 按列的 merge 规则合并并
// 重新校验 dtype、swap-remove 删除，以及规范化哈希即 worldHash 的快照编码。写入只经 applyEffects
//（resolver.ts）通过内部句柄到达这里。

import { hashOf } from "./hash";
import { newEntityId } from "./ids";
import { attachInternals, type WorldInternals } from "./internal/worldInternals";
import type { ColumnConflict, ReadonlyColumn, Rng, World } from "./protocols";
import { err, ok } from "./result";
import type {
	ColumnDecl,
	ColumnDtype,
	ColumnSnapshot,
	EntityId,
	EntitySnapshot,
	JsonValue,
	Result,
	Scalar,
	WorldSnapshot,
} from "./types";

export class IdCollision extends Error {
	constructor(entity: string, id: string) {
		super(`entity '${entity}' already has id ${id}`);
		this.name = "IdCollision";
	}
}

// Columns are namespaced by owner so two plugins may declare the same name; kernel columns
// keep the bare name.
// 列按 owner 命名空间化，两个插件可以声明同名列；内核列保留裸名字。
export const qualifiedColumnName = (decl: Pick<ColumnDecl, "owner" | "name">): string =>
	decl.owner === "kernel" ? decl.name : `${decl.owner}.${decl.name}`;

const INITIAL_CAPACITY = 16;
const NEVER_WRITTEN = -1;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// writtenAt remembers the tick of each cell's last write; a second write in the same tick
// merges instead of replacing, which is what makes merge rules hold across two applyEffects
// calls within one tick.
// writtenAt 记录每个单元格最后一次写入的 tick；同一 tick 的第二次写入走合并而不是替换，
// merge 规则因此在一个 tick 内的两次 applyEffects 之间依然成立。
interface StoreBase {
	readonly decl: ColumnDecl;
	readonly qualified: string;
	writtenAt: Int32Array;
}

type ColumnStore = StoreBase &
	(
		| { readonly dtype: "f64"; data: Float64Array }
		| { readonly dtype: "i32"; data: Int32Array }
		| { readonly dtype: "bool"; data: Uint8Array }
		| { readonly dtype: "str"; data: string[] }
		| { readonly dtype: "strlist"; data: (readonly string[])[] }
	);

interface EntityTable {
	readonly name: string;
	readonly ids: EntityId[];
	readonly index: Map<EntityId, number>;
	capacity: number;
	readonly columns: Map<string, ColumnStore>;
}

const isStringList = (v: unknown): v is readonly string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

const describe = (v: Scalar): string =>
	v === null ? "null" : Array.isArray(v) ? "string[]" : typeof v;

// The dtype gate for every value entering a cell: declared defaults, created rows, effects
// and merge results all pass through it, so a typed array never holds an unrepresentable
// value.
// 所有进入单元格的值都要过的 dtype 关卡：声明的默认值、创建的行、效果与合并结果都经它检查，
// 类型化数组因此永远不会存入无法表示的值。
const coerce = (dtype: ColumnDtype, value: Scalar): Result<Scalar, string> => {
	switch (dtype) {
		case "f64":
			return typeof value === "number"
				? ok(value)
				: err(`expected f64, got ${describe(value)}`);
		case "i32":
			if (typeof value !== "number") return err(`expected i32, got ${describe(value)}`);
			if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX)
				return err(`expected i32, got ${value}`);
			return ok(value);
		case "bool":
			return typeof value === "boolean"
				? ok(value)
				: err(`expected bool, got ${describe(value)}`);
		case "str":
			return typeof value === "string"
				? ok(value)
				: err(`expected str, got ${describe(value)}`);
		case "strlist":
			return isStringList(value)
				? ok(Object.freeze([...value]))
				: err(`expected strlist, got ${describe(value)}`);
	}
};

// sum and max are numeric (bool as logical or), append is for str and strlist; mismatches
// are refused at declare so they can never surface as a runtime rejection.
// sum 与 max 只对数值有意义（bool 视为逻辑或），append 只对 str 与 strlist；不匹配在 declare 时拒绝，
// 不会拖到运行时才暴露。
const validMerge = (decl: ColumnDecl): boolean => {
	switch (decl.merge) {
		case "last":
			return true;
		case "sum":
		case "max":
			return decl.dtype === "f64" || decl.dtype === "i32" || decl.dtype === "bool";
		case "append":
			return decl.dtype === "str" || decl.dtype === "strlist";
	}
};

const sameDecl = (a: ColumnDecl, b: ColumnDecl): boolean =>
	a.dtype === b.dtype &&
	a.merge === b.merge &&
	a.owner === b.owner &&
	JSON.stringify(a.default) === JSON.stringify(b.default);

const newStore = (decl: ColumnDecl, qualified: string, capacity: number): ColumnStore => {
	const base = { decl, qualified, writtenAt: new Int32Array(capacity).fill(NEVER_WRITTEN) };
	switch (decl.dtype) {
		case "f64":
			return { ...base, dtype: "f64", data: new Float64Array(capacity) };
		case "i32":
			return { ...base, dtype: "i32", data: new Int32Array(capacity) };
		case "bool":
			return { ...base, dtype: "bool", data: new Uint8Array(capacity) };
		case "str":
			return { ...base, dtype: "str", data: [] };
		case "strlist":
			return { ...base, dtype: "strlist", data: [] };
	}
};

const readCell = (store: ColumnStore, i: number): Scalar => {
	switch (store.dtype) {
		case "f64":
		case "i32":
			return store.data[i] ?? 0;
		case "bool":
			return (store.data[i] ?? 0) === 1;
		case "str":
			return store.data[i] ?? "";
		case "strlist":
			return store.data[i] ?? [];
	}
};

const writeCell = (store: ColumnStore, i: number, value: Scalar, tick: number): void => {
	switch (store.dtype) {
		case "f64":
		case "i32":
			store.data[i] = typeof value === "number" ? value : 0;
			break;
		case "bool":
			store.data[i] = value === true ? 1 : 0;
			break;
		case "str":
			store.data[i] = typeof value === "string" ? value : "";
			break;
		case "strlist":
			store.data[i] = isStringList(value) ? value : [];
			break;
	}
	store.writtenAt[i] = tick;
};

const mergeValues = (store: ColumnStore, existing: Scalar, incoming: Scalar): Scalar => {
	switch (store.decl.merge) {
		case "last":
			return incoming;
		case "sum":
			if (store.dtype === "bool") return existing === true || incoming === true;
			return (
				(typeof existing === "number" ? existing : 0) +
				(typeof incoming === "number" ? incoming : 0)
			);
		case "max":
			if (store.dtype === "bool") return existing === true || incoming === true;
			return Math.max(
				typeof existing === "number" ? existing : 0,
				typeof incoming === "number" ? incoming : 0,
			);
		case "append":
			if (store.dtype === "str")
				return (
					(typeof existing === "string" ? existing : "") +
					(typeof incoming === "string" ? incoming : "")
				);
			return Object.freeze([
				...(isStringList(existing) ? existing : []),
				...(isStringList(incoming) ? incoming : []),
			]);
	}
};

// A merged value is re-validated so, for instance, an i32 sum that overflows rejects the
// whole effect instead of wrapping silently.
// 合并结果重新校验，例如 i32 求和溢出时整条效果被拒绝，而不是静默回绕。
const mergeChecked = (
	store: ColumnStore,
	existing: Scalar,
	incoming: Scalar,
): Result<Scalar, string> => {
	const merged = mergeValues(store, existing, incoming);
	const checked = coerce(store.dtype, merged);
	return checked.ok
		? checked
		: err(`merge result ${String(merged)} not representable as ${store.dtype}`);
};

const growNumeric = <A extends Float64Array | Int32Array | Uint8Array>(
	data: A,
	make: (n: number) => A,
	capacity: number,
): A => {
	const next = make(capacity);
	next.set(data);
	return next;
};

// Numeric stores grow by doubling and copying; string stores are plain arrays that grow
// on their own.
// 数值存储按翻倍扩容并复制；字符串存储是普通数组，自行增长。
const ensureCapacity = (table: EntityTable, needed: number): void => {
	if (needed <= table.capacity) return;
	let capacity = Math.max(INITIAL_CAPACITY, table.capacity);
	while (capacity < needed) capacity *= 2;
	for (const store of table.columns.values()) {
		const writtenAt = new Int32Array(capacity).fill(NEVER_WRITTEN);
		writtenAt.set(store.writtenAt);
		store.writtenAt = writtenAt;
		switch (store.dtype) {
			case "f64":
				store.data = growNumeric(store.data, (n) => new Float64Array(n), capacity);
				break;
			case "i32":
				store.data = growNumeric(store.data, (n) => new Int32Array(n), capacity);
				break;
			case "bool":
				store.data = growNumeric(store.data, (n) => new Uint8Array(n), capacity);
				break;
			case "str":
			case "strlist":
				break;
		}
	}
	table.capacity = capacity;
};

// Numeric columns serialise as little-endian bytes in base64: byte-exact for f64 (no decimal
// round trip), compact, and platform-independent so worldHash agrees everywhere.
// 数值列序列化为 base64 的小端字节：f64 逐字节精确（不经十进制往返）、紧凑，且与平台无关，
// worldHash 在任何地方都一致。
const encodeNumeric = (store: ColumnStore, count: number): string => {
	switch (store.dtype) {
		case "f64": {
			const view = new DataView(new ArrayBuffer(count * 8));
			for (let i = 0; i < count; i += 1) view.setFloat64(i * 8, store.data[i] ?? 0, true);
			return Buffer.from(view.buffer).toString("base64");
		}
		case "i32": {
			const view = new DataView(new ArrayBuffer(count * 4));
			for (let i = 0; i < count; i += 1) view.setInt32(i * 4, store.data[i] ?? 0, true);
			return Buffer.from(view.buffer).toString("base64");
		}
		case "bool":
			return Buffer.from(store.data.subarray(0, count)).toString("base64");
		case "str":
		case "strlist":
			return "";
	}
};

const decodeNumeric = (store: ColumnStore, base64: string, count: number): void => {
	const bytes = Buffer.from(base64, "base64");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	switch (store.dtype) {
		case "f64":
			for (let i = 0; i < count; i += 1) store.data[i] = view.getFloat64(i * 8, true);
			break;
		case "i32":
			for (let i = 0; i < count; i += 1) store.data[i] = view.getInt32(i * 4, true);
			break;
		case "bool":
			for (let i = 0; i < count; i += 1) store.data[i] = bytes[i] ?? 0;
			break;
		case "str":
		case "strlist":
			break;
	}
};

const snapshotColumn = (store: ColumnStore, count: number): ColumnSnapshot => {
	switch (store.dtype) {
		case "str":
			return { decl: store.decl, encoding: "strings", data: store.data.slice(0, count) };
		case "strlist":
			return { decl: store.decl, encoding: "stringLists", data: store.data.slice(0, count) };
		case "f64":
		case "i32":
		case "bool":
			return { decl: store.decl, encoding: "base64", data: encodeNumeric(store, count) };
	}
};

class ColumnarWorld implements World, WorldInternals {
	private readonly tables = new Map<string, EntityTable>();
	private readonly envMap = new Map<string, JsonValue>();

	get entities(): readonly string[] {
		return [...this.tables.keys()];
	}

	ids(entity: string): readonly EntityId[] {
		return this.tables.get(entity)?.ids ?? [];
	}

	count(entity: string): number {
		return this.tables.get(entity)?.ids.length ?? 0;
	}

	// The view is live: it reads the store at call time, so a plugin holding one across a tick
	// sees the effects applied since.
	// 视图是活的：调用时才读取存储，跨 tick 持有它的插件能看到之后应用的效果。
	column<T extends Scalar>(entity: string, name: string): ReadonlyColumn<T> {
		const table = this.tables.get(entity);
		const store = table?.columns.get(name);
		if (table === undefined || store === undefined)
			throw new RangeError(`unknown column ${entity}.${name}`);
		const view: ReadonlyColumn<Scalar> = {
			get length() {
				return table.ids.length;
			},
			at: (i) => {
				if (i < 0 || i >= table.ids.length)
					throw new RangeError(`index ${i} out of range for ${entity}.${name}`);
				return readCell(store, i);
			},
			get: (id) => {
				const i = table.index.get(id);
				return i === undefined ? undefined : readCell(store, i);
			},
			toArray: () => Array.from({ length: table.ids.length }, (_, i) => readCell(store, i)),
		};
		return view as ReadonlyColumn<T>;
	}

	row(entity: string, id: EntityId): Readonly<Record<string, Scalar>> | undefined {
		const table = this.tables.get(entity);
		const i = table?.index.get(id);
		if (table === undefined || i === undefined) return undefined;
		const out: Record<string, Scalar> = {};
		for (const store of table.columns.values()) out[store.qualified] = readCell(store, i);
		return out;
	}

	env<T extends JsonValue>(key: string): T | undefined {
		return this.envMap.get(key) as T | undefined;
	}

	columns(entity: string): readonly ColumnDecl[] {
		const table = this.tables.get(entity);
		if (table === undefined) return [];
		return [...table.columns.values()].map((s) => ({ ...s.decl, name: s.qualified }));
	}

	hash(): string {
		return hashOf(this.snapshot());
	}

	// Re-declaring an identical column is idempotent so modules and executors sharing a column
	// need no coordination; any difference in dtype, merge, owner or default is a conflict.
	// 重复声明完全相同的列是幂等的，共享一列的模块与执行体无需协调；dtype、merge、owner 或默认值
	// 任一不同即冲突。
	declare(decl: ColumnDecl): Result<void, ColumnConflict> {
		const qualified = qualifiedColumnName(decl);
		if (!validMerge(decl))
			return err({
				kind: "ColumnConflict",
				message: `merge '${decl.merge}' is not valid for dtype ${decl.dtype} (${decl.entity}.${qualified})`,
			});
		const coerced = coerce(decl.dtype, decl.default);
		if (!coerced.ok)
			return err({
				kind: "ColumnConflict",
				message: `default for ${decl.entity}.${qualified}: ${coerced.error}`,
			});
		const table = this.table(decl.entity);
		const existing = table.columns.get(qualified);
		if (existing !== undefined) {
			if (sameDecl(existing.decl, decl)) return ok(undefined);
			return err({
				kind: "ColumnConflict",
				message: `column ${decl.entity}.${qualified} already declared as ${existing.decl.dtype}/${existing.decl.merge} by ${existing.decl.owner}`,
			});
		}
		const store = newStore(decl, qualified, table.capacity);
		for (let i = 0; i < table.ids.length; i += 1)
			writeCell(store, i, coerced.value, NEVER_WRITTEN);
		table.columns.set(qualified, store);
		return ok(undefined);
	}

	// IdCollision is thrown, not returned: two equal ULIDs from one rng means the id generator
	// is broken, which is a kernel bug.
	// IdCollision 抛出而不是返回：同一 rng 产出两个相同的 ULID 说明 id 生成器坏了，属于内核 bug。
	create(
		entity: string,
		rows: readonly Readonly<Record<string, Scalar>>[],
		rng: Rng,
	): readonly EntityId[] {
		const ids: EntityId[] = [];
		for (const row of rows) {
			const id = newEntityId(rng);
			if (this.tables.get(entity)?.index.has(id)) throw new IdCollision(entity, id);
			const inserted = this.insertRow(entity, id, row);
			if (!inserted.ok) throw new TypeError(`create ${entity}: ${inserted.error}`);
			ids.push(id);
		}
		return ids;
	}

	snapshot(): WorldSnapshot {
		const entities: EntitySnapshot[] = [...this.tables.values()].map((table) => ({
			name: table.name,
			ids: [...table.ids],
			columns: [...table.columns.values()].map((store) =>
				snapshotColumn(store, table.ids.length),
			),
		}));
		const env: Record<string, JsonValue> = {};
		for (const [k, v] of this.envMap) env[k] = v;
		return { version: 1, entities, env };
	}

	// null in a row means use the default; a value for an undeclared column rejects the row so
	// a typo cannot silently drop data. New rows are stamped NEVER_WRITTEN so the first set in
	// the creating tick replaces rather than merges.
	// 行里的 null 表示取默认值；写到未声明列的值会拒绝整行，拼写错误不会悄悄丢数据。新行盖
	// NEVER_WRITTEN 戳，创建它的那个 tick 内的首次 set 是替换而不是合并。
	insertRow(
		entity: string,
		id: EntityId,
		row: Readonly<Record<string, Scalar>>,
	): Result<void, string> {
		const table = this.tables.get(entity);
		if (table === undefined) return err(`unknown entity '${entity}'`);
		if (table.index.has(id)) return err(`entity '${entity}' already has id ${id}`);
		const values = new Map<string, Scalar>();
		for (const [column, value] of Object.entries(row)) {
			const store = table.columns.get(column);
			if (store === undefined) return err(`undeclared column ${entity}.${column}`);
			if (value === null) continue;
			const coerced = coerce(store.dtype, value);
			if (!coerced.ok) return err(`${entity}.${column}: ${coerced.error}`);
			values.set(column, coerced.value);
		}
		const i = table.ids.length;
		ensureCapacity(table, i + 1);
		table.ids.push(id);
		table.index.set(id, i);
		for (const store of table.columns.values()) {
			const value = values.get(store.qualified);
			writeCell(store, i, value ?? defaultOf(store), NEVER_WRITTEN);
		}
		return ok(undefined);
	}

	// Swap-remove: the last row moves into the hole, so ids() order changes but deterministically
	// and typed arrays never need compaction.
	// swap-remove：最后一行移入空位，ids() 的顺序会变但是确定的，类型化数组永远不需要压缩。
	deleteRow(entity: string, id: EntityId): Result<void, string> {
		const table = this.tables.get(entity);
		if (table === undefined) return err(`unknown entity '${entity}'`);
		const i = table.index.get(id);
		if (i === undefined) return err(`unknown id ${id} in '${entity}'`);
		const last = table.ids.length - 1;
		const lastId = table.ids[last];
		if (lastId !== undefined && i !== last) {
			for (const store of table.columns.values()) {
				writeCell(store, i, readCell(store, last), store.writtenAt[last] ?? NEVER_WRITTEN);
			}
			table.ids[i] = lastId;
			table.index.set(lastId, i);
		}
		table.ids.pop();
		table.index.delete(id);
		for (const store of table.columns.values()) {
			if (store.dtype === "str" || store.dtype === "strlist")
				store.data.length = table.ids.length;
		}
		return ok(undefined);
	}

	// null resets to the default; a write in the same tick as the previous one merges by the
	// column's rule.
	// null 重置为默认值；与上一次写入同 tick 的写入按列的规则合并。
	setCell(
		entity: string,
		id: EntityId,
		column: string,
		value: Scalar,
		tick: number,
	): Result<void, string> {
		const located = this.locate(entity, id, column);
		if (!located.ok) return located;
		const { store, i } = located.value;
		const resolved = value === null ? ok(defaultOf(store)) : coerce(store.dtype, value);
		if (!resolved.ok) return err(`${entity}.${column}: ${resolved.error}`);
		const next =
			store.writtenAt[i] === tick
				? mergeChecked(store, readCell(store, i), resolved.value)
				: ok(resolved.value);
		if (!next.ok) return err(`${entity}.${column}: ${next.error}`);
		writeCell(store, i, next.value, tick);
		return ok(undefined);
	}

	// The whole batch is validated before anything is written so a bad value at position k
	// leaves the column untouched; repeated ids inside one batch merge with each other in order.
	// 整批先校验再写入，第 k 个值有误时整列保持不变；同一批内重复的 id 按顺序相互合并。
	setCells(
		entity: string,
		column: string,
		ids: readonly EntityId[],
		values: readonly Scalar[],
		tick: number,
	): Result<void, string> {
		if (ids.length !== values.length)
			return err(
				`setColumn ${entity}.${column}: ${ids.length} ids but ${values.length} values`,
			);
		const table = this.tables.get(entity);
		if (table === undefined) return err(`unknown entity '${entity}'`);
		const store = table.columns.get(column);
		if (store === undefined) return err(`undeclared column ${entity}.${column}`);
		const pending = new Map<number, Scalar>();
		for (let k = 0; k < ids.length; k += 1) {
			const id = ids[k];
			const i = id === undefined ? undefined : table.index.get(id);
			if (id === undefined || i === undefined)
				return err(`unknown id ${String(id)} in '${entity}'`);
			const raw = values[k] ?? null;
			const resolved = raw === null ? ok(defaultOf(store)) : coerce(store.dtype, raw);
			if (!resolved.ok) return err(`${entity}.${column}[${k}]: ${resolved.error}`);
			const previous =
				pending.get(i) ?? (store.writtenAt[i] === tick ? readCell(store, i) : undefined);
			const next =
				previous === undefined
					? ok(resolved.value)
					: mergeChecked(store, previous, resolved.value);
			if (!next.ok) return err(`${entity}.${column}[${k}]: ${next.error}`);
			pending.set(i, next.value);
		}
		for (const [i, value] of pending) writeCell(store, i, value, tick);
		return ok(undefined);
	}

	incCell(
		entity: string,
		id: EntityId,
		column: string,
		delta: number,
		tick: number,
	): Result<void, string> {
		const located = this.locate(entity, id, column);
		if (!located.ok) return located;
		const { store, i } = located.value;
		if (store.dtype !== "f64" && store.dtype !== "i32")
			return err(`inc on ${entity}.${column}: dtype ${store.dtype} is not numeric`);
		if (typeof delta !== "number")
			return err(`inc on ${entity}.${column}: delta is not a number`);
		const current = readCell(store, i);
		const next = (typeof current === "number" ? current : 0) + delta;
		const checked = coerce(store.dtype, next);
		if (!checked.ok) return err(`inc on ${entity}.${column}: ${checked.error}`);
		writeCell(store, i, checked.value, tick);
		return ok(undefined);
	}

	appendCell(
		entity: string,
		id: EntityId,
		column: string,
		value: string,
		tick: number,
	): Result<void, string> {
		const located = this.locate(entity, id, column);
		if (!located.ok) return located;
		const { store, i } = located.value;
		if (typeof value !== "string")
			return err(`append on ${entity}.${column}: value is not a string`);
		const current = readCell(store, i);
		switch (store.dtype) {
			case "str":
				writeCell(store, i, (typeof current === "string" ? current : "") + value, tick);
				return ok(undefined);
			case "strlist":
				writeCell(
					store,
					i,
					Object.freeze([...(isStringList(current) ? current : []), value]),
					tick,
				);
				return ok(undefined);
			default:
				return err(
					`append on ${entity}.${column}: dtype ${store.dtype} is not str or strlist`,
				);
		}
	}

	setEnv(key: string, value: JsonValue): void {
		this.envMap.set(key, value);
	}

	loadColumn(entity: string, column: ColumnSnapshot, count: number): void {
		const qualified = qualifiedColumnName(column.decl);
		const store = this.tables.get(entity)?.columns.get(qualified);
		if (store === undefined)
			throw new TypeError(`restore: undeclared column ${entity}.${qualified}`);
		switch (column.encoding) {
			case "strings":
			case "stringLists":
				for (let i = 0; i < count; i += 1) {
					const value = column.data[i];
					if (value !== undefined) writeCell(store, i, value, NEVER_WRITTEN);
				}
				break;
			case "base64":
				decodeNumeric(store, column.data, count);
				break;
		}
	}

	private table(entity: string): EntityTable {
		const existing = this.tables.get(entity);
		if (existing !== undefined) return existing;
		const table: EntityTable = {
			name: entity,
			ids: [],
			index: new Map(),
			capacity: INITIAL_CAPACITY,
			columns: new Map(),
		};
		this.tables.set(entity, table);
		return table;
	}

	private locate(
		entity: string,
		id: EntityId,
		column: string,
	): Result<{ readonly store: ColumnStore; readonly i: number }, string> {
		const table = this.tables.get(entity);
		if (table === undefined) return err(`unknown entity '${entity}'`);
		const store = table.columns.get(column);
		if (store === undefined) return err(`undeclared column ${entity}.${column}`);
		const i = table.index.get(id);
		if (i === undefined) return err(`unknown id ${id} in '${entity}'`);
		return ok({ store, i });
	}
}

// The declared default was validated at declare; the fallback only guards a store whose
// declaration was tampered with after the fact.
// 声明的默认值在 declare 时已校验；回退分支只防御声明事后被篡改的存储。
const defaultOf = (store: ColumnStore): Scalar => {
	const coerced = coerce(store.dtype, store.decl.default);
	return coerced.ok ? coerced.value : readCell(newStore(store.decl, store.qualified, 1), 0);
};

export const createWorld = (): World => {
	const world = new ColumnarWorld();
	attachInternals(world, world);
	return world;
};

// Columns are declared in snapshot order and ids inserted before data is loaded, so column
// order, id order and row key order match the original world and prompts rendered after
// resume hash identically to a straight run.
// 按快照顺序声明列、先插入 id 再装载数据，列序、id 序与行键序都与原世界一致，续跑后渲染的
// prompt 与直跑的哈希相同。
export const restoreWorld = (snap: WorldSnapshot): World => {
	const world = new ColumnarWorld();
	attachInternals(world, world);
	for (const entity of snap.entities) {
		for (const column of entity.columns) {
			const declared = world.declare(column.decl);
			if (!declared.ok)
				throw new TypeError(`restore ${entity.name}: ${declared.error.message}`);
		}
		for (const id of entity.ids) {
			const inserted = world.insertRow(entity.name, id, {});
			if (!inserted.ok) throw new TypeError(`restore ${entity.name}: ${inserted.error}`);
		}
		for (const column of entity.columns)
			world.loadColumn(entity.name, column, entity.ids.length);
	}
	for (const [key, value] of Object.entries(snap.env)) world.setEnv(key, value);
	return world;
};
