# 审计参考

一份审计计划指明基线场景、扰动轴、设计、复制次数，以及要比较的指标。harness 生成条件，把每个条件的每次复制都送进内核跑一遍，再把结果交给一个纯粹的分析步骤，由它写出 `audit.json` 与 `report.html`。计划的字段来自 `src/core/schema.ts` 里的 `AuditPlanSchema` 与 `src/harness/plan.ts` 里的加载器；扰动轴目录是 `src/harness/axes.ts`；统计量与证据等级在 `src/harness/stats.ts`。

## 计划文档 {#plan-document}

| 字段           | type                                   | default         | 说明                                                                                                     |
| -------------- | -------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `baseScenario` | path                                   |                 | 基线场景文件，相对计划文件。`baseScenario` 与 `base` 必须且只能出现一个。                                |
| `base`         | inline scenario                        |                 | 一个完整的场景对象；其中的相对路径按计划文件所在目录解析。                                               |
| `hypothesis`   | object                                 | omitted         | 与场景里的形状相同。它的 outcomes 给每个指标一个期望方向，配上 `targetDistribution` 就是分布检验的目标。 |
| `axes`         | PerturbationAxis[]                     | `[]`            | 见[扰动轴](#axes)。                                                                                      |
| `design`       | `one_at_a_time` or `full_factorial`    | `one_at_a_time` | 见[条件](#conditions)。                                                                                  |
| `replications` | positive integer                       | `1`             | 每个条件跑几次；CLI、API 与 MCP 都能覆盖它。                                                             |
| `models`       | string[]                               | `[]`            | 模型名；每个名字都经 `llm.model` 变成每个条件的一个变体。                                                |
| `metrics`      | string[]                               | `[]`            | 指标名，从每次运行的 `result.json` 里读。                                                                |
| `claimType`    | `exploratory`, `mechanism` or `policy` | `exploratory`   | policy 类主张想拿 strong 等级，三个层级上都得有轴。                                                      |
| `concurrency`  | positive integer                       | `1`             | 同时在跑的运行数。不计入计划哈希，所以同一份计划在任何机器上都哈希相同。                                 |

自带的两份计划 `examples/prisoners_dilemma/audit.yaml` 与 `examples/echo_chamber/audit.yaml` 就是完整的例子。

## 扰动轴 {#axes}

| 字段        | type                          | 说明                                                                                |
| ----------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `id`        | non-empty string              | 出现在条件 id 与敏感度排序里。                                                      |
| `level`     | `micro`, `meso` or `macro`    | TRAILS 的层级。                                                                     |
| `kind`      | `design` or `representation`  | 变的是模拟由什么构成，还是同一份设计怎么写给模型。                                  |
| `dimension` | non-empty string              | 自由文本；下面目录里的名字是约定用法。                                              |
| `target`    | dotted path into the scenario | 例如 `prompt.personaFormat`、`params.framing`、`population.n`、`policy.options.p`。 |
| `levels`    | at least one JSON value       | 每个取值一个条件。target 能接受的任何值，靠重新校验场景来检查。                     |

target 在场景里不存在，报 `UnknownOverride`；某个取值被 schema 拒绝，报 `InvalidOverride` 并附上校验问题。两者都发生在任何一次运行开始之前。

### 扰动轴目录 {#axis-catalogue}

`src/harness/axes.ts` 里的 `AXIS_CATALOG` 为每个 TRAILS 维度固定了 level、kind、dimension 与一个默认 target；计划负责给出取值，也可以把 `target` 指向自己场景暴露的任意路径。默认 target 用的是示例场景里的参数名。

| code | id                        | level | kind           | dimension               | default target                   | 变的是什么                                       |
| ---- | ------------------------- | ----- | -------------- | ----------------------- | -------------------------------- | ------------------------------------------------ |
| D1   | `model_substrate`         | micro | design         | model substrate         | `llm.model`                      | 哪个模型家族或规模产出 agent 的决策。            |
| D2   | `agent_specification`     | micro | design         | agent specification     | `population.fields`              | 有哪些人格字段，以及它们怎么抽样。               |
| D3   | `internal_state`          | micro | design         | internal state          | `executors.0.options.components` | agent 身上带着哪些内部组件（指令、记忆、目标）。 |
| D4   | `memory_temporality`      | micro | design         | memory and temporality  | `params.memoryWindow`            | agent 记得多少历史，以及历史怎么压缩。           |
| D5   | `interaction_protocol`    | meso  | design         | interaction protocol    | `policy.options.p`               | 谁在什么时候行动：激活策略、轮流与同步。         |
| D6   | `intervention_design`     | macro | design         | intervention design     | `params.intervention`            | 处理怎么施加：时机、剂量与选取。                 |
| D7   | `environment_structure`   | meso  | design         | environment structure   | `params.homophily`               | 网络拓扑，以及推荐器之类的平台机制。             |
| D8   | `population_scale`        | macro | design         | population scale        | `population.n`                   | 有多少 agent 参与。                              |
| R1   | `representational_format` | micro | representation | representational format | `prompt.personaFormat`           | 同一份人格写成散文、要点还是表格。               |
| R2   | `instruction_hierarchy`   | micro | representation | instruction hierarchy   | `prompt.instructionOrder`        | 任务指令相对人格摆在哪里。                       |
| R3   | `linguistic_framing`      | micro | representation | linguistic framing      | `params.framing`                 | 同一情境的措辞：中性、道德化还是风险框架。       |
| R4   | `context_representation`  | micro | representation | context representation  | `prompt.memoryRepresentation`    | 同一份记忆写成对话记录、JSON 还是要点。          |
| R5   | `interaction_sequencing`  | meso  | representation | interaction sequencing  | `prompt.rolePlacement`           | 角色写在 system 轮还是 user 轮。                 |

在代码里，`axisFromTemplate(id, levels, { target? })` 从模板构造一条轴。

## 条件 {#conditions}

`one_at_a_time` 产出基线条件，外加每条轴的每个取值各一个条件；`full_factorial` 产出基线，外加所有轴的笛卡尔积。两者随后都与 `models` 相乘。基线条件排在最前，是每次成对检验的比较对象。条件 id 由 `<axis>=<level>` 用 `|` 连接而成，只有计划列出了模型时才追加 `@<model>`；某个扰动条件的场景若与基线哈希相同，会被标记为 `identicalToBase`。

每次复制都是该条件的场景，把 `replicationId` 设成复制序号，并把这个序号追加到 `seedPath` 上，于是 seed 是这份计划的一条谱系，而不是重新抽的随机数。审计内的 LLM 提供者温度一律强制为 0，复制之间只差在 seed。运行在 `concurrency` 个工作者组成的池里执行，各自的目录在 `runs/<condition>/<replication>/` 下；失败的运行变成一条带 `FailureInfo` 的失败 `RunResult`，绝不会中断整个审计。

## 证据等级 {#evidence-grade}

等级是设计本身的属性，在任何统计之前就已算出：

| 等级       | 条件                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `weak`     | 没有轴、复制次数少于 10 次，或者存在只有一个取值的轴。                                                            |
| `moderate` | 至少 10 次复制，且每条轴至少 2 个取值。                                                                           |
| `strong`   | 至少 30 次复制，每条轴至少 3 个取值，至少 2 个模型；`policy` 类主张还要求 micro、meso 与 macro 三个层级上都有轴。 |

## 统计量 {#statistics}

失败的运行，以及结束时 `integrity.complete` 为 false 的运行，作为数据留在报告里，但不进统计，除非加了 `--include-incomplete`（或 `includeIncomplete` 选项）。每份样本都先滤成有限值。

| 量                     | 方法                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mwuP`                 | 双侧 Mann-Whitney U：较小样本不足 8 个值且没有并列时精确枚举，否则用带并列校正与连续性校正的正态近似。                                                                   |
| `holmP`                | Holm 逐步降序校正，在每个指标内部施加。                                                                                                                                  |
| `cohenD`               | 均值差除以合并标准差；离散度为零时得到 0 或带符号的无穷，显示为 `inf`。                                                                                                  |
| `ci95`                 | 均值差的百分位 bootstrap，2000 次迭代，seed 取自计划哈希，因此区间可复现。                                                                                               |
| `directionFlip`        | 该条件的均值是否朝着假设对这个指标所期望的反方向移动。                                                                                                                   |
| `sensitivityRank`      | 对每条轴，取它在自己所有取值、所有指标上出现过的最大 Cohen d 绝对值。                                                                                                    |
| `directionConsistency` | 按指标统计，均值朝期望方向移动的条件占比。                                                                                                                               |
| `w1`、`cliffDelta`     | 基线样本与条件样本之间的 Wasserstein-1；条件相对基线的 Cliff's delta（并列不计入任何一侧）。                                                                             |
| `tvd`、`tvdBase`       | 给了 `targetDistribution` 时：条件与基线各自的合并分布到目标分布的总变差距离，按目标分布到均匀分布的距离归一（即 SimBench 分数，完全吻合为 100，不比均匀分布更近为 0）。 |
| `crossModel`           | 每个模型在所有条件上、每个指标的均值。                                                                                                                                   |

## 读报告 {#reading-the-report}

`report.html` 是一个自包含的文件，没有脚本、字体与外链，可以离线打开，也可以原样发出去。本站的[活报告](/zh/report)就是一份。它的章节依次是：

1. **计划概要**：场景、设计、主张类型、复制次数、条件数、运行计数（失败、不完整、被排除）、模型、指标与提供者覆盖，并把分级规则写明。
2. **扰动轴**：计划里的轴，连同它们的 target 与取值。
3. **条件**：每个条件的运行数、成功数、完整运行数，以及各指标的均值。
4. **与基线的成对检验**：每个指标一张表，按 Cohen d 绝对值排序，给出样本量、均值、差值、bootstrap 区间、Cohen d、原始 p 与 Holm 校正后的 p，以及 `flip` 标记。没有检验可做时，注释会说明是哪个前提不满足，比如每个条件可用的复制不足两次。
5. **按轴的敏感度**：把排序画成条形。
6. **方向一致性**与**跨模型均值**。
7. **分布检验**：W1、Cliff delta 与归一化后的 TVD。
8. **完整性与开销**：所有运行加总的完整性计数器，以及花掉的 LLM 调用与 token。

同样这些数字都在 `audit.json` 里；`simulacra report <auditDir>` 从它重新渲染 HTML，GUI 的审计视图与 MCP 的 `get_audit` 工具读的也是同一份报告。
