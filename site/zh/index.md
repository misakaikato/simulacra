---
layout: home
title: simulacra
titleTemplate: 内置稳健性审计的 LLM 社会模拟内核
hero:
    name: simulacra
    text: 面向 LLM 驱动社会模拟的类型化事件溯源内核，内置稳健性审计 harness。
    tagline: 每次观察、决策与状态变化都是一条类型化事件。harness 接着追问大多数模拟论文跳过的问题：结论经得起扰动吗？
    image:
        src: /banner.jpg
        alt: simulacra
    actions:
        - theme: brand
          text: 快速开始
          link: /zh/guide/getting-started
        - theme: alt
          text: GitHub
          link: https://github.com/misakaikato/simulacra
features:
    - title: 类型化世界状态
      details: 列式表是唯一的真相源。agent、模块与提供者读取视图并产出效果；由一个解析器统一应用。
    - title: 事件溯源
      details: 每次观察、决策、LLM 调用、效果与失败都是一条只追加的事件，带着自己的种子路径。回放就是一次折叠。同一场景、同一种子、同一摘要值。
    - title: 录制的 LLM 调用
      details: 真实模型的输出逐字节录制与回放，审计重新分析时不再花费 token。
    - title: 失败即数据
      details: 解析失败、被拒动作、截断输出、预算耗尽与熔断都是事件，每份结果里都有计数，从不静默兜底。
    - title: 批量决策提供者
      details: 在同一人口里混用 LLM、规则、mock、代理模型、原型与缓存提供者；经 TopoSim 式的格元或 APS 式的自适应原型路由；每个提供者自己的审计数字都进入指标。
    - title: 审计 harness
      details: TRAILS 式的设计与表示扰动轴、带种子谱系的复制、Mann–Whitney U、Holm 校正、Cohen's d、bootstrap 区间、总变差距离、Wasserstein-1、Cliff's delta，以及对主张的证据等级。
---

## 三条命令

以下片段取自 README，原文为英文。

<!--@include: ../../README.md#three-commands-->

## 数字

<div class="stats">
<div><strong>401</strong><span>个测试通过 <code>bun test</code></span></div>
<div><strong>12,415</strong><span>条事件：1,000 个 focal agent 跑 20 tick，5.6 s</span></div>
<div><strong>100,000</strong><span>个 cohort agent 跑 20 tick，7.4 s</span></div>
<div><strong>3 + 5</strong><span>个示例场景与程序化示例</span></div>
</div>

耗时来自[基准](/benchmarks)（English），在 Apple M5 Max 与 Bun 1.3.11 上测得。

## 在浏览器里

运行视图：带失败计数的 tick 时间线、按立场着色的网络、单个 agent 从观察到效果的因果链、指标序列、完整性与开销。

<div class="screenshot">

![运行视图](/screenshots/run.jpg)

</div>

审计视图：计划与证据等级、扰动轴、条件、带 Holm 校正 p 值的成对检验、敏感度排序与方向一致性。

<div class="screenshot">

![审计视图](/screenshots/audit.jpg)

</div>

## 接下来

- [快速开始](/zh/guide/getting-started)：安装与三条命令。
- [场景参考](/guide/scenarios)与[审计参考](/guide/audits)（English）：两份 YAML 文档的每个字段。
- [活报告](/report)（English）：本站构建时真实跑出的审计报告。
