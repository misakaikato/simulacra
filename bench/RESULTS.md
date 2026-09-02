# Bench results

## Kernel

- date: 2026-09-03
- simulacra: 0.1.0
- bun: 1.3.11
- machine: Apple M5 Max

| run | agents | ticks | seconds | events | status | integrity.complete | digest |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| focal 1k mock | 1000 | 20 | 6.0 | 12415 | succeeded | true | 797393ff8fcc |
| cohort 100k rule | 100000 | 20 | 7.4 | 126 | succeeded | true | dfe2a9ccfe96 |

## LLM

- date: 2026-09-03
- simulacra: 0.1.0
- bun: 1.3.11
- machine: Apple M5 Max
- model: deepseek-v4-flash
- endpoint: https://api.deepseek.com/v1

| scenario | agents | ticks | llmCalls | promptTokens | completionTokens | cachedTokens | wall s | status | integrity.complete | parseFailures | llmFailures | truncated | rejectedActions | digest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |
| prisoners_dilemma | 2 | 5 | 5 | 2016 | 134 | 0 | 4.7 | succeeded | true | 0 | 1 | 0 | 0 | 228d09898dd2 |
| echo_chamber | 20 | 3 | 33 | 24088 | 1391 | 0 | 9.4 | succeeded | true | 0 | 1 | 0 | 0 | 64893fda51d9 |

total llmCalls: 38 (budget 150)

## Comparison

Same machine (Apple M5 Max), same micro-model: 100,000 agents on a random graph with mean degree 8, stance in [-2, 2], stubbornness in [0, 1], 50% activation per tick, opinion update `stance += 0.2 * (1 - stubbornness) * (neighborMean - stance)`, 20 ticks.

| system | what it keeps per agent-tick | 100k agents, 20 ticks |
| --- | --- | ---: |
| Mesa 3.5.1 (CPython 3.12) | nothing, in-memory state only | 1.38 s |
| simulacra cohort, in-memory event log | one entry in the tick's observation_batch and decision_batch events | 5.8 s |
| simulacra cohort, SQLite event log (default) | the same 125 events persisted | 7.2 s |

Reproduce with `uv run --with mesa --with networkx --with numpy --with pandas python bench/compare/mesa_echo.py` and `bun bench/compare/cohort_log_modes.ts`.

Prompt footprint per LLM decision, from the recordings in `examples/*/recordings` against the OASIS README baseline (100 agents, one step, full activation, 335,600 prompt tokens):

| system | scenario | prompt tokens per decision |
| --- | --- | ---: |
| OASIS | Twitter-style feed, README baseline | 3,356 |
| simulacra | echo chamber, feed size 5, memory window 2 | 730 |
| simulacra | prisoner's dilemma | 403 |

Scenario richness differs, so this is a footprint comparison, not a fidelity comparison. Throughput with a real model is bound by the endpoint on every framework: OASIS reports about two days for 100k agents over 10 steps on five A100s with Llama-3-8B, simulacra's DeepSeek runs above sustain about 3.5 decisions per second at concurrency 4.
