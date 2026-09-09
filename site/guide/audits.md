# Audit reference

An audit plan names a base scenario, perturbation axes, a design, a replication count and the metrics to compare. The harness generates conditions, runs every replication of every condition through the kernel, and hands the results to a pure analysis step that writes `audit.json` and `report.html`. Plan fields come from `AuditPlanSchema` in `src/core/schema.ts` and the loader in `src/harness/plan.ts`; the axis catalogue is `src/harness/axes.ts`; the statistics and the evidence grade are in `src/harness/stats.ts`.

## Plan document

| field          | type                                   | default         | notes                                                                                                                                                 |
| -------------- | -------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseScenario` | path                                   |                 | The base scenario file, relative to the plan file. Exactly one of `baseScenario` and `base`.                                                          |
| `base`         | inline scenario                        |                 | A full scenario object; its relative paths resolve against the plan file's directory.                                                                 |
| `hypothesis`   | object                                 | omitted         | Same shape as in a scenario. Its outcomes give each metric an expected direction and, with `targetDistribution`, a target for the distribution tests. |
| `axes`         | PerturbationAxis[]                     | `[]`            | See [Axes](#axes).                                                                                                                                    |
| `design`       | `one_at_a_time` or `full_factorial`    | `one_at_a_time` | See [Conditions](#conditions).                                                                                                                        |
| `replications` | positive integer                       | `1`             | Runs per condition; the CLI, API and MCP can override it.                                                                                             |
| `models`       | string[]                               | `[]`            | Model names; each becomes a variant of every condition through `llm.model`.                                                                           |
| `metrics`      | string[]                               | `[]`            | Metric names read from each run's `result.json`.                                                                                                      |
| `claimType`    | `exploratory`, `mechanism` or `policy` | `exploratory`   | Policy claims need axes at all three levels for a strong grade.                                                                                       |
| `concurrency`  | positive integer                       | `1`             | Runs in flight at once. Excluded from the plan hash, so the same plan hashes identically on any machine.                                              |

The shipped plans, `examples/prisoners_dilemma/audit.yaml` and `examples/echo_chamber/audit.yaml`, are complete examples.

## Axes

| field       | type                          | notes                                                                                         |
| ----------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `id`        | non-empty string              | Appears in condition ids and in the sensitivity ranking.                                      |
| `level`     | `micro`, `meso` or `macro`    | TRAILS level.                                                                                 |
| `kind`      | `design` or `representation`  | What the simulation is made of, or how the same design is written for the model.              |
| `dimension` | non-empty string              | Free text; the catalogue names below are the convention.                                      |
| `target`    | dotted path into the scenario | For example `prompt.personaFormat`, `params.framing`, `population.n`, `policy.options.p`.     |
| `levels`    | at least one JSON value       | One condition per level. Any value the target accepts, checked by re-validating the scenario. |

A target that does not exist in the scenario fails with `UnknownOverride`; a level the schema rejects fails with `InvalidOverride` and the validation issues, before any run starts.

### Axis catalogue

`AXIS_CATALOG` in `src/harness/axes.ts` fixes level, kind, dimension and a default target for each TRAILS dimension; a plan supplies the levels and may point `target` at whatever path its own scenario exposes. The default targets name the example scenarios' parameters.

| code | id                        | level | kind           | dimension               | default target                   | what varies                                                               |
| ---- | ------------------------- | ----- | -------------- | ----------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| D1   | `model_substrate`         | micro | design         | model substrate         | `llm.model`                      | Which model family or size produces the agents' decisions.                |
| D2   | `agent_specification`     | micro | design         | agent specification     | `population.fields`              | Which persona fields exist and how they are sampled.                      |
| D3   | `internal_state`          | micro | design         | internal state          | `executors.0.options.components` | Which internal components (instructions, memory, goals) an agent carries. |
| D4   | `memory_temporality`      | micro | design         | memory and temporality  | `params.memoryWindow`            | How much history an agent recalls and how it is compressed.               |
| D5   | `interaction_protocol`    | meso  | design         | interaction protocol    | `policy.options.p`               | Who acts when: activation policy, turn taking and synchrony.              |
| D6   | `intervention_design`     | macro | design         | intervention design     | `params.intervention`            | How a treatment is administered: timing, dose and selection.              |
| D7   | `environment_structure`   | meso  | design         | environment structure   | `params.homophily`               | Network topology and platform mechanics such as recommenders.             |
| D8   | `population_scale`        | macro | design         | population scale        | `population.n`                   | How many agents take part.                                                |
| R1   | `representational_format` | micro | representation | representational format | `prompt.personaFormat`           | Prose, bullets or a table for the same persona.                           |
| R2   | `instruction_hierarchy`   | micro | representation | instruction hierarchy   | `prompt.instructionOrder`        | Where task instructions sit relative to the persona.                      |
| R3   | `linguistic_framing`      | micro | representation | linguistic framing      | `params.framing`                 | Wording of the same situation: neutral, moralised or risk framed.         |
| R4   | `context_representation`  | micro | representation | context representation  | `prompt.memoryRepresentation`    | Transcript, JSON or bullets for the same memory.                          |
| R5   | `interaction_sequencing`  | meso  | representation | interaction sequencing  | `prompt.rolePlacement`           | Whether the role lives in the system turn or the user turn.               |

From code, `axisFromTemplate(id, levels, { target? })` builds an axis from a template.

## Conditions

`one_at_a_time` yields the base condition plus one condition per axis level; `full_factorial` yields the base plus the Cartesian product of all axes. Both are then crossed with `models`. The base condition comes first and is the baseline every pairwise test compares against. Condition ids are `<axis>=<level>` joined with `|`, with `@<model>` appended only when the plan lists models; a perturbed condition whose scenario hashes identically to the base is flagged `identicalToBase`.

Every replication is the condition's scenario with `replicationId` set to the replication index and that index appended to `seedPath`, so seeds are a lineage of the plan rather than fresh random numbers. LLM providers run with temperature forced to 0 inside an audit, so replications differ by seed alone. Runs execute in a pool of `concurrency` workers, each in its own directory under `runs/<condition>/<replication>/`; a run that fails becomes a failed `RunResult` with its `FailureInfo` and never aborts the audit.

## Evidence grade

The grade is a property of the design, computed before any statistics:

| grade      | condition                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weak`     | No axes, fewer than 10 replications, or any axis with a single level.                                                                              |
| `moderate` | At least 10 replications and every axis with at least 2 levels.                                                                                    |
| `strong`   | At least 30 replications, every axis with at least 3 levels, at least 2 models and, for `policy` claims, axes at the micro, meso and macro levels. |

