import type { Result } from "./types";

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } => r.ok;

export const isErr = <T, E>(r: Result<T, E>): r is { readonly ok: false; readonly error: E } =>
	!r.ok;

export const map = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
	r.ok ? ok(f(r.value)) : r;

export const mapErr = <T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> =>
	r.ok ? r : err(f(r.error));

export const andThen = <T, U, E, F>(
	r: Result<T, E>,
	f: (value: T) => Result<U, F>,
): Result<U, E | F> => (r.ok ? f(r.value) : r);

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);

export const collect = <T, E>(rs: readonly Result<T, E>[]): Result<readonly T[], E> => {
	const values: T[] = [];
	for (const r of rs) {
		if (!r.ok) return r;
		values.push(r.value);
	}
	return ok(values);
};

export const partition = <T, E>(
	rs: readonly Result<T, E>[],
): { readonly values: readonly T[]; readonly errors: readonly E[] } => {
	const values: T[] = [];
	const errors: E[] = [];
	for (const r of rs) {
		if (r.ok) values.push(r.value);
		else errors.push(r.error);
	}
	return { values, errors };
};
