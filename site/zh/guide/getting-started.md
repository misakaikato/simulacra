# 快速开始

simulacra 是一个 Bun 项目。克隆仓库即可运行 CLI、示例与 GUI；也可以把 `@misakaikato/simulacra` 加为依赖，在自己的代码里调用公共 API，包内附带同一个 `simulacra` 命令。

## 安装 {#install}

需要 [Bun](https://bun.sh) 1.3 或更高版本。

```bash
git clone https://github.com/misakaikato/simulacra.git
cd simulacra
bun install
```

作为依赖安装：

```bash
bun add @misakaikato/simulacra
```

## 三条命令 {#three-commands}

用确定性的 mock 提供者运行回音室示例：

```bash
bun run simulacra run examples/echo_chamber/scenario.yaml --seed 7 --provider mock --out runs/echo
```

在人格格式、措辞框架与记忆表示三个方向上审计囚徒困境示例：

```bash
bun run simulacra audit examples/prisoners_dilemma/audit.yaml --replications 5 --provider mock --out audits/pd
```

打开 GUI 查看刚刚产出的运行与审计：

```bash
bun run simulacra serve --data .
```

换成真实模型：设好 `SIMULACRA_LLM_API_KEY`，去掉 `--provider mock`。任何 OpenAI 兼容端点都可以。默认是 DeepSeek，预设里关掉了思考，好让结构化回答装进不大的 token 预算；`mlx-lm` 与 LM Studio 的预设也只差一个参数。先跑一次 `bun run simulacra doctor --llm`，确认端点支持结构化输出、并发与缓存 token 上报。

两个示例都自带对 `deepseek-v4-flash` 的录制。加 `--llm-mode replay` 可以离线对着这些录制跑，加 `--llm-mode record` 则录制自己的。

## 一次运行产出什么 {#what-a-run-produces}

```
runs/echo/
  scenario.json      the effective scenario
  events.sqlite      every event, queryable with SQL
  log.jsonl          structured log with runId, tick, component
  checkpoints/<n>/   world snapshot, clock, executor and provider state
  result.json        metrics, integrity counts, cost
```

查看某个 agent 在某个 tick 上的因果链，从观察经提示词到决策与效果：

```bash
bun run simulacra inspect runs/echo --agent <id> --tick 3
```

把效果回放到任意 tick，并把世界哈希与检查点对上：

```bash
bun run simulacra replay runs/echo --to-tick 10
```

从检查点续跑。检查点之后的干预步骤与问卷步骤在续跑时会被跳过，要跑它们就从头开始。

```bash
bun run simulacra resume runs/echo/checkpoints/5 --ticks 5 --out runs/echo-resumed
```

## 接下来 {#next}

- [场景参考](/zh/guide/scenarios)：`scenario.yaml` 的每个顶层字段、类型与默认值。
- [审计参考](/zh/guide/audits)：计划文档、扰动轴目录与报告如何给证据分级。
- [插件](/zh/guide/plugins)：动作、模块、提供者、策略、指标与适配器，一个文件加一次 `register` 调用。
- [CLI](/zh/guide/cli)、[HTTP API](/zh/guide/api)、[MCP](/zh/guide/mcp) 与 [GUI](/zh/guide/gui)：同一套公共 API 上的四个入口。
- [活报告](/zh/report)：本站构建时真实跑出的审计报告。
