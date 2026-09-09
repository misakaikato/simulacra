# 示例

`examples/` 里自带三个场景，它们同时也是验收用的固定样例：

| 场景                       | 模拟什么                                                                                                                        | `params` 里的旋钮                                                                                      | 指标                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `prisoners_dilemma`        | 一个 LLM 玩家对一个规则对手打 10 轮；模块、两个动作与对手策略都写在 `rules.ts` 里，兼作插件模板                                 | `framing` canonical · moralized · risk, `opponent` titForTat · random · alwaysCooperate · alwaysDefect | `cooperationRate`, `averagePayoff`                   |
| `echo_chamber`             | 幂律社交图上的 100 个人，带同质性重连与 hub 指派，通过推荐 feed 发帖与转发                                                      | `homophily`, `hub`, `activation`, `memoryWindow`, `feedSize`                                           | `stanceAssortativity`, `sameGroupRatio`, `postShare` |
| `echo_chamber/cohort.yaml` | 同一批人口写成 10 万人的列式 cohort，配向量化的意见动力学                                                                       | `n`                                                                                                    | `meanStance`                                         |
| `referendum`               | 200 名从 CSV 调查文件载入的选民决定一项地方征税；`intervene` 步骤请其中 20 人公开表态，问卷就是选票，插件指标把回答折算成支持率 | `homophily`, `activation`, `feedSize`, `memoryWindow`                                                  | `supportShare`, `stanceAssortativity`                |

每个场景旁边都有一份 `audit.yaml`。`examples/programmatic/` 里的程序化示例直接调用公共 API，并由测试套件执行：

| 文件                      | 展示什么                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ |
| `01-run-and-inspect.ts`   | 跑一个场景，读指标与完整性，用 SQL 查事件日志，打印某个 agent 的因果链         |
| `02-custom-plugin.ts`     | 在代码里定义一个模块、两个动作与一个规则提供者，并运行由 YAML 字符串构建的场景 |
| `03-audit.ts`             | 从代码里跑审计，读证据等级与敏感度排序，渲染 HTML 报告                         |
| `04-replay-recordings.ts` | 离线回放自带的 DeepSeek 录制，确认两次回放的摘要值一致                         |
| `05-cohort-scale.ts`      | 覆盖 cohort 场景的人口规模并测量吞吐                                           |

```bash
bun examples/programmatic/01-run-and-inspect.ts
```

第一个程序的核心：

```ts
import { inspect, loadScenario, runScenario, withRunLog } from "@misakaikato/simulacra";

const scenario = loadScenario("examples/echo_chamber/scenario.yaml");
if (!scenario.ok) throw new Error(JSON.stringify(scenario.error));

const result = await runScenario(scenario.value, "runs/echo", {
	providerOverride: "mock",
	ticksOverride: 5,
});
if (!result.ok) throw new Error(result.error.message);
console.log(result.value.metrics, result.value.integrity);

const counts = withRunLog("runs/echo", (log) => ({
	ok: true as const,
	value: log.sql<{ kind: string; n: number }>(
		"select kind, count(*) as n from events group by kind",
	),
}));

const trace = inspect("runs/echo", { agentId: someAgentId, tick: 2 });
```

## 复制一个示例 {#copying-an-example}

`bun run simulacra examples` 列出内置示例及其 `scenario.yaml` 路径。`bun run simulacra examples <name> --out <dir>` 把整个目录复制走，场景、审计计划与录制都在里面，于是副本里的相对路径照样成立。

## 囚徒困境 {#prisoners-dilemma}

重复囚徒困境：一个 LLM 驱动的玩家对上一个规则驱动的对手（`params.opponent`：titForTat、random、alwaysCooperate、alwaysDefect；`params.framing`：canonical、moralized、risk）。`pd` 世界模块、它的 `cooperate` / `defect` 动作与 `pdRule` 提供者都在 `rules.ts` 里，由场景的 `plugins` 字段声明并自动加载。

不用 LLM 跑：`bun run simulacra run examples/prisoners_dilemma/scenario.yaml --seed 1 --provider mock --out ./pd-run`

对着配置好的端点跑（需要 `SIMULACRA_LLM_API_KEY`）：去掉 `--provider mock`；随后 `bun run simulacra inspect ./pd-run --agent <id> --tick 3` 会显示某一轮的观察、提示词、决策与效果。

文件：[`scenario.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/prisoners_dilemma/scenario.yaml)、[`audit.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/prisoners_dilemma/audit.yaml)、[`rules.ts`](https://github.com/misakaikato/simulacra/blob/main/examples/prisoners_dilemma/rules.ts) 与 `recordings/` 目录。审计计划扰动人格格式、措辞框架与记忆表示，三条表示轴、每条三个取值；[活报告](/zh/report)背后就是这份计划。

## 回音室 {#echo-chamber}

文件：[`scenario.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/echo_chamber/scenario.yaml)（幂律图上的 100 个 focal agent，配一条推荐 feed）、[`cohort.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/echo_chamber/cohort.yaml)（同一批人口写成 10 万人的列式 cohort，配向量化的意见动力学转移）、[`audit.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/echo_chamber/audit.yaml)（五条设计轴：同质性、hub 指派、激活、记忆窗口与 feed 大小），以及 `recordings/` 目录。

## 程序化示例 {#programmatic-examples}

[`examples/programmatic/`](https://github.com/misakaikato/simulacra/tree/main/examples/programmatic) 里的五个程序导入公共 API，用 `bun examples/programmatic/<file>` 运行；测试套件会逐个执行它们。[插件](/zh/guide/plugins)页面把第二个完整嵌了进去。

## 公投 {#referendum}

文件：[`scenario.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/referendum/scenario.yaml)、[`audit.yaml`](https://github.com/misakaikato/simulacra/blob/main/examples/referendum/audit.yaml)、[`ballot.ts`](https://github.com/misakaikato/simulacra/blob/main/examples/referendum/ballot.ts) 与 [`voters.csv`](https://github.com/misakaikato/simulacra/blob/main/examples/referendum/voters.csv)。

200 名选民不是抽样生成的，而是从 CSV 载入，在一张同质性社交图上争论一项交通征税。其中 20 人被请去公开表态：对照臂里他们是随机抽的，干预臂里只从坚定支持者里抽。随后一份问卷把选票发给每个人，`ballot.ts` 里的 `supportShare` 指标再从事件日志里把回答读回来。

另外两个示例落下的部分，都在这个示例里：来自文件的人口、带选取规则的[干预步骤](/zh/guide/scenarios#steps)、[问卷仪器](/zh/guide/scenarios#instruments)、含对照与处理的[假设](/zh/guide/audits#hypotheses)，以及作为[插件](/zh/guide/plugins)发布的指标。它的审计计划是这里唯一一个声称政策效应的例子，所以证据等级要求三个层级上都有轴：macro 层是干预臂，meso 层是同质性与激活，micro 层是人格与记忆格式。
