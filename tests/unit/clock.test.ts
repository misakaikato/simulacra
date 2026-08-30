import { describe, expect, test } from "bun:test";
import { createClock } from "../../src/core/clock";
import { timeAt } from "../../src/core/time";

const run = async (fns: readonly (() => Promise<void>)[]) => {
	for (const fn of fns) await fn();
};

describe("Clock", () => {
	test("starts at zero and advances seq, substep and tick with resets", () => {
		const clock = createClock();
		expect(clock.now).toEqual({ tick: 0, substep: 0, seq: 0 });
		expect(clock.nextSeq()).toBe(1);
		expect(clock.nextSeq()).toBe(2);
		expect(clock.now.seq).toBe(2);
		expect(clock.advanceSubstep()).toEqual({ tick: 0, substep: 1, seq: 0 });
		clock.nextSeq();
		expect(clock.advanceTick()).toEqual({ tick: 1, substep: 0, seq: 0 });
		const resumed = createClock(timeAt(7));
		expect(resumed.now).toEqual({ tick: 7, substep: 0, seq: 0 });
	});

	test("due entries fire in (time, priority, insertion) order", async () => {
		const clock = createClock();
		const fired: string[] = [];
		const add = (name: string, tick: number, priority?: number) =>
			clock.schedule(
				timeAt(tick),
				async () => {
					fired.push(name);
				},
				priority,
				name,
			);
		add("t2", 2);
		add("t1-late", 1, 5);
		add("t1-early", 1, -1);
		add("t1-default-a", 1);
		add("t1-default-b", 1);
		add("t0", 0);
		expect(clock.pendingCount()).toBe(6);
		await run(clock.due());
		expect(fired).toEqual(["t0"]);
		clock.advanceTick();
		await run(clock.due());
		expect(fired).toEqual(["t0", "t1-early", "t1-default-a", "t1-default-b", "t1-late"]);
		expect(clock.due()).toEqual([]);
		clock.advanceTick();
		await run(clock.due());
		expect(fired.at(-1)).toBe("t2");
		expect(clock.pendingCount()).toBe(0);
	});

	test("cancelled entries never fire and cancelling twice or after firing is harmless", async () => {
		const clock = createClock();
		const fired: string[] = [];
		const keep = clock.schedule(timeAt(1), async () => {
			fired.push("keep");
		});
		const drop = clock.schedule(timeAt(1), async () => {
			fired.push("drop");
		});
		clock.cancel(drop);
		clock.cancel(drop);
		expect(clock.pendingCount()).toBe(1);
		clock.advanceTick();
		await run(clock.due());
		expect(fired).toEqual(["keep"]);
		clock.cancel(keep);
		expect(clock.pendingCount()).toBe(0);
	});

	test("entries scheduled in the past are due immediately and substep ordering is respected", async () => {
		const clock = createClock(timeAt(5));
		const fired: string[] = [];
		clock.schedule(timeAt(3), async () => {
			fired.push("past");
		});
		clock.schedule(timeAt(5, 1), async () => {
			fired.push("substep1");
		});
		clock.schedule(timeAt(5, 0, 1), async () => {
			fired.push("seq1");
		});
		await run(clock.due());
		expect(fired).toEqual(["past"]);
		clock.nextSeq();
		await run(clock.due());
		expect(fired).toEqual(["past", "seq1"]);
		clock.advanceSubstep();
		await run(clock.due());
		expect(fired).toEqual(["past", "seq1", "substep1"]);
	});

	test("heap stays ordered under many random inserts", async () => {
		const clock = createClock();
		const order: number[] = [];
		const ticks = Array.from({ length: 500 }, (_, i) => (i * 7919) % 97);
		for (const tick of ticks) {
			clock.schedule(timeAt(tick), async () => {
				order.push(tick);
			});
		}
		for (let tick = 0; tick < 100; tick += 1) {
			await run(clock.due());
			clock.advanceTick();
		}
		expect(order).toEqual([...ticks].sort((a, b) => a - b));
	});
});
