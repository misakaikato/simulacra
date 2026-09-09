# Plugins

Everything above `src/core` is a plugin registered by name. A new action, module, provider, activation policy, metric or adapter is one file that exports `register(registry)`; the kernel never changes. The interfaces on this page are declared in `src/core/protocols.ts`; the public API re-exports them from `@misakaikato/simulacra`.

## Loading a plugin

A scenario lists its plugins, relative to the scenario file:

```yaml
plugins: ["./rules.ts"]
```

The CLI accepts `--plugin <path>` on `run`, `audit` and `resume`, repeatable; a path listed by both the scenario and the flag registers once. Each module must export `register(registry)`, which may return nothing or a `Result`. A returned error (typically a duplicate kind) or a throw during import is reported with the plugin path, and the run fails before any tick.

From code, build the registry yourself and pass it in:

```ts
import { createDefaultRegistry, runScenario } from "@misakaikato/simulacra";

const registry = createDefaultRegistry();
register(registry);
await runScenario(scenario, "runs/demo", { registry });
```

`createDefaultRegistry()` holds every built-in kind; registering the same kind twice returns an error instead of replacing the built-in.

## The registry

| slot          | element type       | factory signature                                      |
| ------------- | ------------------ | ------------------------------------------------------ |
| `actions`     | `ActionDef`        | `register(def)`; actions are declared, not constructed |
| `executors`   | `Executor`         | `register(kind, factory)`                              |
| `transitions` | `Transition`       | `register(kind, factory)`                              |
| `modules`     | `Module`           | `register(kind, factory)`                              |
| `providers`   | `DecisionProvider` | `register(kind, factory)`                              |
| `policies`    | `ActivationPolicy` | `register(kind, factory)`                              |
| `metrics`     | `Metric`           | `register(kind, factory)`                              |
| `instruments` | `Questionnaire`    | `register(kind, factory)`                              |
| `adapters`    | `Adapter`          | `register(kind, factory)`                              |

A factory is `(spec, ctx) => Result<T, PluginError>`. `spec` is the plugin spec from the scenario (`kind`, `name`, `options`); `ctx` carries the scenario, the registry, a logger, the run's single LLM gateway (plugins must not build their own) and `provider(name)`, which resolves another provider declared in the scenario so composite providers can reach their downstream. `parseOptions(slot, spec, schema)` validates `spec.options` against a zod schema and turns a failure into a `PluginError` with paths.

## Actions

`defineAction` takes one declaration and yields the tool schema shown to the model, argument validation and the resolver:

| field             | meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `name`            | The action name a decision refers to.                                                                      |
| `description`     | Shown to the model in the tool schema.                                                                     |
| `params`          | A zod object schema; arguments are validated before `resolve` runs.                                        |
| `requiresModules` | Module names that must be present for the action to be available.                                          |
| `fallback`        | Exactly one action per registry is the fallback the kernel substitutes when a decision cannot be honoured. |
| `resolve`         | `(call, ctx) => Promise<Effect[]>`; effects go through the resolver, never straight into the world.        |

An effect is one of `set`, `inc`, `append` (one column of one row), `create`, `delete` (a row), `envSet` (an environment key) or `setColumn` (one column for many rows at once, the vectorised path cohorts use). Every effect names its `cause`, the event id it descends from, which is what `inspect` follows. This is the README's example:

<!--@include: ../../README.md#extending-->

## Modules

A module owns columns and steps the world once per tick, after every executor has acted.

| member                  | meaning                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `name`                  | Instance name; also the `owner` of the columns it declares.                                                    |
| `concurrencySafe`       | Modules that are safe to step under `Promise.all` say so; the others step in order.                            |
| `declare(world)`        | Declares columns (`entity`, `name`, `dtype`, `default`, `owner`, merge rule `last`, `sum`, `max` or `append`). |
| `actions()`             | The actions the module contributes.                                                                            |
| `observe(view, ids, t)` | What the module shows each agent; merged into the agent's observation.                                         |
| `step(view, t, rng)`    | Effects to apply at the end of the tick.                                                                       |
| `initialize?`           | Runs once before tick 0; its effects belong to the initialised world the first checkpoint captures.            |
| `graph?()`              | A `GraphView` (`neighbors`, `degree`, `edgeCount`) for routers and transitions.                                |
| `getState`, `setState`  | Module state for checkpoints; return `null` when the world holds everything.                                   |

