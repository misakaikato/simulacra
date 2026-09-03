// ULIDs for entities, events and runs. With an rng both halves are drawn from it, so ids are a
// pure function of the seed path; monotonicity is kept per rng so ids sort by creation order.
// 实体、事件与运行的 ULID。传入 rng 时两半都从它抽取，id 因而是种子路径的纯函数；单调性按 rng 维护，
// id 按创建顺序可排序。

import type { Rng } from "./protocols";
import type { EntityId, EventId, RunId } from "./types";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const TWO_POW_20 = 1048576;
const TWO_POW_24 = 16777216;

interface UlidState {
	time: number;
	random: number[];
}

type Draw = (n: number) => number;

// Monotonic state is keyed by rng instance: forks of one seed yield independent, each
// monotonic sequences. The crypto fallback keeps a single module-level state.
// 单调状态按 rng 实例保存：同一种子的各个 fork 产生相互独立、各自单调的序列。crypto 回退路径
// 只保留一份模块级状态。
const monotonicByRng = new WeakMap<Rng, UlidState>();
let monotonicFallback: UlidState | undefined;

const cryptoDraw: Draw = (n) => {
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return Math.floor(((buf[0] ?? 0) / 4294967296) * n);
};

// The 48-bit time half is drawn, not read from the clock, so ids carry no wall-clock
// information; two 24-bit draws keep the value inside the safe integer range.
// 48 位时间半段靠抽取而不是读时钟，id 不携带墙钟信息；两次 24 位抽取保证值在安全整数范围内。
const drawTime = (draw: Draw): number => draw(TWO_POW_24) * TWO_POW_24 + draw(TWO_POW_24);

const drawRandom = (draw: Draw): number[] => {
	const digits: number[] = [];
	for (let chunk = 0; chunk < RANDOM_CHARS / 4; chunk += 1) {
		let word = draw(TWO_POW_20);
		const part: number[] = [];
		for (let k = 0; k < 4; k += 1) {
			part.unshift(word % 32);
			word = Math.floor(word / 32);
		}
		digits.push(...part);
	}
	return digits;
};

// ULID monotonicity: when a new draw would not sort after the previous id, the previous
// random half is incremented instead, carrying into the time half on overflow.
// ULID 单调性：新抽取的值不能排在上一个 id 之后时，改为对上一个随机半段加一，溢出则进位到时间半段。
const increment = (state: UlidState): UlidState => {
	const random = [...state.random];
	for (let i = random.length - 1; i >= 0; i -= 1) {
		const d = random[i] ?? 0;
		if (d < 31) {
			random[i] = d + 1;
			return { time: state.time, random };
		}
		random[i] = 0;
	}
	return { time: state.time + 1, random };
};

const encode = (state: UlidState): string => {
	let time = state.time;
	const chars: string[] = new Array<string>(TIME_CHARS);
	for (let i = TIME_CHARS - 1; i >= 0; i -= 1) {
		chars[i] = ALPHABET[time % 32] ?? "0";
		time = Math.floor(time / 32);
	}
	return chars.join("") + state.random.map((d) => ALPHABET[d] ?? "0").join("");
};

const nextState = (previous: UlidState | undefined, draw: Draw): UlidState => {
	const time = drawTime(draw);
	if (previous !== undefined && time <= previous.time) return increment(previous);
	return { time, random: drawRandom(draw) };
};

// Without an rng the id is not reproducible; only runId and other ids with no simulation
// meaning may take that path.
// 不传 rng 时 id 不可复现；只有 runId 等无模拟语义的 id 允许走这条路径。
export const ulid = (rng?: Rng): string => {
	if (rng === undefined) {
		monotonicFallback = nextState(monotonicFallback, cryptoDraw);
		return encode(monotonicFallback);
	}
	const state = nextState(monotonicByRng.get(rng), (n) => rng.int(n));
	monotonicByRng.set(rng, state);
	return encode(state);
};

export const isUlid = (s: string): boolean =>
	s.length === TIME_CHARS + RANDOM_CHARS && [...s].every((c) => ALPHABET.includes(c));

export const toEntityId = (s: string): EntityId => s as EntityId;
export const toEventId = (s: string): EventId => s as EventId;
export const toRunId = (s: string): RunId => s as RunId;

// Sentinel for no event yet: a fresh run's lastEventId, and the replay start when no history
// precedes the checkpoint.
// 尚无事件的哨兵值：新 run 的 lastEventId，以及检查点之前没有历史时的回放起点。
export const ZERO_EVENT_ID: EventId = toEventId("00000000000000000000000000");

export const newEntityId = (rng: Rng): EntityId => toEntityId(ulid(rng));
export const newEventId = (rng: Rng): EventId => toEventId(ulid(rng));
export const makeRunId = (scenarioId: string, replicationId: number): RunId =>
	toRunId(`${scenarioId}:${replicationId}`);
