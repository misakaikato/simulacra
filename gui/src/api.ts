import type {
	AuditPlan,
	AuditReport,
	EntityId,
	Event as SimEvent,
	EventId,
	EventKind,
	RunId,
	RunResult,
	Scalar,
} from "../../src/core/types";

export type RunStatus = "running" | "succeeded" | "failed";

export interface RunProgress {
	readonly tick: number;
	readonly ticks: number;
	readonly status: RunStatus;
}

export interface RunSummary {
	readonly runId: RunId;
	readonly progress: RunProgress;
	readonly agentCount: number;
	readonly result?: RunResult;
}

export interface Example {
	readonly name: string;
	readonly yaml: string;
}

export type ProviderChoice = "mock" | "llm";

export interface NewRun {
	readonly scenario: string;
	readonly seed: number;
	readonly ticks?: number;
	readonly provider?: ProviderChoice;
}

export interface AgentRow {
	readonly id: EntityId;
	readonly columns: Readonly<Record<string, Scalar>>;
}

export interface GraphEdge {
	readonly src: EntityId;
	readonly dst: EntityId;
	readonly kind: string;
}

export interface GraphSnapshot {
	readonly tick: number;
	readonly edges: readonly GraphEdge[];
}

export interface MetricPoint {
	readonly tick: number;
	readonly value: number;
}

export type MetricSeries = Readonly<Record<string, readonly MetricPoint[]>>;

export interface AuditProgress {
	readonly completed: number;
	readonly total: number;
	readonly status: RunStatus;
}

export interface AuditSummary {
	readonly auditId: string;
	readonly progress: AuditProgress;
	readonly plan?: AuditPlan;
	readonly report?: AuditReport;
}

export interface EventQuery {
	readonly kind?: readonly EventKind[];
	readonly agent?: EntityId;
	readonly tick?: number;
	readonly fromTick?: number;
	readonly toTick?: number;
	readonly limit?: number;
	readonly offset?: number;
}

export const PAGE_SIZE = 200;
const MAX_PAGES = 50;

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const issueText = (issue: unknown): string => {
	if (!isRecord(issue)) return String(issue);
	const path = Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
	const message = typeof issue.message === "string" ? issue.message : JSON.stringify(issue);
	return path === "" ? message : `${path}: ${message}`;
};

const messageOf = async (res: Response): Promise<string> => {
	const text = await res.text();
	const body = parseJson(text);
	if (isRecord(body)) {
		if (typeof body.error === "string") return body.error;
		if (Array.isArray(body.issues)) return body.issues.map(issueText).join("; ");
	}
	return text === "" ? res.statusText : text;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
	const res = await fetch(path, init);
	if (!res.ok) throw new ApiError(res.status, await messageOf(res));
	return (await res.json()) as T;
};

type Param = string | number | readonly string[] | undefined;

const query = (params: Readonly<Record<string, Param>>): string => {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		search.set(key, typeof value === "object" ? value.join(",") : String(value));
	}
	const text = search.toString();
	return text === "" ? "" : `?${text}`;
};

const encode = encodeURIComponent;
const runPath = (id: string): string => `/api/runs/${encode(id)}`;

const post = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

export const api = {
	examples: (): Promise<readonly Example[]> => request("/api/examples"),
	runs: (): Promise<readonly RunSummary[]> => request("/api/runs"),
	run: (id: string): Promise<RunSummary> => request(runPath(id)),
	createRun: (body: NewRun): Promise<{ readonly runId: RunId }> =>
		request("/api/runs", post(body)),
	events: (id: string, q: EventQuery): Promise<readonly SimEvent[]> =>
		request(`${runPath(id)}/events${query({ ...q })}`),
	chain: (id: string, eventId: EventId): Promise<readonly SimEvent[]> =>
		request(`${runPath(id)}/events/${encode(eventId)}/chain`),
	content: async (id: string, sha: string): Promise<string> => {
		const res = await fetch(`${runPath(id)}/content/${encode(sha)}`);
		if (!res.ok) throw new ApiError(res.status, await messageOf(res));
		return res.text();
	},
	agents: (id: string): Promise<readonly AgentRow[]> => request(`${runPath(id)}/agents`),
	graph: (id: string, tick: number | undefined): Promise<GraphSnapshot> =>
		request(`${runPath(id)}/graph${query({ tick })}`),
	metrics: (id: string): Promise<MetricSeries> => request(`${runPath(id)}/metrics`),
	audits: (): Promise<readonly AuditSummary[]> => request("/api/audits"),
	audit: (id: string): Promise<AuditSummary> => request(`/api/audits/${encode(id)}`),
	reportUrl: (id: string): string => `/api/audits/${encode(id)}/report.html`,
};

export const allEvents = async (id: string, q: EventQuery): Promise<readonly SimEvent[]> => {
	const out: SimEvent[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const batch = await api.events(id, { ...q, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
		out.push(...batch);
		if (batch.length < PAGE_SIZE) break;
	}
	return out;
};

export interface StreamHandlers {
	readonly onEvent: (event: SimEvent) => void;
	readonly onDone: () => void;
	readonly onError: (message: string) => void;
}

export const streamRun = (id: string, handlers: StreamHandlers): (() => void) => {
	const source = new EventSource(`${runPath(id)}/stream`);
	source.addEventListener("event", (message) => {
		if (message instanceof MessageEvent && typeof message.data === "string")
			handlers.onEvent(JSON.parse(message.data) as SimEvent);
	});
	source.addEventListener("done", () => {
		source.close();
		handlers.onDone();
	});
	source.onerror = () => {
		if (source.readyState === EventSource.CLOSED) handlers.onError("event stream closed");
	};
	return () => source.close();
};
