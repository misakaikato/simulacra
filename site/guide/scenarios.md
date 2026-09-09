# Scenario reference

A scenario is one YAML or JSON document. `ScenarioSchema` in `src/core/schema.ts` validates it, and every type and default on this page is read from that schema: scenario files, `POST /api/runs` bodies and the MCP `run_scenario` tool all pass through the same definition. The parser drops keys it does not know, so a misspelt key does not fail validation; `scenario.json` in the run directory holds the effective scenario after defaults and parameter resolution.

## Top-level fields

| field           | type                      | default               | notes                                                                                             |
| --------------- | ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `scenarioId`    | non-empty string          | required              | Names the run. A run id is `<scenarioId>:<replicationId>`.                                        |
| `seed`          | integer                   | required              | Root of every random stream in the run.                                                           |
| `replicationId` | integer, at least 0       | `0`                   | Set by the audit harness for each replication.                                                    |
| `seedPath`      | integer[]                 | `[]`                  | Derivation path below the root seed; the harness appends the replication index.                   |
| `params`        | object                    | `{}`                  | Free-form values. Plugin options reference them with `$param`; audit axes target `params.<name>`. |
| `population`    | object                    | required              | Size, persona fields and sampling. See [Population](#population).                                 |
| `modules`       | PluginSpec[]              | `[]`                  | World modules, stepped in order after every executor has acted.                                   |
| `executors`     | PluginSpec[]              | `[]`                  | Executors; each names the provider it decides with in `options.provider`.                         |
| `providers`     | map of name to PluginSpec | `{}`                  | Decision providers, keyed by the name executors and composite providers use.                      |
| `policy`        | PluginSpec                | `{ kind: allAgents }` | Activation policy: which agents act each tick and in which mode.                                  |
| `instruments`   | InstrumentSpec[]          | `[]`                  | Metrics and questionnaires. See [Instruments](#instruments).                                      |
| `steps`         | Step[]                    | `[]`                  | The schedule. See [Steps](#steps).                                                                |
| `llm`           | object                    | every field defaulted | Gateway settings. See [LLM](#llm).                                                                |
| `prompt`        | object                    | every field defaulted | How persona, instructions and memory are written for the model. See [Prompt](#prompt).            |
| `plugins`       | string[]                  | omitted               | Modules exporting `register(registry)`, resolved relative to the scenario file.                   |
| `hypothesis`    | object                    | omitted               | Arms and outcomes for interventions and audits. See [Hypothesis](#hypothesis).                    |

## Plugin specs

`modules`, `executors`, `providers`, `policy` and `instruments` all use the same reference shape.

| field     | type             | default  | notes                                                                                     |
| --------- | ---------------- | -------- | ----------------------------------------------------------------------------------------- |
| `kind`    | non-empty string | required | A kind registered in the plugin registry. See [Built-in kinds](#built-in-kinds).          |
| `name`    | non-empty string | the kind | Instance name. Metrics report under it; modules and providers are addressed by it.        |
| `options` | object           | `{}`     | Validated by the plugin's own zod schema; an invalid option fails assembly with its path. |

Executors, policies and providers do not accept extra fields. The focal executor's options are `provider` (required), `components` (the component list), `entity` (default `agent`), `actions` (a subset of the registered actions) and `where` (a predicate map that limits the executor to matching agents, for example `where: { persona.role: player }`). The cohort executor takes `provider`, `features`, `transition`, `virtualActions`, `fallbackAction`, `neighborMean`, `where` and `recordFeatures`; `examples/echo_chamber/cohort.yaml` shows all of them in use.

## Parameter references

Anywhere a plugin option expects a value, and in `population.n`, an object of the form `{ $param: <name> }` is replaced by `params.<name>` before the plugin is constructed. An optional `map` translates the parameter's value, as a string key, into the option value, so one enum or numeric parameter can drive options of another type:

```yaml
params:
    framing: canonical
executors:
    - kind: focal
      options:
          components:
              - kind: instructions
                options:
                    text:
                        $param: framing
                        map:
                            canonical: You are playing a repeated prisoner's dilemma.
                            moralized: Cooperating is the honest choice.
```

An unknown parameter, or a value missing from `map`, fails validation at the option's path. `population.n` is resolved while the document is parsed and must give a positive integer; overriding `params.n` afterwards does not re-derive it. Because audit axes override dotted paths such as `params.framing`, one axis reaches every option that references the parameter.

## Population

| field        | type                                                                   | default               | notes                                                                         |
| ------------ | ---------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `n`          | positive integer or `{ $param }`                                       | required              | Population size.                                                              |
| `fields`     | PersonaField[]                                                         | `[]`                  | Persona columns, materialised as `persona.<name>`.                            |
| `source`     | `{ kind: synthetic }`, `{ kind: csv, path }` or `{ kind: json, path }` | `{ kind: synthetic }` | Where the rows come from.                                                     |
| `provenance` | `demographic`, `survey`, `interview` or `synthetic`                    | `synthetic`           | Recorded provenance of the population.                                        |
| `stratify`   | map of field to map of value to weight                                 | omitted               | Target proportions per value, for example `role: { player: 1, opponent: 1 }`. |

A persona field:

| field      | type                                     | default  | notes                                                                      |
| ---------- | ---------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `name`     | non-empty string                         | required |                                                                            |
| `dtype`    | `f64`, `i32`, `bool`, `str` or `strlist` | required | Column type.                                                               |
| `private`  | boolean                                  | omitted  | A private field never enters a prompt and is stripped from API agent rows. |
| `sampling` | see below                                | required | How the value is drawn.                                                    |

Sampling is one of `{ kind: value, value }` (a constant), `{ kind: choice, choices, weights? }` (at least one choice; optional non-negative weights) or `{ kind: range, min, max }` (numeric range).

## Steps

Steps run in order. A scenario without steps runs no ticks.

| step                                      | fields                                                               | effect                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `{ kind: run, ticks }`                    | `ticks`: positive integer                                            | Advances the simulation by that many ticks.                                                                         |
| `{ kind: intervene, arm, instruction? }`  | `arm`: the name of an arm in `hypothesis`; `instruction`: string     | Applies the arm's overrides and delivers its instruction to the selected agents through the instructions component. |
| `{ kind: questionnaire, name, targets? }` | `name`: an instrument of kind `questionnaire`; `targets`: a selector | Interviews the targeted agents; answers become measurement events and never touch the world.                        |
| `{ kind: checkpoint }`                    |                                                                      | Writes `checkpoints/<tick>/` with the world snapshot, clock, executor and provider state.                           |

`simulacra resume` continues from a checkpoint directory and skips intervention and questionnaire steps that follow it; run those from a fresh start.

## Selectors

`targets` in a questionnaire step and `selection` in a hypothesis arm are selectors:

| field      | type                       | default  | notes                                |
| ---------- | -------------------------- | -------- | ------------------------------------ |
| `where`    | map of column to predicate | required | All predicates must hold.            |
| `fraction` | number in [0, 1]           | omitted  | Random share of the matching agents. |
| `n`        | positive integer           | omitted  | Fixed number of the matching agents. |

A predicate is `{ in: [values] }`, `{ gt: number }`, `{ lt: number }` or a literal value for equality. Operator objects are strict: `{ gt: 1, typo: 2 }` is rejected rather than read as an equality test against the object.

## LLM

The `llm` block configures the one gateway every LLM-backed plugin shares. Omitting the block, or any field in it, gives the DeepSeek preset.

| field                        | type                              | default                       | notes                                                                                                                           |
| ---------------------------- | --------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                    | non-empty string                  | `https://api.deepseek.com/v1` | Any OpenAI-compatible endpoint.                                                                                                 |
| `model`                      | non-empty string                  | `deepseek-v4-flash`           | Also the target of the `model_substrate` audit axis and of a plan's `models` list.                                              |
| `apiKeyEnv`                  | non-empty string                  | `SIMULACRA_LLM_API_KEY`       | Name of the environment variable that holds the key; the key itself is never in YAML.                                           |
| `mode`                       | `live`, `record` or `replay`      | `live`                        | `record` writes every response under `recordDir`; `replay` answers from it, offline.                                            |
| `recordDir`                  | non-empty string                  | omitted                       | Recording directory, relative to the scenario file.                                                                             |
| `concurrency.initial`        | positive integer                  | `4`                           | Starting in-flight limit of the gateway's AIMD controller.                                                                      |
| `concurrency.max`            | positive integer                  | `16`                          | Ceiling of the same controller.                                                                                                 |
| `structured`                 | `auto`, `json_schema` or `prompt` | `auto`                        | Structured-output mode; `auto` probes the endpoint for `json_schema` support.                                                   |
| `budget.maxCalls`            | integer, at least 0               | `1000`                        | Calls per run before the gateway refuses further requests.                                                                      |
| `budget.maxCompletionTokens` | positive integer                  | `512`                         | Per-call completion cap; LLM providers cannot ask for more.                                                                     |
| `timeoutMs`                  | positive integer                  | `60000`                       | Per-request timeout.                                                                                                            |
| `sendSeed`                   | boolean                           | `true`                        | Whether the request carries a `seed` field; the `mlx-lm` preset turns it off.                                                   |
| `extra`                      | object                            | omitted                       | Extra request-body fields, such as `{ thinking: { type: disabled } }` for DeepSeek. Keys the gateway owns cannot be overridden. |

## Prompt

The `prompt` block decides how the same persona, instructions and memory are written for the model. Each field is the default target of one representation axis in the [audit catalogue](/guide/audits#axis-catalogue).

| field                  | values                          | default      |
| ---------------------- | ------------------------------- | ------------ |
| `personaFormat`        | `plain`, `bullets`, `table`     | `plain`      |
| `instructionOrder`     | `first`, `last`                 | `first`      |
| `rolePlacement`        | `system`, `user`                | `system`     |
| `naming`               | `id`, `name`, `anonymous`       | `id`         |
| `memoryRepresentation` | `transcript`, `json`, `bullets` | `transcript` |
| `contextWindow`        | positive integer                | `4000`       |

## Instruments

An instrument entry is a plugin spec plus `every`, a positive integer giving the tick interval (default every tick). A kind registered as a metric computes a number, or a list of numbers, from the world and the event log and writes a measurement event; a kind registered as an instrument is a questionnaire that `questionnaire` steps refer to by name. The `questionnaire` kind takes `questions` (at least one of `{ id, prompt, responseType, choices? }` with `responseType` one of `text`, `integer`, `float` or `choice`, and `choices` required for `choice`) and `entersMemory` (default `true`).

## Hypothesis

| field       | type                                   | notes                                                                                                  |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`        | non-empty string                       |                                                                                                        |
| `claim`     | string                                 | The claim in words.                                                                                    |
| `claimType` | `exploratory`, `mechanism` or `policy` | Policy claims need axes at all three levels for a strong grade.                                        |
| `arms`      | Arm[]                                  | `{ name, role: treatment or control, overrides (default {}), selection? }`.                            |
| `outcomes`  | Outcome[]                              | `{ name, metric, direction: increase, decrease or any (default any), targetDistribution?: number[] }`. |

An intervention step names an arm; its `overrides` are applied to the scenario and its `selection` chooses the agents. In an audit plan, the outcomes give each metric its expected direction and, with `targetDistribution`, the target for the distribution tests.

## Built-in kinds

Each kind validates its own options; the file named holds the schema.

| slot                     | kinds                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| modules                  | `socialGraph` (directed edge table, follow and unfollow, generated once before tick 0; `src/modules/socialGraph.ts`), `feed` (post table, post, repost, reply, like and silent, a ranked feed per user; recommenders `random`, `recency`, `followingFirst`, `homophily`; `src/modules/feed.ts`), `calendar` (`src/modules/calendar.ts`) |
| executors                | `focal` (`src/agents/focal.ts`), `cohort` (`src/agents/cohort.ts`)                                                                                                                                                                                                                                                                      |
| components, in `focal`   | `persona`, `instructions`, `recentMemory`, `summaryMemory`, `feedObservation`, `neighborhoodObservation` (`src/agents/components/`)                                                                                                                                                                                                     |
| transitions, in `cohort` | `opinionDynamics` (`src/agents/transitions/opinionDynamics.ts`)                                                                                                                                                                                                                                                                         |
| providers                | `llm`, `mock`, `rule`, `cohortRule`, `archetype`, `surrogate`, `cache`, `topo`, `aps` (`src/providers/`); `rule` needs a rule function registered in code, so plugins usually register their own kind instead                                                                                                                           |
| policies                 | `allAgents`, `bernoulli` (`p`), `profileHourly` (`column`, `ticksPerHour`), `maskTimer` (`maskColumn`, `timerColumn`), `explicit` (`schedule`); all accept `entity` and `mode` (`src/policies/index.ts`)                                                                                                                                |
| metrics, as instruments  | `columnMean`, `cooperationRate`, `averagePayoff`, `stanceAssortativity`, `sameGroupRatio`, `actionShare`, `tvdToTarget` (`src/metrics/index.ts`)                                                                                                                                                                                        |
| instruments              | `questionnaire` (`src/instruments/questionnaire.ts`)                                                                                                                                                                                                                                                                                    |
| adapters                 | `script`, `oasis` (`src/adapters/`)                                                                                                                                                                                                                                                                                                     |

The shipped scenarios in `examples/` use most of these; the shortest complete scenario in the repository is the YAML string in `examples/programmatic/02-custom-plugin.ts`, shown on the [plugins](/guide/plugins) page.
