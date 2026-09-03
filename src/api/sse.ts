// SSE stream of one run: while it runs, events arrive through the registry subscription and a
// comment-line keepalive is written every 15 s; a finished run is replayed from its log in time
// order. Both paths end with an `event: done` frame carrying the final status.
// 单个运行的 SSE 流：运行中事件经注册表订阅到达，每 15 秒写一行注释心跳；已结束的运行从日志
// 按时间顺序回放。两条路径都以携带最终状态的 `event: done` 帧收尾。

import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { openRunLog, type Event, type RunId, type RunMessage, type RunRegistry } from "../index";

export const KEEPALIVE_MS = 15000;
const KEEPALIVE_FRAME = ": keepalive\n\n";
const DONE_EVENT = "done";
const RUN_EVENT = "event";

const writeEvent = (stream: SSEStreamingApi, event: Event): Promise<void> =>
	stream.writeSSE({ event: RUN_EVENT, data: JSON.stringify(event) });

const writeDone = (stream: SSEStreamingApi, runId: RunId, status: string): Promise<void> =>
	stream.writeSSE({ event: DONE_EVENT, data: JSON.stringify({ runId, status }) });

// An unreadable log still ends the stream with done and the registry's status, so a client
// never waits forever on a broken run directory.
// 日志不可读时仍以 done 与注册表里的状态收尾，客户端不会在坏掉的运行目录上无限等待。
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

export const streamRun = (
	c: Context,
	registry: RunRegistry,
	runId: RunId,
	keepaliveMs = KEEPALIVE_MS,
): Response =>
	streamSSE(c, async (stream) => {
		const queue: RunMessage[] = [];
		let wake: (() => void) | undefined;
		const notify = (): void => {
			const resume = wake;
			wake = undefined;
			resume?.();
		};
		// Subscription callbacks are synchronous while writes are async, so messages are queued and
		// the loop is woken by a one-shot resolver; onAbort wakes it too, so a disconnected client
		// releases the subscription instead of parking on the promise. subscribe returns undefined
		// once a run is no longer running, which selects the replay path.
		// 订阅回调是同步的而写入是异步的，因此消息先入队，再由一次性 resolver 唤醒循环；
		// onAbort 同样唤醒它，客户端断开后释放订阅而不是悬在 promise 上。
		// 运行不再处于 running 时 subscribe 返回 undefined，由此进入回放路径。
		const unsubscribe = registry.subscribe(runId, (message) => {
			queue.push(message);
			notify();
		});
		if (unsubscribe === undefined) {
			await replayFinished(stream, registry, runId);
			return;
		}
		stream.onAbort(notify);
		// The keepalive is a comment line: invisible to EventSource, but enough to keep proxies and
		// idle detection from closing the connection during a slow tick.
		// 心跳是一行注释：EventSource 看不见，却足以让代理与空闲检测在慢 tick 期间不关掉连接。
		const keepalive = setInterval(() => {
			if (!stream.aborted && !stream.closed) void stream.write(KEEPALIVE_FRAME);
		}, keepaliveMs);
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
			clearInterval(keepalive);
			unsubscribe();
		}
	});