Modules read through `WorldView` (`ids`, `count`, `column`, `row`, `env`, `columns`, `hash`) and never write directly; the resolver applies effects with the declared merge rules and rejects conflicts, which are counted as `droppedEffects`.

## Providers

A decision provider answers a batch of requests:

| member                  | meaning                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `decide(requests, ctx)` | One `Result<Decision, ProviderFailure>` per request, in request order; a length or agent mismatch fails the whole batch. |
| `reset(seedPath)`       | Re-seeds per replication so composite providers stay deterministic.                                                      |
| `fit?(trace)`           | Optional: learn from `(request, decision)` pairs, as the surrogate does.                                                 |
| `audit?(ctx)`           | Optional: the provider's own numbers, which land in the metrics.                                                         |
| `getState`, `setState`  | Provider state for checkpoints.                                                                                          |

A `Decision` carries `agentId`, `action`, `args`, `provenance` (`llm`, `surrogate`, `prototype`, `cache`, `rule` or `interview`), `cost` and `parseOk`; `parseOk: false` means the provider fell back to a default action. The request gives the agent's `state`, `observation`, `actionSpace`, optional `features` and, for LLM executors, the rendered `prompt`.

Most plugins do not implement the interface by hand. `createRuleProvider({ name, seed, rule })` wraps a `(request, rng) => Decision` function with a per-agent rng derived from the scenario seed, the round's seed path and the agent id, so an agent's stream does not depend on batch order; a throwing rule is a per-agent failure, not a crash. `examples/prisoners_dilemma/rules.ts` registers four opponent strategies this way under one kind, `pdRule`, and picks one from `options.strategy`.

## Activation policies

A policy selects who acts each tick from the world and the tick's rng alone, so activation is reproducible:

```ts
interface ActivationPolicy {
	readonly name: string;
	select(world: WorldView, t: LogicalTime, rng: Rng): Activation;
}
```

`Activation.agents` maps agent ids to a mode (`llm`, `rule`, `manual` or `interview`); `manualCalls` may supply ready-made action calls for agents activated in manual mode, which the kernel dispatches without observe or decide.

## Metrics

```ts
interface Metric {
	readonly name: string;
	compute(view: WorldView, log: EventLog, runId: RunId): number | readonly number[];
}
```

Register a metric under a kind in `registry.metrics`; a scenario then lists it under `instruments` with an `every` interval, and each computed value becomes a measurement event and a key in `result.json`. A metric may query the event log with the typed `query` filter or with free SQL over the `events` table.

## Adapters

An adapter brings an external simulation under the same audit harness:

```ts
interface Adapter {
	readonly name: string;
	toScenario(external: JsonValue): Result<Scenario, string>;
	run: RunFn; // (scenario, seed, outDir) => Promise<RunResult>
}
```

The built-in `script` adapter runs a subprocess that takes `--config`, `--seed` and `--out` and writes `result.json`; the `oasis` adapter imports an OASIS SQLite database as a run directory (also available as `simulacra import-oasis`). Both are in `src/adapters/`.

## A complete plugin in code

`examples/programmatic/02-custom-plugin.ts` defines a module, two actions and a rule provider, registers them and runs a scenario built from a YAML string, without any file on disk. The test suite executes it.

<<< ../../examples/programmatic/02-custom-plugin.ts

For a plugin loaded from a scenario file, read [`examples/prisoners_dilemma/rules.ts`](https://github.com/misakaikato/simulacra/blob/main/examples/prisoners_dilemma/rules.ts): a module that pairs agents and settles payoffs in `step`, `cooperate` and `defect` actions with `defect` as the fallback, and a rule provider with four strategies.
