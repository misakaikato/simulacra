# GUI

GUI 是 `gui/` 下的一个 Vite + React 应用，只跟 [HTTP API](/zh/guide/api) 打交道。构建一次之后，`simulacra serve` 就会在 API 旁边把 `gui/dist` 提供出去：

```bash
bun run build:gui
bun run simulacra serve --data .
```

`--data .` 把服务指向一个目录，它的 `runs/` 与 `audits/` 里装着 CLI 的产出；默认是 `./simulacra-data`。GUI 没构建之前，`/` 返回一段纯文本说明，API 照常可用。开发时用 `bun run dev:gui` 启动 Vite，用 `bun run dev:mock` 启动一个 mock API。

GUI 有三个页面。

## 运行列表 {#runs}

运行与审计及各自的进度，加上一个启动运行的表单：选一个内置示例或粘贴 YAML，设定 seed（默认 1），可选地给出 tick 数（默认用场景里的总数）与提供者（`mock` 或 `llm`）。提交即 POST 到 `/api/runs`；新运行出现在列表里，并开始流式推送自己的事件。

<div class="screenshot">

![运行列表与新建运行表单](/screenshots/runs.jpg)

</div>

## 单次运行 {#run}

一次运行：带失败计数的 tick 时间线、按立场着色的力导向网络、把因果链从观察经提示词一路展示到决策与效果的 agent 检视器、指标序列，以及完整性与开销面板。检视器读的就是 `simulacra inspect` 打印的那条链。

<div class="screenshot">

![运行视图](/screenshots/run.jpg)

</div>

## 审计 {#audit}

一次审计：计划与它的证据等级、扰动轴、条件、带 Holm 校正 p 值的成对检验、敏感度排序、方向一致性、跨模型均值、分布检验、完整性与开销。同一次审计的离线 HTML 报告在 `/api/audits/:id/report.html` 上；[审计参考](/zh/guide/audits#reading-the-report)逐节做了说明。

<div class="screenshot">

![审计视图](/screenshots/audit.jpg)

</div>

<div class="screenshot">

![HTML 审计报告](/screenshots/report.jpg)

</div>
