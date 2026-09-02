# Bench results

## Kernel

- date: 2026-09-02
- simulacra: 0.1.0
- bun: 1.3.11
- machine: Apple M5 Max

| run | agents | ticks | seconds | events | status | integrity.complete | digest |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| focal 1k mock | 1000 | 20 | 5.6 | 12415 | succeeded | true | 797393ff8fcc |
| cohort 100k rule | 100000 | 20 | 25.8 | 2001060 | succeeded | true | 19952d4c7596 |

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
