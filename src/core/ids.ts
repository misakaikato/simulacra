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

const monotonicByRng = new WeakMap<Rng, UlidState>();
let monotonicFallback: UlidState | undefined;

const cryptoDraw: Draw = (n) => {
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return Math.floor(((buf[0] ?? 0) / 4294967296) * n);
};

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

export const newEntityId = (rng: Rng): EntityId => toEntityId(ulid(rng));
export const newEventId = (rng: Rng): EventId => toEventId(ulid(rng));
export const makeRunId = (scenarioId: string, replicationId: number): RunId =>
	toRunId(`${scenarioId}:${replicationId}`);
