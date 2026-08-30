import { describe, expect, test } from "bun:test";
import {
	TIME_ZERO,
	compareTime,
	formatTime,
	nextSubstep,
	nextTick,
	timeAt,
	withSeq,
} from "../../src/core/time";

describe("LogicalTime", () => {
	test("compareTime orders by tick, then substep, then seq", () => {
		expect(compareTime(timeAt(1, 0, 0), timeAt(2, 0, 0))).toBe(-1);
		expect(compareTime(timeAt(2, 0, 0), timeAt(1, 9, 9))).toBe(1);
		expect(compareTime(timeAt(1, 1, 0), timeAt(1, 2, 0))).toBe(-1);
		expect(compareTime(timeAt(1, 1, 5), timeAt(1, 1, 4))).toBe(1);
		expect(compareTime(timeAt(1, 1, 5), timeAt(1, 1, 5))).toBe(0);
	});

	test("advancing helpers reset the lower fields", () => {
		expect(TIME_ZERO).toEqual({ tick: 0, substep: 0, seq: 0 });
		expect(nextTick(timeAt(3, 2, 7))).toEqual({ tick: 4, substep: 0, seq: 0 });
		expect(nextSubstep(timeAt(3, 2, 7))).toEqual({ tick: 3, substep: 3, seq: 0 });
		expect(withSeq(timeAt(3, 2, 7), 9)).toEqual({ tick: 3, substep: 2, seq: 9 });
		expect(formatTime(timeAt(3, 2, 7))).toBe("3.2.7");
	});
});
