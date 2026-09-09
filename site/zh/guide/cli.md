# CLI

在克隆下来的仓库里，每条命令都写成 `bun run simulacra <command>`；作为依赖安装时，同样的命令就是 `simulacra` 这个可执行文件。命令定义在 `src/cli/commands/`，一条命令一个文件；CLI 除了公共 API 什么都不导入。

共同行为：

- `--version`（或 `-v`）打印版本；`--help`（或 `-h`）打印用法，可以是整个 CLI 的，也可以是单条命令的。
- 任何错误都会向标准错误打印一行 `error: <message>`，并以退出码 1 结束。只有 `--log-level debug` 或 `trace` 才打印调用栈。
- `--log-level` 接受 `trace`、`debug`、`info`、`warn` 或 `error`；不给时级别取自环境变量 `SIMULACRA_LOG`，默认 `info`。
- `--plugin <path>` 指向一个导出 `register(registry)` 的模块，可以重复给；`--plugin x` 与 `--plugin=x` 都接受。
- `--provider mock` 或 `--provider llm` 把场景里的每个提供者都换成这个 kind，示例就是靠它在没有密钥时跑起来的。
- `--llm-mode live`、`record` 或 `replay` 设定本次运行的网关模式：`record` 写进场景的 `llm.recordDir`，`replay` 从那里作答。
- 会写目录的命令遇到非空目录一律拒绝，除非传了 `--overwrite`。

## run

`simulacra run <scenario> --out <dir>`：运行一个场景，写出事件、检查点与 `result.json`。

| 参数                 | 必填 | 说明                               |
| -------------------- | ---- | ---------------------------------- |
| `<scenario>`         | 是   | `scenario.yaml`（或 JSON）的路径。 |
| `--out`              | 是   | 输出目录。                         |
| `--seed`             | 否   | 覆盖场景里的 seed。                |
| `--ticks`            | 否   | 覆盖 tick 总数。                   |
| `--provider`         | 否   | `mock` 或 `llm`。                  |
| `--llm-mode`         | 否   | `live`、`record` 或 `replay`。     |
| `--plugin`           | 否   | 插件路径，可重复。                 |
| `--checkpoint-every` | 否   | 每 N 个 tick 写一个检查点。        |
| `--overwrite`        | 否   | 覆盖非空的输出目录。               |
| `--log-level`        | 否   | 日志级别。                         |

打印五行（`run <id> <status>`、`out`、`integrity`、`cost`、`metrics`）以及日志的摘要值。中途失败的运行同样已经写下结果与日志，所以概要会在非零退出之前先打印出来。

## audit

`simulacra audit <plan> --out <dir>`：跑一份计划，条件数乘复制次数，写出 `plan.json`、`audit.json`、`report.html`、`log.jsonl` 与 `runs/`。

| 参数                   | 必填 | 说明                                                |
| ---------------------- | ---- | --------------------------------------------------- |
| `<plan>`               | 是   | `audit.yaml` 的路径。                               |
| `--out`                | 是   | 输出目录。                                          |
| `--replications`       | 否   | 覆盖计划里的复制次数。                              |
| `--concurrency`        | 否   | 覆盖计划里的并发数。                                |
| `--provider`           | 否   | `mock` 或 `llm`，作用于每次运行，并记进报告。       |
| `--llm-mode`           | 否   | 每次运行的网关模式。                                |
| `--include-incomplete` | 否   | 把 `integrity.complete` 为 false 的运行留在统计里。 |
| `--plugin`             | 否   | 插件路径，可重复。                                  |
| `--overwrite`          | 否   | 覆盖非空的输出目录。                                |
| `--log-level`          | 否   | 日志级别。                                          |

打印计划哈希的前缀与等级、条件数、运行计数（失败、不完整、被排除）、成对检验的数量、证据等级，以及 `audit.json` 与 `report.html` 的路径。

## report

`simulacra report <auditDir> [--out <file>]`：从审计目录的 `audit.json` 重新渲染 `report.html`，渲染器改动之后不必重跑审计也能出新报告。不给 `--out` 时，文件写在 `audit.json` 旁边。

## replay

`simulacra replay <runDir> [--to-tick <n>]`：把录下的 effect 事件折叠到 tick 0 的检查点上，一直折到指定 tick 的开始，然后打印 `worldHash`、`tick`、起始的检查点与折叠掉的效果数。tick 超出运行末尾不算错误，会连同请求的 tick 一起打印最后的世界。

## resume

`simulacra resume <checkpointDir> --ticks <n> --out <dir>`：从 `<runDir>/checkpoints/<tick>` 再续跑 N 个 tick，写进一个新目录。场景与它的插件取自原来的运行目录；`--plugin`、`--overwrite`、`--checkpoint-every` 与 `--log-level` 的行为与 `run` 一致。排在检查点之后的干预步骤与问卷步骤会被跳过。

## inspect

`simulacra inspect <runDir> --agent <id> [--tick <n>] [--event <id>]`：打印某个 agent 的因果链、观察、提示词、决策与效果，可以指定 tick（默认取最近一次决策），也可以锚定某条事件 id。MCP 的 `get_agent_trace` 工具渲染的是同样的内容。

## digest

`simulacra digest <runDir>`：打印这次运行事件日志的 sha256 摘要值，同一场景、同一 seed 的两次运行必须在这个值上一致。

## import-oasis

`simulacra import-oasis <db> --out <dir> [--metrics a,b] [--overwrite]`：经 OASIS 适配器把一个 OASIS SQLite 数据库变成运行目录（`events.sqlite` 加 `result.json`），计算点名的指标 kind，并打印导入计数（agent、帖子、边、观察、决策、解析失败）。

## doctor

`simulacra doctor [--llm] [--base-url <url>] [--model <name>]`：打印环境检查（Bun 版本、simulacra 版本、工作目录可写、示例在位）。加上 `--llm` 还会探测端点是否可达、是否支持 `json_schema`、并发与缓存 token 上报，最多花掉 6 次调用。密钥取自 `SIMULACRA_LLM_API_KEY`；`--base-url` 与 `--model` 默认取 `SIMULACRA_LLM_BASE_URL` 与 `SIMULACRA_LLM_MODEL`，再退到 DeepSeek 与 `deepseek-v4-flash`。任何一项检查不通过，命令都以非零退出。

## examples

`simulacra examples` 列出内置示例及其 `scenario.yaml` 路径。`simulacra examples <name> [--out <dir>]` 把整个示例目录连同场景、审计计划与录制一起复制到 `--out` 或 `./<name>`；目标目录非空则拒绝。

## serve

`simulacra serve [--port <n>] [--data <dir>] [--log-level <l>]`：在 `127.0.0.1` 上提供 [HTTP API](/zh/guide/api) 与 [GUI](/zh/guide/gui)，默认端口 8787；`--port 0` 挑一个空闲端口。运行与审计存放在 `--data` 下，默认 `./simulacra-data`。标准输出只有地址与数据目录，日志走标准错误，进程一直活到 SIGINT 或 SIGTERM。

## mcp

`simulacra mcp [--data <dir>] [--log-level <l>]`：通过 stdio 提供 [MCP 的工具与资源](/zh/guide/mcp)，运行注册表放在 `--data` 上。日志走标准错误，因为标准输出是传输通道；客户端关闭连接时命令返回。
