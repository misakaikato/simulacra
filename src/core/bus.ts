import type { EventLog } from "./protocols";
import type { Event, EventFilter, EventId } from "./types";

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
	sql: <T>(sql: string, params?: readonly (string | number)[]): readonly T[] =>
		log.sql<T>(sql, params),
	chain: (eventId: EventId): readonly Event[] => log.chain(eventId),
	digest: (): string => log.digest(),
	count: (): number => log.count(),
	close: (): void => log.close(),
});
