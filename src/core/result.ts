// Result helpers: constructors, combinators, collect (first error wins) and partition.
// Business failures are values; exceptions are reserved for kernel bugs.
// Result 辅助函数：构造器、组合子、collect（首个错误即返回）与 partition。业务失败是值；异常只留给内核 bug。

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

// collect stops at the first error so callers get one ordered cause; partition keeps both
// sides for reporting.
// collect 遇到第一个错误就停止，调用方得到唯一且有序的原因；partition 保留两边用于汇报。
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
