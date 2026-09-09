# CLI

In a checkout every command runs as `bun run simulacra <command>`; installed as a dependency, the same commands are the `simulacra` binary. The definitions are in `src/cli/commands/`, one file per command, and the CLI imports nothing but the public API.

Common behaviour:

- `--version` (or `-v`) prints the version; `--help` (or `-h`) prints usage, for the CLI or for one command.
- Any error prints one `error: <message>` line to stderr and exits with code 1. The stack trace is printed only with `--log-level debug` or `trace`.
- `--log-level` takes `trace`, `debug`, `info`, `warn` or `error`; without it the level comes from the `SIMULACRA_LOG` environment variable, defaulting to `info`.
- `--plugin <path>` names a module exporting `register(registry)` and can be repeated; both `--plugin x` and `--plugin=x` are accepted.
- `--provider mock` or `--provider llm` replaces every provider in the scenario with that kind, which is how the examples run without a key.
- `--llm-mode live`, `record` or `replay` sets the gateway mode for the run: `record` writes into the scenario's `llm.recordDir`, `replay` answers from it.
- Commands that write a directory refuse a non-empty one unless `--overwrite` is passed.

## run

`simulacra run <scenario> --out <dir>`: runs a scenario and writes events, checkpoints and `result.json`.

| argument             | required | description                           |
| -------------------- | -------- | ------------------------------------- |
| `<scenario>`         | yes      | Path to `scenario.yaml` (or JSON).    |
| `--out`              | yes      | Output directory.                     |
| `--seed`             | no       | Overrides the scenario seed.          |
| `--ticks`            | no       | Overrides the total number of ticks.  |
| `--provider`         | no       | `mock` or `llm`.                      |
| `--llm-mode`         | no       | `live`, `record` or `replay`.         |
| `--plugin`           | no       | Repeatable plugin path.               |
| `--checkpoint-every` | no       | Write a checkpoint every N ticks.     |
| `--overwrite`        | no       | Replace a non-empty output directory. |
| `--log-level`        | no       | Log level.                            |

Prints five lines (`run <id> <status>`, `out`, `integrity`, `cost`, `metrics`) and the log digest. A run that failed part-way still wrote its result and log, so the summary is printed before the non-zero exit.

## audit

`simulacra audit <plan> --out <dir>`: runs a plan, conditions times replications, and writes `plan.json`, `audit.json`, `report.html`, `log.jsonl` and `runs/`.

| argument               | required | description                                                       |
| ---------------------- | -------- | ----------------------------------------------------------------- |
| `<plan>`               | yes      | Path to `audit.yaml`.                                             |
| `--out`                | yes      | Output directory.                                                 |
| `--replications`       | no       | Overrides the plan's replications.                                |
| `--concurrency`        | no       | Overrides the plan's concurrency.                                 |
| `--provider`           | no       | `mock` or `llm`, applied to every run and recorded in the report. |
| `--llm-mode`           | no       | Gateway mode for every run.                                       |
| `--include-incomplete` | no       | Keep runs with `integrity.complete` false in the statistics.      |
| `--plugin`             | no       | Repeatable plugin path.                                           |
| `--overwrite`          | no       | Replace a non-empty output directory.                             |
| `--log-level`          | no       | Log level.                                                        |

Prints the plan hash prefix and grade, the condition count, run counts (failed, incomplete, excluded), the number of pairwise tests, the grade and the paths of `audit.json` and `report.html`.

## report

`simulacra report <auditDir> [--out <file>]`: re-renders `report.html` from an audit directory's `audit.json`, so a report can be regenerated after a renderer change without rerunning the audit. Without `--out` the file is written next to `audit.json`.

## replay

`simulacra replay <runDir> [--to-tick <n>]`: folds the recorded effect events onto the tick 0 checkpoint up to the start of the given tick and prints `worldHash`, `tick`, the checkpoint it started from and the number of effects folded. A tick past the end of the run is not an error; the last world is printed together with the tick that was asked for.

## resume

`simulacra resume <checkpointDir> --ticks <n> --out <dir>`: continues a run from `<runDir>/checkpoints/<tick>` for N more ticks into a new directory. The scenario and its plugins come from the original run directory; `--plugin`, `--overwrite`, `--checkpoint-every` and `--log-level` work as in `run`. Intervention and questionnaire steps that follow the checkpoint are skipped.

## inspect

`simulacra inspect <runDir> --agent <id> [--tick <n>] [--event <id>]`: prints one agent's causal chain, observation, prompt, decision and effects, at a tick (default: the latest decision) or anchored on an event id. The MCP `get_agent_trace` tool renders the same lines.

## digest

`simulacra digest <runDir>`: prints the sha256 digest of the run's event log, the value two runs of the same scenario and seed must agree on.

## import-oasis

`simulacra import-oasis <db> --out <dir> [--metrics a,b] [--overwrite]`: turns an OASIS SQLite database into a run directory (`events.sqlite` plus `result.json`) through the OASIS adapter, computes the named metric kinds and prints the import counts (agents, posts, edges, observations, decisions, parse failures).

## doctor

`simulacra doctor [--llm] [--base-url <url>] [--model <name>]`: prints environment checks (Bun version, simulacra version, writable working directory, examples present). With `--llm` it also probes the endpoint for reachability, `json_schema` support, concurrency and cached-token reporting, spending at most 6 calls. The key comes from `SIMULACRA_LLM_API_KEY`; `--base-url` and `--model` default to `SIMULACRA_LLM_BASE_URL` and `SIMULACRA_LLM_MODEL`, then to DeepSeek and `deepseek-v4-flash`. Any failed check makes the command exit non-zero.

## examples

`simulacra examples` lists the built-in examples with their `scenario.yaml` paths. `simulacra examples <name> [--out <dir>]` copies the whole example directory, scenario, audit plan and recordings, to `--out` or `./<name>`; a non-empty target is refused.

## serve

`simulacra serve [--port <n>] [--data <dir>] [--log-level <l>]`: serves the [HTTP API](/guide/api) and the [GUI](/guide/gui) on `127.0.0.1`, port 8787 by default; `--port 0` picks a free port. Runs and audits live under `--data`, default `./simulacra-data`. Stdout carries only the address and the data directory, logs go to stderr, and the process stays up until SIGINT or SIGTERM.

## mcp

`simulacra mcp [--data <dir>] [--log-level <l>]`: serves the [MCP tools and resources](/guide/mcp) over stdio with a run registry on `--data`. Logs go to stderr because stdout is the transport; the command returns when the client closes the connection.
