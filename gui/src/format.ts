// Pure formatting helpers for ids, numbers, p-values, durations, scalars and logical time, plus
// the ApiError-aware error message every ErrorBar shows.
// 纯格式化辅助：id、数字、p 值、时长、标量与逻辑时间，以及每个 ErrorBar 展示的、
// 能识别 ApiError 的错误信息。

import type { LogicalTime, Scalar } from "../../src/core/types";
import { ApiError } from "./api";

export const short = (id: string, n = 10): string => (id.length > n ? `${id.slice(0, n)}…` : id);

export const num = (x: number, digits = 3): string =>
	Number.isInteger(x) ? String(x) : x.toFixed(digits);

export const pval = (p: number): string => (p < 0.001 ? p.toExponential(2) : p.toFixed(3));

export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export const millis = (x: number): string =>
	x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`;

export const scalar = (v: Scalar): string =>
	v === null ? "null" : typeof v === "object" ? v.join(", ") : String(v);

export const time = (t: LogicalTime): string => `${t.tick}.${t.substep}.${t.seq}`;

export const compareTime = (a: LogicalTime, b: LogicalTime): number =>
	a.tick - b.tick || a.substep - b.substep || a.seq - b.seq;

export const errorMessage = (e: unknown): string =>
	e instanceof ApiError
		? `${e.status}: ${e.message}`
		: e instanceof Error
			? e.message
			: String(e);
