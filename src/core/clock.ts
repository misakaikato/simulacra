import type { Clock } from "./protocols";
import { TIME_ZERO, compareTime } from "./time";
import type { LogicalTime } from "./types";

interface Entry {
	readonly at: LogicalTime;
	readonly priority: number;
	readonly insertSeq: number;
	readonly handle: string;
	readonly tag: string | undefined;
	readonly fn: () => Promise<void>;
}

const before = (a: Entry, b: Entry): boolean => {
	const byTime = compareTime(a.at, b.at);
	if (byTime !== 0) return byTime < 0;
	if (a.priority !== b.priority) return a.priority < b.priority;
	return a.insertSeq < b.insertSeq;
};

class BinaryHeap {
	private readonly items: Entry[] = [];

	get size(): number {
		return this.items.length;
	}

	peek(): Entry | undefined {
		return this.items[0];
	}

	push(entry: Entry): void {
		this.items.push(entry);
		let i = this.items.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			const child = this.items[i];
			const above = this.items[parent];
			if (child === undefined || above === undefined || !before(child, above)) break;
			this.items[i] = above;
			this.items[parent] = child;
			i = parent;
		}
	}

	pop(): Entry | undefined {
		const top = this.items[0];
		const last = this.items.pop();
		if (top === undefined || last === undefined) return top;
		if (this.items.length === 0) return top;
		this.items[0] = last;
		let i = 0;
		for (;;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let smallest = i;
			const l = this.items[left];
			const r = this.items[right];
			const s = this.items[smallest];
			if (l !== undefined && s !== undefined && before(l, s)) smallest = left;
			const s2 = this.items[smallest];
			if (r !== undefined && s2 !== undefined && before(r, s2)) smallest = right;
			if (smallest === i) break;
			const a = this.items[i];
			const b = this.items[smallest];
			if (a === undefined || b === undefined) break;
			this.items[i] = b;
			this.items[smallest] = a;
			i = smallest;
		}
		return top;
	}
}

class LogicalClock implements Clock {
	private current: LogicalTime;
	private insertSeq = 0;
	private readonly heap = new BinaryHeap();
	private readonly pending = new Set<string>();

	constructor(start: LogicalTime) {
		this.current = { ...start };
	}

	get now(): LogicalTime {
		return this.current;
	}

	nextSeq(): number {
		this.current = { ...this.current, seq: this.current.seq + 1 };
		return this.current.seq;
	}

	advanceTick(): LogicalTime {
		this.current = { tick: this.current.tick + 1, substep: 0, seq: 0 };
		return this.current;
	}

	advanceSubstep(): LogicalTime {
		this.current = { tick: this.current.tick, substep: this.current.substep + 1, seq: 0 };
		return this.current;
	}

	schedule(at: LogicalTime, fn: () => Promise<void>, priority = 0, tag?: string): string {
		this.insertSeq += 1;
		const handle = `h${this.insertSeq}`;
		this.heap.push({ at: { ...at }, priority, insertSeq: this.insertSeq, handle, tag, fn });
		this.pending.add(handle);
		return handle;
	}

	cancel(handle: string): void {
		this.pending.delete(handle);
	}

	due(): readonly (() => Promise<void>)[] {
		const out: (() => Promise<void>)[] = [];
		for (;;) {
			const top = this.heap.peek();
			if (top === undefined || compareTime(top.at, this.current) > 0) break;
			this.heap.pop();
			if (!this.pending.delete(top.handle)) continue;
			out.push(top.fn);
		}
		return out;
	}

	pendingCount(): number {
		return this.pending.size;
	}
}

export interface InspectableClock extends Clock {
	pendingCount(): number;
}

export const createClock = (start: LogicalTime = TIME_ZERO): InspectableClock =>
	new LogicalClock(start);
