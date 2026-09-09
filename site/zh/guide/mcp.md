# MCP 服务

`simulacra mcp` 通过 Model Context Protocol 在 stdio 上提供工具与资源，助手因此可以运行场景、查询事件、追踪 agent 与跑审计。这些工具与 CLI 一一对应，坐在同一套公共 API 上；服务实现在 `src/mcp/server.ts`。

## 启动 {#starting-it}

```bash
bun run simulacra mcp --data ./simulacra-data
```

运行与审计存放在 `--data` 下（默认 `./simulacra-data`），布局与 `simulacra serve` 用的一致，所以 GUI 能看到助手产出的东西。标准输出是传输通道，日志走标准错误；客户端关闭连接时进程退出。

客户端配置直接点名入口文件，这样在任何工作目录下都能用：

```json
{
	"mcpServers": {
		"simulacra": {
			"command": "bun",
			"args": [
				"/path/to/simulacra/src/cli/index.ts",
				"mcp",
				"--data",
				"/path/to/simulacra-data"
			]
		}
	}
}
```

同样一条命令把这个服务注册进 Claude Code：

```bash
claude mcp add simulacra -- bun /path/to/simulacra/src/cli/index.ts mcp --data /path/to/simulacra-data
```

用真实模型时，服务进程的环境里要有 `SIMULACRA_LLM_API_KEY`；用 `provider: "mock"` 则不需要密钥。

## 工具 {#tools}

每个工具都用 zod 校验输入，先回一段可读的文字，再附上同样内容的 JSON。失败时会置上 `isError`，并按 HTTP 400 响应体的形状回 `{ error, issues }`。

| 工具              | 输入                                                                              | 返回                                                                               |
| ----------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `list_examples`   | 无                                                                                | 内置示例：名字、`scenario.yaml` 路径，以及是否存在 `audit.yaml`。                  |
| `run_scenario`    | `scenarioYaml` 与 `example` 二选一；`seed` 必填；`name`、`ticks`、`provider` 可选 | 等运行结束，然后给出运行概要：完整性、开销、指标与资源 URI。                       |
| `get_run`         | `runId`                                                                           | 一次运行的进度与结果。                                                             |
| `query_events`    | `runId`；`kind`、`agentId`、`tick`、`limit` 可选                                  | 按时间排序的事件，默认 200 条，最多 1000 条。                                      |
| `get_agent_trace` | `runId`、`agentId`；`tick` 可选（默认取最近一次决策）                             | `simulacra inspect` 打印的那条可读因果链：观察、提示词预览、决策、效果、失败。     |
| `run_audit`       | `planYaml` 与 `examplePlan` 二选一；`name`、`replications`、`provider` 可选       | 等审计结束，然后给出证据等级、条件与运行计数、成对检验数量、敏感度排序与资源 URI。 |
| `get_audit`       | `auditId`                                                                         | 进度与一份精简报告：除了逐次运行的结果与运行索引，其余都在。                       |
| `doctor`          | 可选布尔值 `llm`                                                                  | 环境检查；`llm: true` 时还会探测端点，最多 6 次调用。                              |

`example` 与 `examplePlan` 接受内置示例的名字（`echo_chamber`、`prisoners_dilemma`）；计划就是该示例场景旁边的 `audit.yaml`，插件与录制的相对路径因此都能解析。内联的 YAML 按服务的工作目录解析。运行 id 沿用 HTTP 的规则：`<name>:0`，不给名字时是 `<scenarioId>-s<seed>:0`。

## 资源 {#resources}

| 模板                                  | 内容                                           |
| ------------------------------------- | ---------------------------------------------- |
| `simulacra://runs/{runId}/result`     | 一次运行的进度与完整 `RunResult`，JSON 格式。  |
| `simulacra://audits/{auditId}/report` | 进度与完整的 `AuditReport`，含逐次运行的结果。 |

两个模板都会列出注册表里现有的内容，客户端不必先调工具就能发现运行与审计。模板变量到达时是百分号编码的（运行 id 里含冒号），由服务解码。
