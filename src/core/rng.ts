import { sha256Hex } from "./hash";
import type { Rng } from "./protocols";

const TWO_POW_32 = 4294967296;

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

const stateFromSeed = (seed: number, path: readonly number[]): Uint32Array => {
	const hex = sha256Hex(JSON.stringify([seed, ...path]));
	const state = new Uint32Array(4);
	for (let i = 0; i < 4; i += 1) {
		state[i] = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
	}
	if (state.every((w) => w === 0)) state[0] = 1;
	return state;
};

export const xoshiro128StarStar = (s: Uint32Array): number => {
	const s0 = s[0] ?? 0;
	const s1 = s[1] ?? 0;
	const s2 = s[2] ?? 0;
	const s3 = s[3] ?? 0;
	const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
	const t = (s1 << 9) >>> 0;
	const n2 = (s2 ^ s0) >>> 0;
	const n3 = (s3 ^ s1) >>> 0;
	const n1 = (s1 ^ n2) >>> 0;
	const n0 = (s0 ^ n3) >>> 0;
	s[0] = n0;
	s[1] = n1;
	s[2] = (n2 ^ t) >>> 0;
	s[3] = rotl(n3, 11);
	return result;
};

class Xoshiro128StarStar implements Rng {
	readonly path: readonly number[];
	private readonly seed: number;
	private readonly s: Uint32Array;

	constructor(seed: number, path: readonly number[]) {
		this.seed = seed;
		this.path = Object.freeze([...path]);
		this.s = stateFromSeed(seed, path);
	}

	next(): number {
		return xoshiro128StarStar(this.s) / TWO_POW_32;
	}

	int(n: number): number {
		if (!(n >= 1)) return 0;
		return Math.floor(this.next() * n);
	}

	pick<T>(xs: readonly T[]): T {
		if (xs.length === 0) throw new RangeError("pick from an empty array");
		return xs[this.int(xs.length)] as T;
	}

	shuffle<T>(xs: readonly T[]): readonly T[] {
		const out = [...xs];
		for (let i = out.length - 1; i > 0; i -= 1) {
			const j = this.int(i + 1);
			const a = out[i] as T;
			out[i] = out[j] as T;
			out[j] = a;
		}
		return out;
	}

	bernoulli(p: number): boolean {
		return this.next() < p;
	}

	normal(mu = 0, sigma = 1): number {
		const u1 = 1 - this.next();
		const u2 = this.next();
		return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	}

	fork(key: number): Rng {
		return new Xoshiro128StarStar(this.seed, [...this.path, key]);
	}
}

export const rngFromSeed = (seed: number, path: readonly number[]): Rng =>
	new Xoshiro128StarStar(seed, path);
