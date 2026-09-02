<p align="center"><img src="docs/banner.jpg" alt="simulacra" width="100%"></p>

# simulacra

A typed, event-sourced kernel for LLM-driven social simulation, with a robustness-audit harness built in.

Simulacra runs populations of agents whose decisions come from language models, rules, or cheap surrogates, records every observation, decision, and state change as a typed event, and then asks the question most simulation papers skip: does the conclusion survive perturbation?

- **Typed world state.** Columnar tables are the single source of truth. Agents, modules, and providers read views and emit effects; one resolver applies them.
- **Event sourcing.** Every observation, decision, LLM call, effect, and failure is an append-only event carrying its seed path. Replay is a fold. Same scenario, same seed, same digest.
- **Recorded LLM calls.** Real model outputs are recorded and replayed byte for byte, so audits re-analyze without re-spending tokens.
- **Failure is data.** Parse failures, rejected actions, truncated outputs, budget exhaustion, and circuit breaks are events with counts in every result, never silent fallbacks.
- **Batch decision providers.** Mix LLM, rule, mock, surrogate, archetype, and cache providers in one population; route through TopoSim-style cells or APS-style adaptive prototypes; every provider's own audit numbers land in the metrics.
- **Audit harness.** TRAILS-style perturbation axes across design and representation, replications with seed lineage, Mann–Whitney U, Holm correction, Cohen's d, bootstrap intervals, total variation distance, Wasserstein-1, Cliff's delta, and an evidence grade for the claim.
- **Four entry points.** CLI, HTTP API, MCP server, and a browser GUI, all over one public API.

## Install

