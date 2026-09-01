import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { openRunLog, type Event, type RunId, type RunMessage, type RunRegistry } from "../index";

const DONE_EVENT = "done";
const RUN_EVENT = "event";

const writeEvent = (stream: SSEStreamingApi, event: Event): Promise<void> =>
	stream.writeSSE({ event: RUN_EVENT, data: JSON.stringify(event) });

const writeDone = (stream: SSEStreamingApi, runId: RunId, status: string): Promise<void> =>
	stream.writeSSE({ event: DONE_EVENT, data: JSON.stringify({ runId, status }) });

const replayFinished = async (
	stream: SSEStreamingApi,
	registry: RunRegistry,
	runId: RunId,
): Promise<void> => {
	const log = openRunLog(registry.runDir(runId));
	if (log.ok) {
		try {
			for (const event of log.value.query({})) {
				if (stream.aborted) return;
				await writeEvent(stream, event);
			}
		} finally {
			log.value.close();
		}
	}
	await writeDone(stream, runId, registry.getRun(runId)?.progress.status ?? "failed");
};

export const streamRun = (c: Context, registry: RunRegistry, runId: RunId): Response =>
	streamSSE(c, async (stream) => {
		const queue: RunMessage[] = [];
		let wake: (() => void) | undefined;
		const notify = (): void => {
			const resume = wake;
			wake = undefined;
			resume?.();
		};
		const unsubscribe = registry.subscribe(runId, (message) => {
			queue.push(message);
			notify();
		});
		if (unsubscribe === undefined) {
			await replayFinished(stream, registry, runId);
			return;
		}
		stream.onAbort(notify);
		try {
			for (;;) {
				if (stream.aborted) return;
				const message = queue.shift();
				if (message === undefined) {
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					continue;
				}
				if (message.kind === "event") await writeEvent(stream, message.event);
				else {
					await writeDone(stream, runId, message.status);
					return;
				}
			}
		} finally {
			unsubscribe();
		}
	});
