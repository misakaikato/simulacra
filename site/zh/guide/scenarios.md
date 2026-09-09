# 场景参考

一个场景就是一份 YAML 或 JSON 文档。校验它的是 `src/core/schema.ts` 里的 `ScenarioSchema`，本页的每个类型与默认值都读自这份 schema：场景文件、`POST /api/runs` 的请求体、MCP 的 `run_scenario` 工具，走的都是同一套定义。解析器会丢掉不认识的键，所以键名拼错不会让校验失败；运行目录里的 `scenario.json` 存的是补齐默认值、解析完参数之后的有效场景。

## 顶层字段 {#top-level-fields}

| 字段            | type                      | default               | 说明                                                                               |
| --------------- | ------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `scenarioId`    | non-empty string          | required              | 给运行命名。运行 id 是 `<scenarioId>:<replicationId>`。                            |
| `seed`          | integer                   | required              | 本次运行全部随机流的根。                                                           |
| `replicationId` | integer, at least 0       | `0`                   | 由审计 harness 为每次复制设置。                                                    |
| `seedPath`      | integer[]                 | `[]`                  | 根 seed 之下的派生路径；harness 会把复制序号追加到末尾。                           |
| `params`        | object                    | `{}`                  | 自由形式的值。插件选项用 `$param` 引用它们，审计的轴以 `params.<name>` 为 target。 |
| `population`    | object                    | required              | 规模、人格字段与抽样。见[人口](#population)。                                      |
| `modules`       | PluginSpec[]              | `[]`                  | 世界模块，在所有执行体行动完之后按顺序步进。                                       |
| `executors`     | PluginSpec[]              | `[]`                  | 执行体；每个都在 `options.provider` 里指明自己靠哪个提供者做决策。                 |
| `providers`     | map of name to PluginSpec | `{}`                  | 决策提供者，键名就是执行体与组合提供者引用它时用的名字。                           |
| `policy`        | PluginSpec                | `{ kind: allAgents }` | 激活策略：每个 tick 由哪些 agent 行动、以什么模式行动。                            |
| `instruments`   | InstrumentSpec[]          | `[]`                  | 指标与问卷。见[仪器](#instruments)。                                               |
| `steps`         | Step[]                    | `[]`                  | 运行日程。见[步骤](#steps)。                                                       |
| `llm`           | object                    | every field defaulted | 网关设置。见 [LLM](#llm)。                                                         |
| `prompt`        | object                    | every field defaulted | 人格、指令与记忆写给模型时的形态。见[提示词](#prompt)。                            |
| `plugins`       | string[]                  | omitted               | 导出 `register(registry)` 的模块，路径相对场景文件解析。                           |
| `hypothesis`    | object                    | omitted               | 干预与审计用的臂和结果。见[假设](#hypothesis)。                                    |

## 插件规格 {#plugin-specs}

`modules`、`executors`、`providers`、`policy` 与 `instruments` 用的是同一种引用形式。

| 字段      | type             | default  | 说明                                                             |
| --------- | ---------------- | -------- | ---------------------------------------------------------------- |
| `kind`    | non-empty string | required | 插件注册表里已注册的 kind。见[内置 kind](#built-in-kinds)。      |
| `name`    | non-empty string | the kind | 实例名。指标以它为名上报，模块与提供者按它寻址。                 |
| `options` | object           | `{}`     | 由插件自己的 zod schema 校验；选项非法时装配失败，并报出其路径。 |

执行体、策略与提供者都不接受多余字段。focal 执行体的选项是 `provider`（必填）、`components`（组件列表）、`entity`（默认 `agent`）、`actions`（已注册动作的一个子集）与 `where`（一张谓词表，把执行体限制在匹配的 agent 上，例如 `where: { persona.role: player }`）。cohort 执行体接受 `provider`、`features`、`transition`、`virtualActions`、`fallbackAction`、`neighborMean`、`where` 与 `recordFeatures`；`examples/echo_chamber/cohort.yaml` 把它们全都用上了。

## 参数引用 {#parameter-references}

插件选项要取值的任何地方，以及 `population.n`，写成 `{ $param: <name> }` 的对象都会在插件构造之前替换成 `params.<name>`。可选的 `map` 把参数的值当作字符串键，翻译成选项的值，于是一个枚举或数值参数可以驱动另一种类型的选项：

```yaml
params:
    framing: canonical
executors:
    - kind: focal
      options:
          components:
              - kind: instructions
                options:
                    text:
                        $param: framing
                        map:
                            canonical: You are playing a repeated prisoner's dilemma.
                            moralized: Cooperating is the honest choice.
```

参数不存在，或 `map` 里缺了对应的值，都会在该选项的路径上校验失败。`population.n` 在文档解析时就解析完，必须得到一个正整数；之后再覆盖 `params.n` 也不会重新推导它。审计的轴覆盖的是 `params.framing` 这类点分路径，所以一条轴就能触及所有引用该参数的选项。

## 人口 {#population}

| 字段         | type                                                                   | default               | 说明                                                          |
| ------------ | ---------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------- |
| `n`          | positive integer or `{ $param }`                                       | required              | 人口规模。                                                    |
| `fields`     | PersonaField[]                                                         | `[]`                  | 人格列，落成 `persona.<name>`。                               |
| `source`     | `{ kind: synthetic }`, `{ kind: csv, path }` or `{ kind: json, path }` | `{ kind: synthetic }` | 行数据从哪里来。                                              |
| `provenance` | `demographic`, `survey`, `interview` or `synthetic`                    | `synthetic`           | 记录下来的人口来源。                                          |
| `stratify`   | map of field to map of value to weight                                 | omitted               | 每个取值的目标比例，例如 `role: { player: 1, opponent: 1 }`。 |

一个人格字段：

| 字段       | type                                     | default  | 说明                                                       |
| ---------- | ---------------------------------------- | -------- | ---------------------------------------------------------- |
| `name`     | non-empty string                         | required |                                                            |
| `dtype`    | `f64`, `i32`, `bool`, `str` or `strlist` | required | 列类型。                                                   |
| `private`  | boolean                                  | omitted  | 私有字段永远不进提示词，也会从 API 返回的 agent 行里剔除。 |
| `sampling` | 见下                                     | required | 值怎么抽。                                                 |

抽样是三者之一：`{ kind: value, value }`（常量）、`{ kind: choice, choices, weights? }`（至少一个候选，权重可选且不能为负）、`{ kind: range, min, max }`（数值区间）。

## 步骤 {#steps}

步骤按顺序执行。没有步骤的场景一个 tick 都不跑。

| 步骤                                      | fields                                                               | 效果                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `{ kind: run, ticks }`                    | `ticks`: positive integer                                            | 把模拟推进这么多个 tick。                                              |
| `{ kind: intervene, arm, instruction? }`  | `arm`: the name of an arm in `hypothesis`; `instruction`: string     | 应用该臂的覆盖项，并通过 instructions 组件把它的指令交给选中的 agent。 |
| `{ kind: questionnaire, name, targets? }` | `name`: an instrument of kind `questionnaire`; `targets`: a selector | 访谈选中的 agent；回答成为 measurement 事件，绝不触碰世界状态。        |
| `{ kind: checkpoint }`                    |                                                                      | 写出 `checkpoints/<tick>/`：世界快照、时钟、执行体与提供者状态。       |

`simulacra resume` 从检查点目录续跑，会跳过排在检查点之后的干预步骤与问卷步骤；要跑这些步骤，就从头跑一次。

## 选择器 {#selectors}

问卷步骤里的 `targets`，以及假设某个臂里的 `selection`，都是选择器：

| 字段       | type                       | default  | 说明                              |
| ---------- | -------------------------- | -------- | --------------------------------- |
| `where`    | map of column to predicate | required | 所有谓词都要成立。                |
| `fraction` | number in [0, 1]           | omitted  | 在匹配到的 agent 里随机取的比例。 |
| `n`        | positive integer           | omitted  | 在匹配到的 agent 里取固定的个数。 |

谓词写成 `{ in: [values] }`、`{ gt: number }`、`{ lt: number }`，或者直接给一个字面值表示相等。操作符对象是严格的：`{ gt: 1, typo: 2 }` 会被拒绝，而不是被当成对整个对象的相等判断。

## LLM {#llm}

`llm` 块配置的是所有依赖 LLM 的插件共用的那一个网关。整块不写、或其中某个字段不写，得到的都是 DeepSeek 预设。

| 字段                         | type                              | default                       | 说明                                                                                                    |
| ---------------------------- | --------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `baseUrl`                    | non-empty string                  | `https://api.deepseek.com/v1` | 任何 OpenAI 兼容端点。                                                                                  |
| `model`                      | non-empty string                  | `deepseek-v4-flash`           | 也是审计轴 `model_substrate` 与计划里 `models` 列表作用的地方。                                         |
| `apiKeyEnv`                  | non-empty string                  | `SIMULACRA_LLM_API_KEY`       | 存放密钥的环境变量名；密钥本身永远不写进 YAML。                                                         |
| `mode`                       | `live`, `record` or `replay`      | `live`                        | `record` 把每条响应写到 `recordDir` 下，`replay` 从那里离线作答。                                       |
| `recordDir`                  | non-empty string                  | omitted                       | 录制目录，相对场景文件。                                                                                |
| `concurrency.initial`        | positive integer                  | `4`                           | 网关 AIMD 控制器的初始在途上限。                                                                        |
| `concurrency.max`            | positive integer                  | `16`                          | 同一个控制器的天花板。                                                                                  |
| `structured`                 | `auto`, `json_schema` or `prompt` | `auto`                        | 结构化输出模式；`auto` 会探测端点是否支持 `json_schema`。                                               |
| `budget.maxCalls`            | integer, at least 0               | `1000`                        | 每次运行的调用次数上限，超出后网关拒绝继续请求。                                                        |
| `budget.maxCompletionTokens` | positive integer                  | `512`                         | 单次调用的补全上限；LLM 提供者不能要得更多。                                                            |
| `timeoutMs`                  | positive integer                  | `60000`                       | 单次请求的超时。                                                                                        |
| `sendSeed`                   | boolean                           | `true`                        | 请求里是否带 `seed` 字段；`mlx-lm` 预设会关掉它。                                                       |
| `extra`                      | object                            | omitted                       | 请求体里额外的字段，例如给 DeepSeek 的 `{ thinking: { type: disabled } }`。网关自己占用的键不能被覆盖。 |

## 提示词 {#prompt}

`prompt` 块决定同一份人格、指令与记忆写给模型时长什么样。每个字段都是[扰动轴目录](/zh/guide/audits#axis-catalogue)里某条表示轴的默认 target。

| 字段                   | values                          | default      |
| ---------------------- | ------------------------------- | ------------ |
| `personaFormat`        | `plain`, `bullets`, `table`     | `plain`      |
| `instructionOrder`     | `first`, `last`                 | `first`      |
| `rolePlacement`        | `system`, `user`                | `system`     |
| `naming`               | `id`, `name`, `anonymous`       | `id`         |
| `memoryRepresentation` | `transcript`, `json`, `bullets` | `transcript` |
| `contextWindow`        | positive integer                | `4000`       |

## 仪器 {#instruments}

一条 `instruments` 条目是一份插件规格，外加 `every`：一个正整数，给出测量的 tick 间隔（默认每个 tick 都测）。注册为指标的 kind 从世界状态与事件日志算出一个数或一列数，并写一条 measurement 事件；注册为仪器的 kind 是问卷，`questionnaire` 步骤按名字引用它。`questionnaire` 这个 kind 接受 `questions`（至少一个 `{ id, prompt, responseType, choices? }`，其中 `responseType` 取 `text`、`integer`、`float` 或 `choice`，取 `choice` 时必须给出 `choices`）与 `entersMemory`（默认 `true`）。

## 假设 {#hypothesis}

| 字段        | type                                   | 说明                                                                                                    |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`        | non-empty string                       |                                                                                                         |
| `claim`     | string                                 | 用文字写出的主张。                                                                                      |
| `claimType` | `exploratory`, `mechanism` or `policy` | policy 类主张想拿 strong 等级，三个层级上都得有轴。                                                     |
| `arms`      | Arm[]                                  | `{ name, role: treatment or control, overrides (default {}), selection? }`。                            |
| `outcomes`  | Outcome[]                              | `{ name, metric, direction: increase, decrease or any (default any), targetDistribution?: number[] }`。 |

干预步骤点名一个臂：它的 `overrides` 应用到场景上，它的 `selection` 挑出 agent。在审计计划里，outcomes 给每个指标一个期望方向，配上 `targetDistribution` 就是分布检验的目标。

## 内置 kind {#built-in-kinds}

每个 kind 自己校验自己的选项；schema 就在标出的文件里。

| 槽位                          | kind                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `modules`                     | `socialGraph`（有向边表，follow 与 unfollow，在 tick 0 之前生成一次；`src/modules/socialGraph.ts`）、`feed`（帖子表，post、repost、reply、like 与 silent，每个用户一份排序过的 feed；推荐器有 `random`、`recency`、`followingFirst`、`homophily`；`src/modules/feed.ts`）、`calendar`（`src/modules/calendar.ts`） |
| `executors`                   | `focal`（`src/agents/focal.ts`）、`cohort`（`src/agents/cohort.ts`）                                                                                                                                                                                                                                               |
| `components`，在 `focal` 里   | `persona`、`instructions`、`recentMemory`、`summaryMemory`、`feedObservation`、`neighborhoodObservation`（`src/agents/components/`）                                                                                                                                                                               |
| `transitions`，在 `cohort` 里 | `opinionDynamics`（`src/agents/transitions/opinionDynamics.ts`）                                                                                                                                                                                                                                                   |
| `providers`                   | `llm`、`mock`、`rule`、`cohortRule`、`archetype`、`surrogate`、`cache`、`topo`、`aps`（`src/providers/`）；`rule` 需要在代码里注册一个规则函数，所以插件通常改为注册自己的 kind                                                                                                                                    |
| `policies`                    | `allAgents`、`bernoulli`（`p`）、`profileHourly`（`column`、`ticksPerHour`）、`maskTimer`（`maskColumn`、`timerColumn`）、`explicit`（`schedule`）；全都接受 `entity` 与 `mode`（`src/policies/index.ts`）                                                                                                         |
| `metrics`，作为仪器使用       | `columnMean`、`cooperationRate`、`averagePayoff`、`stanceAssortativity`、`sameGroupRatio`、`actionShare`、`tvdToTarget`（`src/metrics/index.ts`）                                                                                                                                                                  |
| `instruments`                 | `questionnaire`（`src/instruments/questionnaire.ts`）                                                                                                                                                                                                                                                              |
| `adapters`                    | `script`、`oasis`（`src/adapters/`）                                                                                                                                                                                                                                                                               |

`examples/` 里自带的场景用掉了其中大部分；仓库里最短的完整场景是 `examples/programmatic/02-custom-plugin.ts` 里的那段 YAML 字符串，[插件](/zh/guide/plugins)页面有全文。