Requires [Bun](https://bun.sh) 1.3 or newer.

```bash
git clone https://github.com/misakaikato/simulacra.git
cd simulacra
bun install
```

## Three commands

Run the echo-chamber example with the deterministic mock provider:

```bash
bun run simulacra run examples/echo_chamber/scenario.yaml --seed 7 --provider mock --out runs/echo
```

Audit the prisoner's dilemma example across persona format, framing, and memory representation:

```bash
bun run simulacra audit examples/prisoners_dilemma/audit.yaml --replications 5 --provider mock --out audits/pd
```

Open the GUI over the runs and audits you just produced:

```bash
bun run simulacra serve --data .
```

With a real model, set `SIMULACRA_LLM_API_KEY` and drop `--provider mock`. Any OpenAI-compatible endpoint works. DeepSeek is the default, with thinking disabled in the preset so structured answers fit small token budgets; `mlx-lm` and LM Studio presets are one flag away. Run `bun run simulacra doctor --llm` first to check structured-output support, concurrency, and cached-token reporting.

Both examples ship with recordings made against `deepseek-v4-flash`. Pass `--llm-mode replay` to run them offline against those recordings, or `--llm-mode record` to make your own.

## Screenshots

Run view: tick timeline with failure counts, force-directed network colored by stance, agent inspector with the causal chain from observation to effects, metric series, integrity and cost.

<p align="center"><img src="docs/screenshots/run.jpg" alt="Run view" width="100%"></p>

Audit view: plan and evidence grade, perturbation axes, conditions, pairwise tests with Holm-corrected p values, sensitivity ranking, direction consistency.

<p align="center"><img src="docs/screenshots/audit.jpg" alt="Audit view" width="100%"></p>

Runs list with a new-run form, and the offline HTML audit report.

<p align="center"><img src="docs/screenshots/runs.jpg" alt="Runs list" width="49%"> <img src="docs/screenshots/report.jpg" alt="HTML audit report" width="49%"></p>

## What a run produces

```
runs/echo/
  scenario.json      the effective scenario
  events.sqlite      every event, queryable with SQL
  log.jsonl          structured log with runId, tick, component
  checkpoints/<n>/   world snapshot, clock, executor and provider state
  result.json        metrics, integrity counts, cost
```

Inspect one agent's causal chain at a tick, from observation through prompt to decision and effects:

```bash
bun run simulacra inspect runs/echo --agent <id> --tick 3
```

Replay the effects to any tick and compare the world hash with the checkpoint:

```bash
bun run simulacra replay runs/echo --to-tick 10
```

Resume from a checkpoint. Intervention and questionnaire steps that come after the checkpoint are skipped on resume; run them from a fresh start.

```bash
bun run simulacra resume runs/echo/checkpoints/5 --ticks 5 --out runs/echo-resumed
```

## Architecture

```mermaid
flowchart TB
    subgraph tools["Entry points, only over the public API"]
        CLI["CLI<br/>run · audit · replay · inspect · serve · mcp"]
        API["HTTP API<br/>Hono routes · SSE"]
        MCP["MCP server<br/>stdio tools · resources"]
        GUI["GUI<br/>Vite · React"]
    end
    subgraph pub["src/index.ts"]
        PUB["public API<br/>loadScenario · runScenario · audit · inspect · registry"]
    end
    subgraph harness["harness/"]
        AX["perturbation axes<br/>TRAILS catalog"] --> CO["conditions × replications"] --> ST["statistics<br/>MWU · Holm · d · TVD · W1"] --> RP["report.html"]
    end
    subgraph plugins["plugins, registered by name"]
        AG["agents/<br/>focal · cohort"]
        PR["providers/<br/>llm · rule · mock · surrogate · archetype · cache · topo · aps"]
        MO["modules/<br/>socialGraph · feed · calendar"]
        PO["policies/ metrics/ instruments/"]
        AD["adapters/<br/>script · OASIS import"]
    end
    subgraph core["core/"]
        SC["scenario<br/>seed lineage"] --> SIM["simulation<br/>tick loop"]
        SIM --> WR["world + resolver<br/>columnar state, single writer"]
        SIM --> LOG["event log<br/>SQLite, content store"]
        SIM --> CK["checkpoint · replay"]
    end
    subgraph llm["llm/"]
        GW["gateway<br/>AIMD · retry · record/replay · budget · circuit"]
    end
    GUI --> API
    CLI --> PUB
    API --> PUB
    MCP --> PUB
    PUB --> harness
    PUB --> core
    harness --> core
    plugins --> core
    PR --> GW
    AD --> core
```

Dependencies point downward. The core imports nothing above it, and a test guards the rule. Everything above the core is a plugin registered by name: a new action, module, provider, activation policy, metric, or adapter is a file and a `register` call, never a change to `src/core`.

One tick, in order:

```mermaid
flowchart LR
    A["activation policy<br/>selects agents"] --> B["executors observe<br/>components render prompts"]
    B --> C["providers decide<br/>batched, typed Result"]
    C --> D["actions resolve<br/>into effects"]
    D --> E["resolver applies<br/>merge rules, rejections"]
    E --> F["modules step<br/>feed, graph, calendar"]
    F --> G["instruments measure<br/>metrics, provider audits"]
    G --> H["completion assertion<br/>one decision or failure per agent"]
    B -. observation .-> LOG[("event log")]
    C -. decision · llm_call .-> LOG
    E -. effect · failure .-> LOG
    G -. measurement .-> LOG
```

Two executors share the same state bus. Focal agents are component-based with declared reads and writes, for small high-fidelity populations. Cohorts are columnar and vectorized, for populations in the hundred thousands driven by rules, surrogates, or archetype broadcasts.

## Examples

Two scenarios ship in `examples/` and double as the acceptance fixtures:

| scenario                   | what it models                                                                                                                                     | knobs in `params`                                                                                      | metrics                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `prisoners_dilemma`        | an LLM player against a rule opponent over 10 rounds; the module, both actions and the opponent strategies live in `rules.ts` as a plugin template | `framing` canonical · moralized · risk, `opponent` titForTat · random · alwaysCooperate · alwaysDefect | `cooperationRate`, `averagePayoff`                   |
| `echo_chamber`             | 100 people on a power-law social graph with homophily rewiring and hub assignment, posting and reposting through a recommender feed                | `homophily`, `hub`, `activation`, `memoryWindow`, `feedSize`                                           | `stanceAssortativity`, `sameGroupRatio`, `postShare` |
| `echo_chamber/cohort.yaml` | the same population as a columnar cohort of 100,000 with vectorized opinion dynamics                                                               | `n`                                                                                                    | `meanStance`                                         |

Each has an `audit.yaml` next to it. Programmatic examples in `examples/programmatic/` run against the public API and are executed by the test suite:

| file                      | shows                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `01-run-and-inspect.ts`   | run a scenario, read metrics and integrity, query the event log with SQL, print one agent's causal chain |
| `02-custom-plugin.ts`     | define a module, two actions and a rule provider in code and run a scenario built from a YAML string     |
| `03-audit.ts`             | run an audit from code, read the evidence grade and sensitivity ranking, render the HTML report          |
| `04-replay-recordings.ts` | replay the shipped DeepSeek recordings offline and confirm two replays share a digest                    |
| `05-cohort-scale.ts`      | override the population size of the cohort scenario and measure throughput                               |

```bash
bun examples/programmatic/01-run-and-inspect.ts
```

The core of the first one:

```ts
import { inspect, loadScenario, runScenario, withRunLog } from "@misakaikato/simulacra";

const scenario = loadScenario("examples/echo_chamber/scenario.yaml");
if (!scenario.ok) throw new Error(JSON.stringify(scenario.error));

const result = await runScenario(scenario.value, "runs/echo", {
	providerOverride: "mock",
	ticksOverride: 5,
});
if (!result.ok) throw new Error(result.error.message);
console.log(result.value.metrics, result.value.integrity);

const counts = withRunLog("runs/echo", (log) => ({
	ok: true as const,
	value: log.sql<{ kind: string; n: number }>(
		"select kind, count(*) as n from events group by kind",
	),
}));

const trace = inspect("runs/echo", { agentId: someAgentId, tick: 2 });
```

## Extending

```ts
import { defineAction, toEntityId, type Registry } from "@misakaikato/simulacra";
import { z } from "zod";

export const register = (registry: Registry) =>
	registry.actions.register(
		defineAction({
			name: "donate",
			description: "Give part of your balance to another agent.",
			params: z.object({ target: z.string(), amount: z.number().positive() }),
			requiresModules: ["ledger"],
			fallback: false,
			resolve: async (call) => [
				{
					op: "inc",
					entity: "agent",
					id: toEntityId(call.args.target),
					column: "ledger.balance",
					value: call.args.amount,
					cause: call.cause,
				},
				{
					op: "inc",
					entity: "agent",
					id: call.agentId,
					column: "ledger.balance",
					value: -call.args.amount,
					cause: call.cause,
				},
			],
		}),
	);
```

Declare the plugin in a scenario with `plugins: ["./ledger.ts"]`, or pass `--plugin` on the command line. Modules declare the columns they own, components declare what they read and write, and the kernel validates both at assembly time. `examples/prisoners_dilemma/rules.ts` is a complete example of a custom module, two actions, and a rule provider.

## Audit

An audit plan names a base scenario, perturbation axes, replications, and metrics:

```yaml
baseScenario: ./scenario.yaml
design: one_at_a_time
replications: 30
metrics: [cooperationRate, averagePayoff]
claimType: mechanism
axes:
    - id: personaFormat
      level: micro
      kind: representation
      dimension: representational_format
      target: prompt.personaFormat
      levels: [plain, bullets, table]
```

The report grades the evidence: weak below 10 replications or with single-level axes, moderate from 10, strong from 30 replications with three levels per axis and two model families. Policy claims additionally need axes at the micro, meso, and macro levels. Runs that fail or finish incomplete stay in the report as data and are excluded from the statistics.

External simulations join through the script contract, a subprocess that takes `--config`, `--seed`, `--out` and writes `result.json`, and OASIS databases import directly with `import-oasis`.

## API, MCP, GUI

`bun run simulacra serve` exposes the HTTP API and the GUI. `bun run simulacra mcp` starts a stdio MCP server with tools to run scenarios, query events, trace agents, and run audits. All three sit on the same public API as the CLI, and the API response contract is a single typed module shared with the GUI.

## Performance

Measured on an Apple M5 Max with Bun 1.3.11, see `bench/RESULTS.md` for the full tables.

| run                                   |  agents | ticks |  wall | notes                                            |
| ------------------------------------- | ------: | ----: | ----: | ------------------------------------------------ |
| focal, mock provider                  |   1,000 |    20 | 5.6 s | 12,415 events                                    |
| cohort, rule provider                 | 100,000 |    20 | 7.4 s | 126 events, one `setColumn` effect per tick      |
| prisoner's dilemma, deepseek-v4-flash |       2 |     5 | 4.7 s | 5 calls, 2,016 prompt tokens, 0 parse failures   |
| echo chamber, deepseek-v4-flash       |      20 |     3 | 9.4 s | 33 calls, 24,088 prompt tokens, 0 parse failures |

`bun bench/kernel.ts` reproduces the first two rows offline. `SIMULACRA_LLM_API_KEY=... bun bench/llm.ts` reproduces the last two and refreshes the recordings, capped at 150 calls.

Against other frameworks, on the same machine and the same 100,000-agent opinion model over 20 ticks: Mesa 3.5.1 finishes in 1.4 s keeping nothing per agent-tick; the simulacra cohort takes 5.8 s while materializing one observation batch and one decision batch event per tick, and 7.2 s when those 125 events are persisted to SQLite. Per LLM decision, the echo chamber prompt is about 730 tokens against roughly 3,400 in the OASIS README baseline; scenario richness differs, so read that as footprint, not fidelity. Details and reproduction commands are in `bench/RESULTS.md`.

## Development

```bash
bun run check          # tsc for src and gui
bun run lint           # eslint
bun run format:check   # prettier
bun test               # bun test
bun run build:gui      # vite build to gui/dist
```

Commit messages follow one fixed form, `<emoji> <type>(<scope>): <summary>`, in English and imperative mood, one emoji per type:

| type     | emoji | used for                             |
| -------- | ----- | ------------------------------------ |
| feat     | ✨    | new capability                       |
| fix      | 🐛    | defect fix                           |
| refactor | ♻️    | structure without behavior change    |
| perf     | ⚡    | benchmarks and performance work      |
| test     | 🧪    | tests only                           |
| docs     | 📝    | README, specs, decisions             |
| chore    | 🔧    | tooling, dependencies, configuration |
| merge    | 🔀    | merge commits                        |

Specifications live in `specs/` and decisions in `decisions/`; both are the source of truth for behavior the code alone does not explain.

## References

- Park et al., Generative Agents: Interactive Simulacra of Human Behavior (2023); Park et al., Generative Agent Simulations of 1,000 People (2024)
- TRAILS: Stop Drawing Scientific Claims from LLM Social Simulations Without Robustness Audits (2026)
- SimBench (2025); MiroBench (2026)
- OASIS (2024); AgentSociety (2025, 2026); Concordia (2023); Mesa 4; AgentTorch (2024)
- APS (2026); TopoSim (2026); Poor Man's Agentic Modeling (2026); Affordable Generative Agents (2024)

## License

Apache-2.0
