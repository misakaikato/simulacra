# Examples

<!--@include: ../README.md#examples-->

## Copying an example

`bun run simulacra examples` lists the built-in examples with their `scenario.yaml` paths. `bun run simulacra examples <name> --out <dir>` copies the whole directory, scenario, audit plan and recordings included, so the relative paths inside keep working from the copy.

## Prisoner's dilemma

<!--@include: ../examples/prisoners_dilemma/README.md-->

Files: [`scenario.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/prisoners_dilemma/scenario.yaml), [`audit.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/prisoners_dilemma/audit.yaml), [`rules.ts`](https://github.com/misakaikato/simulacra/blob/main/examples/prisoners_dilemma/rules.ts) and the `recordings/` directory. The audit plan perturbs persona format, framing and memory representation, three representation axes with three levels each; it is the plan behind the [live report](/report).

## Echo chamber

Files: [`scenario.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/echo_chamber/scenario.yaml) (100 focal agents on a power-law graph with a recommender feed), [`cohort.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/echo_chamber/cohort.yaml) (the same population as a columnar cohort of 100,000 with a vectorised opinion-dynamics transition), [`audit.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/echo_chamber/audit.yaml) (five design axes: homophily, hub assignment, activation, memory window and feed size) and the `recordings/` directory.

## Programmatic examples

The five programs in [`examples/programmatic/`](https://github.com/misakaikato/simulacra/tree/main/examples/programmatic) import the public API and run with `bun examples/programmatic/<file>`; the test suite executes each of them. The [plugins](/guide/plugins) page embeds the second one in full.

## Referendum

Files: [`scenario.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/referendum/scenario.yaml), [`audit.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/referendum/audit.yaml), [`ballot.ts`](https://github.com/misakaikato/simulacra/blob/main/examples/referendum/ballot.ts) and [`voters.csv`](https://github.com/misakaikato/simulacra/blob/main/examples/referendum/voters.csv).

Two hundred voters, loaded from a CSV rather than sampled, debate a transit levy on a homophilous social graph. Twenty of them are asked to advocate publicly: in the control arm they are drawn at random, in the treatment arm only from committed supporters. A questionnaire then puts the ballot to everyone, and the `supportShare` metric in `ballot.ts` reads the answers back out of the event log.

It is the example that exercises the parts the other two leave out: a population from a file, an [intervention step](/guide/scenarios#steps) with selectable arms, a [questionnaire instrument](/guide/scenarios#instruments), a [hypothesis](/guide/audits#hypotheses) with a control and a treatment, and a metric that ships as a [plugin](/guide/plugins). Its audit plan is the one case here that claims a policy effect, so the evidence grade demands axes at all three levels: the intervention arm at the macro level, homophily and activation at the meso level, persona and memory format at the micro level.
