# MCP server

`simulacra mcp` serves tools and resources over stdio through the Model Context Protocol, so an assistant can run scenarios, query events, trace agents and run audits. The tools mirror the CLI and sit on the same public API; the server is `src/mcp/server.ts`.

## Starting it

```bash
bun run simulacra mcp --data ./simulacra-data
```

Runs and audits are stored under `--data` (default `./simulacra-data`), the same layout `simulacra serve` uses, so the GUI can show what an assistant produced. Stdout is the transport and logs go to stderr; the process exits when the client closes the connection.

A client configuration names the entry file directly, which works from any working directory:

```json
{
	"mcpServers": {
		"simulacra": {
			"command": "bun",
			"args": [
				"/path/to/simulacra/src/cli/index.ts",
				"mcp",
				"--data",
				"/path/to/simulacra-data"
			]
		}
	}
}
```

The same command registers the server with Claude Code:

```bash
claude mcp add simulacra -- bun /path/to/simulacra/src/cli/index.ts mcp --data /path/to/simulacra-data
```

A real model needs `SIMULACRA_LLM_API_KEY` in the server's environment; with `provider: "mock"` no key is required.

## Tools

Every tool validates its input with zod and answers with readable lines followed by the same data as JSON. A failure sets `isError` and echoes `{ error, issues }` in the shape of the HTTP 400 body.

| tool              | input                                                                                               | returns                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `list_examples`   | none                                                                                                | The built-in examples: name, `scenario.yaml` path and whether an `audit.yaml` exists.                                     |
| `run_scenario`    | exactly one of `scenarioYaml` or `example`; `seed` (required); `name`, `ticks`, `provider` optional | Waits for completion, then the run summary with integrity, cost, metrics and the resource URI.                            |
| `get_run`         | `runId`                                                                                             | Progress and result of a run.                                                                                             |
| `query_events`    | `runId`; `kind`, `agentId`, `tick`, `limit` optional                                                | Events in time order, 200 by default and at most 1000.                                                                    |
| `get_agent_trace` | `runId`, `agentId`; `tick` optional (default: the latest decision)                                  | The readable causal chain `simulacra inspect` prints: observation, prompt preview, decision, effects, failures.           |
| `run_audit`       | exactly one of `planYaml` or `examplePlan`; `name`, `replications`, `provider` optional             | Waits for completion, then the grade, condition and run counts, pairwise count, sensitivity ranking and the resource URI. |
| `get_audit`       | `auditId`                                                                                           | Progress and a condensed report: everything except per-run results and the run index.                                     |
| `doctor`          | `llm` optional boolean                                                                              | The environment checks; with `llm: true` also the endpoint probe, at most 6 calls.                                        |

`example` and `examplePlan` take a built-in example name (`echo_chamber`, `prisoners_dilemma`); the plan is the `audit.yaml` next to that example's scenario, so relative plugin and recording paths resolve. Inline YAML resolves against the server's working directory. Run ids follow the HTTP rule: `<name>:0`, or `<scenarioId>-s<seed>:0` without a name.

## Resources

| template                              | content                                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `simulacra://runs/{runId}/result`     | Progress and full `RunResult` of a run, as JSON.                |
| `simulacra://audits/{auditId}/report` | Progress and the full `AuditReport`, including per-run results. |

Both templates list what the registry holds, so a client can discover runs and audits without calling a tool first. Template variables arrive percent-encoded (run ids contain a colon) and are decoded by the server.
