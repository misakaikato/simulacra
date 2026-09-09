# HTTP API

`simulacra serve` 在 `/api` 下提供一套 JSON API；`gui/dist` 构建过之后，`/` 上还有 GUI。响应契约是一个类型化模块 `src/api/contract.ts`，由 API、MCP 服务与 GUI 共用；路由在 `src/api/routes/`。服务只监听 `127.0.0.1`。

约定：

- 校验失败返回 `400 { issues: [{ path, message }] }`；其余错误以 404、409 或 500 返回 `{ error }`。非 API 路径返回纯文本。
- 路径参数经过 URL 编码；运行 id 里带冒号。
- 文档（`scenario`、`plan`）既可以是 YAML 文本，也可以是已经解析好的对象。与自带示例逐字相同的 YAML 文本，其中的相对路径（插件、录制）按那个示例所在的目录解析；其余一律按服务的工作目录解析。

## 路由 {#routes}

| 方法与路径                                | 响应                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                         | `{ ok: true, version }`                                                                                                                         |
| `GET /api/examples`                       | `{ name, yaml }[]`：内置示例及其 `scenario.yaml` 文本                                                                                           |
| `GET /api/runs`                           | `RunSummary[]`                                                                                                                                  |
| `POST /api/runs`                          | `201 { runId }`；已有同 id 的运行时返回 `409`                                                                                                   |
| `GET /api/runs/:id`                       | `RunSummary`                                                                                                                                    |
| `GET /api/runs/:id/events`                | 按时间排序的 `Event[]`。查询参数：`kind`（逗号分隔的事件种类）、`agent`、`tick`、`fromTick`、`toTick`、`limit`（默认 200，最多 1000）、`offset` |
| `GET /api/runs/:id/events/:eventId/chain` | `Event[]`：某条事件的因果链                                                                                                                     |
| `GET /api/runs/:id/content/:sha`          | `text/plain`：按内容哈希取回存下的提示词或响应                                                                                                  |
| `GET /api/runs/:id/agents`                | `{ id, columns }[]`；`columns` 里是公开的 `persona.*` 列，外加派生出的计数 `decisions` 与 `failures`                                            |
| `GET /api/runs/:id/graph`                 | `{ tick, edges: { src, dst, kind }[] }`。查询参数：`tick`；超出末尾的 tick 会被夹回并报出实际到达的 tick；世界里没有边表时返回空列表            |
| `GET /api/runs/:id/metrics`               | `Record<name, { tick, value }[]>`，只含数值型测量                                                                                               |
| `GET /api/runs/:id/stream`                | 服务器推送事件，见[流式输出](#streaming)                                                                                                        |
| `GET /api/audits`                         | `AuditSummary[]`                                                                                                                                |
| `POST /api/audits`                        | `201 { auditId }`；只有审计名已存在才返回 `409`；名字与轴的问题返回 `400`，问题定位在 `name` 或 `plan.axes`                                     |
| `GET /api/audits/:id`                     | `AuditSummary`                                                                                                                                  |
| `GET /api/audits/:id/report.html`         | HTML 报告；尚未生成时返回 `404`                                                                                                                 |

事件种类有 `activation`、`observation`、`decision`、`observation_batch`、`decision_batch`、`llm_call`、`effect`、`intervention`、`measurement`、`failure`、`checkpoint` 与 `module_step`。

## 请求体 {#request-bodies}

`POST /api/runs`：

| 字段       | type                | 说明                                                                        |
| ---------- | ------------------- | --------------------------------------------------------------------------- |
| `scenario` | YAML text or object | 必填。                                                                      |
| `seed`     | integer             | 必填。                                                                      |
| `name`     | string              | 可选。字母、数字、`.`、`_` 与 `-`，首字符为字母或数字；它会成为运行目录名。 |
| `ticks`    | positive integer    | 可选，覆盖 tick 总数。                                                      |
| `provider` | `mock` or `llm`     | 可选；替换掉每一个提供者。                                                  |

运行 id 是 `<name>:0`，不给名字时是 `<scenarioId>-s<seed>:0`，所以只有同名同 seed 才会冲突。

`POST /api/audits`：

| 字段           | type                | 说明                         |
| -------------- | ------------------- | ---------------------------- |
| `plan`         | YAML text or object | 必填。                       |
| `name`         | string              | 可选，规则与运行名相同。     |
| `replications` | positive integer    | 可选，覆盖计划里的复制次数。 |
| `provider`     | `mock` or `llm`     | 可选；替换掉每一个提供者。   |

两者都把工作放到后台并立刻返回；之后轮询概要，对运行也可以打开流。

## 响应形状 {#response-shapes}

```ts
interface RunSummary {
	runId: string;
	progress: { tick: number; ticks: number; status: "running" | "succeeded" | "failed" };
	agentCount: number;
	result?: RunResult; // metrics, distributions, integrity, cost, failure
	error?: string; // result.json unreadable
}

interface AuditSummary {
	auditId: string;
	progress: { completed: number; total: number; status: "running" | "succeeded" | "failed" };
	plan?: AuditPlan;
	report?: AuditReport;
	error?: string;
}
```

运行进行中时，`progress.tick` 是最近一次激活了 agent 的 tick；运行结束后，它是 tick 总数，失败时则是出错的那个 tick。`RunResult` 与 `AuditReport` 就是公共 API 返回的那两个类型；[审计参考](/zh/guide/audits)逐条说明了报告的字段。

## 流式输出 {#streaming}

`GET /api/runs/:id/stream` 是一条 SSE 流。运行进行中时，每条事件产生即写出：

```
event: event
data: {"eventId":"...","kind":"decision",...}
```

每 15 秒发一行注释（`: keepalive`），好让某个 tick 很慢时代理也保持连接。已经结束的运行则按时间顺序从日志里回放。两条路径都以这样收尾：

```
event: done
data: {"runId":"...","status":"succeeded"}
```

日志读不出来时，流同样以 `done` 和注册表里的状态收尾，客户端不会在一个坏掉的运行目录上干等。
