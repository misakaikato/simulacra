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
