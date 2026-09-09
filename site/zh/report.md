---
title: 活报告
---

<script setup>
import { withBase } from "vitepress";
</script>

# 活报告

下面这份报告是本站构建时跑出来的，不是手画的。`site/scripts/demo-report.ts` 加载 `examples/prisoners_dilemma/audit.yaml`，用确定性的 mock 提供者、每个条件五次复制，经公共的 `audit` 函数跑完，再用 CLI 用的那个 `renderReportHtml` 渲染结果。全程不涉及模型、密钥与网络；计划、提供者与 seed 都是固定的，所以每次构建产出的字节都相同。

五次复制低于 moderate 等级要求的十次，所以等级从设计上就注定是 weak。这个页面展示报告长什么样、各节之间怎么呼应；[审计参考](/zh/guide/audits#reading-the-report)逐节做了说明。报告跟随操作系统的配色，而不是本站的主题开关。

[在新标签页打开报告](/demo/report.html){target="_blank" rel="noopener"}

<iframe class="report-frame" :src="withBase('/demo/report.html')" title="稳健性审计报告"></iframe>

## 这份计划做了什么 {#what-the-plan-does}

三条表示轴，每条三个取值：人格格式（`plain`、`bullets`、`table`）、措辞框架（`canonical`、`moralized`、`risk`）与记忆表示（`transcript`、`json`、`bullets`）。在 one_at_a_time 设计下，就是基线加九个条件；每个条件五次复制，合计五十次运行，对手一律是 tit-for-tat。假设预期在道德化措辞下合作率上升，收益的方向则不作预设。

用 mock 提供者时，LLM 玩家是提示词哈希与 seed 的确定性函数，所以这些数字说明不了任何模型的好坏。想要说得上话的数字，就把同一份计划对着真实端点跑一次：

```bash
bun run simulacra audit examples/prisoners_dilemma/audit.yaml --out audits/pd
```
