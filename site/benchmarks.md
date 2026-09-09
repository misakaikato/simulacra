---
title: Benchmarks
---

<!--@include: ../bench/RESULTS.md-->

## Summary

<!--@include: ../README.md#performance-->

## Reading the numbers

- `seconds` and `wall s` are wall-clock time for the whole run, including writing every event to `events.sqlite`. The comparison table shows what persistence costs: the same cohort run takes 5.8 s with an in-memory log and 7.2 s with SQLite.
- `events` counts rows in the event log. Focal agents write one observation and one decision per activation; the cohort writes one `observation_batch` and one `decision_batch` per tick, which is why 100,000 agents produce 126 events.
- `integrity.complete` is true when every activated agent ended in a decision or a recorded failure and no tick was cut short. The LLM rows each count one gateway failure under `llmFailures` and still complete: the failure is an event and a counter, not a hidden retry.
- `digest` is the sha256 of the event log, the value `simulacra digest` prints. Two runs of the same scenario and seed must agree on it, so the kernel rows are reproducible to the byte.
- `promptTokens` per decision is a footprint, not a fidelity measure; the scenarios differ in what each prompt carries.

The commands under each table reproduce it on your own machine: `bun bench/kernel.ts` for the kernel rows, `bun bench/llm.ts` with `SIMULACRA_LLM_API_KEY` set for the LLM rows, and the scripts in `bench/compare/` for the comparison.
