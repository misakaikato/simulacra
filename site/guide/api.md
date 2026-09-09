# HTTP API

`simulacra serve` exposes a JSON API under `/api` and, when `gui/dist` has been built, the GUI on `/`. The response contract is one typed module, `src/api/contract.ts`, shared by the API, the MCP server and the GUI; the routes are in `src/api/routes/`. The server binds `127.0.0.1` only.

Conventions:

- Validation failures answer `400 { issues: [{ path, message }] }`; every other error answers `{ error }` with 404, 409 or 500. Non-API paths get plain text.
- Path parameters are URL-encoded; a run id contains a colon.
- Documents (`scenario`, `plan`) are either YAML text or an already parsed object. YAML text that is identical to a shipped example resolves its relative paths (plugins, recordings) against that example's directory; anything else resolves against the server's working directory.

## Routes

| method and path                           | response                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                         | `{ ok: true, version }`                                                                                                                                                 |
| `GET /api/examples`                       | `{ name, yaml }[]`: the built-in examples with their `scenario.yaml` text                                                                                               |
| `GET /api/runs`                           | `RunSummary[]`                                                                                                                                                          |
| `POST /api/runs`                          | `201 { runId }`; `409` when a run with that id already exists                                                                                                           |
| `GET /api/runs/:id`                       | `RunSummary`                                                                                                                                                            |
| `GET /api/runs/:id/events`                | `Event[]` in time order. Query: `kind` (comma-separated event kinds), `agent`, `tick`, `fromTick`, `toTick`, `limit` (default 200, at most 1000), `offset`              |
| `GET /api/runs/:id/events/:eventId/chain` | `Event[]`: the causal chain of one event                                                                                                                                |
| `GET /api/runs/:id/content/:sha`          | `text/plain`: a stored prompt or response by content hash                                                                                                               |
| `GET /api/runs/:id/agents`                | `{ id, columns }[]`; `columns` holds the public `persona.*` columns plus the derived counters `decisions` and `failures`                                                |
| `GET /api/runs/:id/graph`                 | `{ tick, edges: { src, dst, kind }[] }`. Query: `tick`; a tick past the end is clamped and the reached tick reported; a world without an edge table gives an empty list |
| `GET /api/runs/:id/metrics`               | `Record<name, { tick, value }[]>`, numeric measurements only                                                                                                            |
| `GET /api/runs/:id/stream`                | Server-sent events, see [Streaming](#streaming)                                                                                                                         |
| `GET /api/audits`                         | `AuditSummary[]`                                                                                                                                                        |
| `POST /api/audits`                        | `201 { auditId }`; `409` only when the audit name exists; name and axis problems are `400` with the issue at `name` or `plan.axes`                                      |
| `GET /api/audits/:id`                     | `AuditSummary`                                                                                                                                                          |
| `GET /api/audits/:id/report.html`         | The HTML report; `404` until it exists                                                                                                                                  |

Event kinds are `activation`, `observation`, `decision`, `observation_batch`, `decision_batch`, `llm_call`, `effect`, `intervention`, `measurement`, `failure`, `checkpoint` and `module_step`.

## Request bodies

`POST /api/runs`:

| field      | type                | notes                                                                                                    |
| ---------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `scenario` | YAML text or object | Required.                                                                                                |
| `seed`     | integer             | Required.                                                                                                |
| `name`     | string              | Optional. Letters, digits, `.`, `_` and `-`, starting with a letter or digit; becomes the run directory. |
| `ticks`    | positive integer    | Optional override of the total ticks.                                                                    |
| `provider` | `mock` or `llm`     | Optional; replaces every provider.                                                                       |

The run id is `<name>:0`, or `<scenarioId>-s<seed>:0` without a name, so only the same name and seed conflict.

`POST /api/audits`:

| field          | type                | notes                                         |
| -------------- | ------------------- | --------------------------------------------- |
| `plan`         | YAML text or object | Required.                                     |
| `name`         | string              | Optional, same rule as run names.             |
| `replications` | positive integer    | Optional override of the plan's replications. |
| `provider`     | `mock` or `llm`     | Optional; replaces every provider.            |

Both start the work in the background and answer at once; poll the summary or, for runs, open the stream.

## Response shapes

```ts
interface RunSummary {
	runId: string;
	progress: { tick: number; ticks: number; status: "running" | "succeeded" | "failed" };
	agentCount: number;
	result?: RunResult; // metrics, distributions, integrity, cost, failure
	error?: string; // result.json unreadable
}

interface AuditSummary {
	auditId: string;
	progress: { completed: number; total: number; status: "running" | "succeeded" | "failed" };
	plan?: AuditPlan;
	report?: AuditReport;
	error?: string;
}
```

`progress.tick` is the last tick that activated agents while a run is in progress, and the total (or the failing tick) once it has finished. `RunResult` and `AuditReport` are the same types the public API returns; the [audit reference](/guide/audits) describes the report's fields.

## Streaming

`GET /api/runs/:id/stream` is an SSE stream. While the run is in progress every event is written as it happens:

```
event: event
data: {"eventId":"...","kind":"decision",...}
```

A comment line (`: keepalive`) is sent every 15 s so proxies keep the connection open during a slow tick. A finished run is replayed from its log in time order. Both paths end with:

```
event: done
data: {"runId":"...","status":"succeeded"}
```

An unreadable log still ends the stream with `done` and the registry's status, so a client never waits on a broken run directory.