## Statistics

Runs that failed, or finished with `integrity.complete` false, stay in the report as data and are excluded from the statistics unless `--include-incomplete` (or the `includeIncomplete` option) is set. Every sample is filtered to finite values first.

| quantity               | method                                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mwuP`                 | Two-sided Mann-Whitney U: exact enumeration when the smaller sample has fewer than 8 values and no ties, otherwise the normal approximation with tie and continuity corrections.                                                                           |
| `holmP`                | Holm step-down correction, applied within each metric.                                                                                                                                                                                                     |
| `cohenD`               | Mean difference over the pooled standard deviation; zero spread gives 0 or a signed infinity, shown as `inf`.                                                                                                                                              |
| `ci95`                 | Percentile bootstrap of the mean difference, 2000 iterations, seeded from the plan hash so the interval is reproducible.                                                                                                                                   |
| `directionFlip`        | Whether the condition's mean moves against the direction the hypothesis expects for that metric.                                                                                                                                                           |
| `sensitivityRank`      | For each axis, the largest absolute Cohen d observed at any of its levels across all metrics.                                                                                                                                                              |
| `directionConsistency` | Share of conditions whose mean moves in the expected direction, per metric.                                                                                                                                                                                |
| `w1`, `cliffDelta`     | Wasserstein-1 between the baseline and condition samples; Cliff's delta of the condition over the baseline (ties count for neither side).                                                                                                                  |
| `tvd`, `tvdBase`       | With a `targetDistribution`: total variation distance of the condition's and the baseline's pooled distribution to the target, normalised by the target's distance to uniform (the SimBench score, 100 for a perfect match, 0 for no closer than uniform). |
| `crossModel`           | Mean of each metric per model, over every condition.                                                                                                                                                                                                       |

## Reading the report

`report.html` is one self-contained file with no scripts, fonts or external links, so it opens offline and can be attached as-is. The [live report](/report) on this site is one. Its sections, in order:

1. **Plan summary**: scenario, design, claim type, replications, conditions, run counts (failed, incomplete, excluded), models, metrics and the provider override, with the grade rule spelled out.
2. **Perturbation axes**: the plan's axes with their targets and levels.
3. **Conditions**: runs, successes, complete runs and the mean of each metric per condition.
4. **Pairwise tests against the baseline**: one table per metric, ordered by absolute Cohen d, with sample sizes, means, difference, bootstrap interval, Cohen d, raw and Holm-corrected p, and a `flip` mark. When no test exists the note names the precondition that failed, such as fewer than two usable replications per condition.
5. **Sensitivity by axis**: the ranking as bars.
6. **Direction consistency** and **Cross-model means**.
7. **Distribution tests**: W1, Cliff delta and the normalised TVDs.
8. **Integrity and cost**: the integrity counters summed over all runs and the LLM calls and tokens spent.

The same numbers are in `audit.json`; `simulacra report <auditDir>` re-renders the HTML from it, and the GUI's audit view and the MCP `get_audit` tool read the same report.
