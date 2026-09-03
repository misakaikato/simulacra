// Logical time arithmetic: (tick, substep, seq) compared lexicographically. No wall clock
// anywhere in the kernel.
// 逻辑时间运算：(tick, substep, seq) 按字典序比较。内核里没有任何墙钟时间。

import type { LogicalTime } from "./types";

export const TIME_ZERO: LogicalTime = Object.freeze({ tick: 0, substep: 0, seq: 0 });

// Total order used by the event log, the clock heap and replay.
// 事件日志、时钟堆与回放共用的全序。
export const compareTime = (a: LogicalTime, b: LogicalTime): -1 | 0 | 1 => {
	if (a.tick !== b.tick) return a.tick < b.tick ? -1 : 1;
	if (a.substep !== b.substep) return a.substep < b.substep ? -1 : 1;
	if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
	return 0;
};

export const timeAt = (tick: number, substep = 0, seq = 0): LogicalTime => ({
	tick,
	substep,
	seq,
});

export const nextTick = (t: LogicalTime): LogicalTime => ({ tick: t.tick + 1, substep: 0, seq: 0 });

export const nextSubstep = (t: LogicalTime): LogicalTime => ({
	tick: t.tick,
	substep: t.substep + 1,
	seq: 0,
});

export const withSeq = (t: LogicalTime, seq: number): LogicalTime => ({
	tick: t.tick,
	substep: t.substep,
	seq,
});

export const formatTime = (t: LogicalTime): string => `${t.tick}.${t.substep}.${t.seq}`;
