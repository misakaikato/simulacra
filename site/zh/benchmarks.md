---
title: 基准
---

# 基准结果

## 内核 {#kernel}

- date: 2026-09-03
- simulacra: 0.1.0
- bun: 1.3.11
- machine: Apple M5 Max

| run              | agents | ticks | seconds | events | status    | integrity.complete | digest       |
| ---------------- | -----: | ----: | ------: | -----: | --------- | ------------------ | ------------ |
| focal 1k mock    |   1000 |    20 |     6.0 |  12415 | succeeded | true               | 797393ff8fcc |
| cohort 100k rule | 100000 |    20 |     7.4 |    126 | succeeded | true               | dfe2a9ccfe96 |

## LLM

- date: 2026-09-03
- simulacra: 0.1.0
- bun: 1.3.11
- machine: Apple M5 Max
- model: deepseek-v4-flash
- endpoint: https://api.deepseek.com/v1

| scenario          | agents | ticks | llmCalls | promptTokens | completionTokens | cachedTokens | wall s | status    | integrity.complete | parseFailures | llmFailures | truncated | rejectedActions | digest       |
| ----------------- | -----: | ----: | -------: | -----------: | ---------------: | -----------: | -----: | --------- | ------------------ | ------------: | ----------: | --------: | --------------: | ------------ |
| prisoners_dilemma |      2 |     5 |        5 |         2016 |              134 |            0 |    4.7 | succeeded | true               |             0 |           1 |         0 |               0 | 228d09898dd2 |
| echo_chamber      |     20 |     3 |       33 |        24088 |             1391 |            0 |    9.4 | succeeded | true               |             0 |           1 |         0 |               0 | 64893fda51d9 |

total llmCalls: 38 (budget 150)

## 横向对比 {#comparison}

同一台机器（Apple M5 Max），同一个微观模型：随机图上的 10 万个 agent，平均度 8，stance 落在 [-2, 2]，stubbornness 落在 [0, 1]，每个 tick 激活 50%，意见更新为 `stance += 0.2 * (1 - stubbornness) * (neighborMean - stance)`，共 20 个 tick。

| 系统                                      | 每个 agent-tick 留下什么                                        | 10 万 agent，20 tick |
| ----------------------------------------- | --------------------------------------------------------------- | -------------------: |
| Mesa 3.5.1 (CPython 3.12)                 | 什么都不留，只有内存里的状态                                    |               1.38 s |
| simulacra cohort，内存事件日志            | 在本 tick 的 observation_batch 与 decision_batch 事件里各占一条 |                5.8 s |
| simulacra cohort，SQLite 事件日志（默认） | 同样的 125 条事件落盘                                           |                7.2 s |

复现命令：`uv run --with mesa --with networkx --with numpy --with pandas python bench/compare/mesa_echo.py` 与 `bun bench/compare/cohort_log_modes.ts`。

每次 LLM 决策的提示词占用，取自 `examples/*/recordings` 里的录制，对照 OASIS README 的基线（100 个 agent、一步、全员激活、335,600 个 prompt token）：

| 系统      | 场景                            | 每次决策的 prompt token |
| --------- | ------------------------------- | ----------------------: |
| OASIS     | Twitter 式 feed，README 基线    |                   3,356 |
| simulacra | 回音室，feed 大小 5，记忆窗口 2 |                     730 |
| simulacra | 囚徒困境                        |                     403 |

场景的丰富程度并不相同，所以这是占用量的比较，不是保真度的比较。换成真实模型，任何框架的吞吐都受端点限制：OASIS 报告 10 万 agent 跑 10 步、在五张 A100 上用 Llama-3-8B 约需两天；上面 simulacra 的 DeepSeek 运行在并发 4 时稳定在每秒约 3.5 次决策。

## 小结 {#summary}

在 Apple M5 Max 与 Bun 1.3.11 上测得，完整表格见 `bench/RESULTS.md`。

| 运行                        |  agents | ticks |  wall | 说明                                            |
| --------------------------- | ------: | ----: | ----: | ----------------------------------------------- |
| focal，mock 提供者          |   1,000 |    20 | 5.6 s | 12,415 条事件                                   |
| cohort，规则提供者          | 100,000 |    20 | 7.4 s | 126 条事件，每个 tick 一条 `setColumn` 效果     |
| 囚徒困境，deepseek-v4-flash |       2 |     5 | 4.7 s | 5 次调用，2,016 个 prompt token，0 次解析失败   |
| 回音室，deepseek-v4-flash   |      20 |     3 | 9.4 s | 33 次调用，24,088 个 prompt token，0 次解析失败 |

`bun bench/kernel.ts` 离线复现前两行。`SIMULACRA_LLM_API_KEY=... bun bench/llm.ts` 复现后两行并刷新录制，调用上限 150 次。

与其他框架相比，同一台机器、同一个 10 万 agent 的意见模型跑 20 个 tick：Mesa 3.5.1 用 1.4 s，每个 agent-tick 什么都不留；simulacra 的 cohort 用 5.8 s，同时每个 tick 落下一条 observation batch 与一条 decision batch 事件，把这 125 条事件持久化到 SQLite 则是 7.2 s。按每次 LLM 决策算，回音室的提示词约 730 个 token，OASIS README 基线约 3,400 个；场景丰富程度不同，这只能读作占用量，不能读作保真度。细节与复现命令在 `bench/RESULTS.md`。

## 怎么读这些数字 {#reading-the-numbers}

- `seconds` 与 `wall s` 是整次运行的墙钟时间，包含把每条事件写进 `events.sqlite`。对比表显示了持久化的代价：同一次 cohort 运行，内存日志 5.8 s，SQLite 7.2 s。
- `events` 数的是事件日志里的行数。focal agent 每次激活写一条观察与一条决策；cohort 每个 tick 只写一条 `observation_batch` 与一条 `decision_batch`，所以 10 万个 agent 才只产出 126 条事件。
- `integrity.complete` 为 true，意味着每个被激活的 agent 都以一次决策或一次记录在案的失败收尾，并且没有 tick 被中途截断。两行 LLM 数据各自在 `llmFailures` 下记了一次网关失败，却仍然算完整：失败是一条事件加一个计数，不是被藏起来的重试。
- `digest` 是事件日志的 sha256，也就是 `simulacra digest` 打印的那个值。同一场景、同一 seed 的两次运行必须一致，所以内核这几行是逐字节可复现的。
- 每次决策的 `promptTokens` 是占用量，不是保真度指标；各个场景的提示词装的东西本来就不一样。

每张表下面的命令可以在自己机器上复现它：内核几行用 `bun bench/kernel.ts`，LLM 几行用设好 `SIMULACRA_LLM_API_KEY` 的 `bun bench/llm.ts`，对比部分用 `bench/compare/` 里的脚本。
