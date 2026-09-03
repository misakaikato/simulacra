// Event bus: wraps an EventLog so every append is also handed to a subscriber (API streaming,
// run-registry progress). Only append is intercepted; reads pass straight through.
// 事件总线：包装 EventLog，使每次 append 同时交给订阅者（API 推流、运行注册表进度）。只拦截 append，
// 读操作直接透传。

import type { EventLog } from "./protocols";
import type { BatchEventFilter, EntityId, Event, EventFilter, EventId } from "./types";

export type EventHandler = (e: Event) => void;

export const observableLog = (log: EventLog, emit: EventHandler): EventLog => ({
	append: (e: Event): void => {
		log.append(e);
		emit(e);
	},
	beginTick: (): void => log.beginTick(),
	endTick: (): void => log.endTick(),
	putContent: (text: string): string => log.putContent(text),
	getContent: (sha: string): string | undefined => log.getContent(sha),
	query: (filter: EventFilter): readonly Event[] => log.query(filter),
	batchesOf: (agentId: EntityId, filter?: BatchEventFilter): readonly Event[] =>
		log.batchesOf(agentId, filter),
	sql: <T>(sql: string, params?: readonly (string | number)[]): readonly T[] =>
		log.sql<T>(sql, params),
	chain: (eventId: EventId): readonly Event[] => log.chain(eventId),
	digest: (): string => log.digest(),
	count: (): number => log.count(),
	close: (): void => log.close(),
});
