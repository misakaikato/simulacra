---
layout: home
title: simulacra
titleTemplate: LLM social simulation with a robustness-audit harness
hero:
    name: simulacra
    text: Social simulation you can audit
    tagline: A typed, event-sourced kernel for LLM-driven social simulation. Every observation, decision and state change is a typed event, and the harness asks the question most simulation papers skip. Does the conclusion survive perturbation?
    image:
        src: /banner.jpg
        alt: simulacra
    actions:
        - theme: brand
          text: Get started
          link: /guide/getting-started
        - theme: alt
          text: GitHub
          link: https://github.com/misakaikato/simulacra
features:
    - title: Typed world state
      details: Columnar tables are the single source of truth. Agents, modules, and providers read views and emit effects; one resolver applies them.
    - title: Event sourcing
      details: Every observation, decision, LLM call, effect, and failure is an append-only event carrying its seed path. Replay is a fold. Same scenario, same seed, same digest.
    - title: Recorded LLM calls
      details: Real model outputs are recorded and replayed byte for byte, so audits re-analyze without re-spending tokens.
    - title: Failure is data
      details: Parse failures, rejected actions, truncated outputs, budget exhaustion, and circuit breaks are events with counts in every result, never silent fallbacks.
    - title: Batch decision providers
      details: Mix LLM, rule, mock, surrogate, archetype, and cache providers in one population; route through TopoSim-style cells or APS-style adaptive prototypes; every provider's own audit numbers land in the metrics.
    - title: Audit harness
      details: TRAILS-style perturbation axes across design and representation, replications with seed lineage, Mann–Whitney U, Holm correction, Cohen's d, bootstrap intervals, total variation distance, Wasserstein-1, Cliff's delta, and an evidence grade for the claim.
---

## Three commands

<!--@include: ../README.md#three-commands-->

## In numbers

<div class="stats">
<div><strong>401</strong><span>tests pass under <code>bun test</code></span></div>
<div><strong>12,415</strong><span>events from 1,000 focal agents over 20 ticks, 5.6 s</span></div>
<div><strong>100,000</strong><span>cohort agents over 20 ticks, 7.4 s</span></div>
<div><strong>3 + 5</strong><span>example scenarios and programmatic examples</span></div>
</div>

Timings come from the [benchmarks](/benchmarks), measured on an Apple M5 Max with Bun 1.3.11.

## In the browser

The run view: tick timeline with failure counts, the network coloured by stance, one agent's causal chain from observation to effects, metric series, integrity and cost.

<div class="screenshot">

![Run view](/screenshots/run.jpg)

</div>

The audit view: plan and evidence grade, perturbation axes, conditions, pairwise tests with Holm-corrected p values, sensitivity ranking and direction consistency.

<div class="screenshot">

![Audit view](/screenshots/audit.jpg)

</div>

## Where next

- [Getting started](/guide/getting-started) installs the project and explains the three commands.
- [Scenarios](/guide/scenarios) and [Audits](/guide/audits) document every field of the two YAML documents.
- [Live report](/report) shows an audit report generated when this site was built.
