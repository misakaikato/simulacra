# 快速开始

simulacra 是一个 Bun 项目。克隆仓库即可运行 CLI、示例与 GUI；也可以把 `@misakaikato/simulacra` 加为依赖，在自己的代码里调用公共 API，包内附带同名的 `simulacra` 命令。以下引用的片段取自 README，原文为英文。

## 安装

<!--@include: ../../../README.md#install-->

作为依赖安装：

```bash
bun add @misakaikato/simulacra
```

## 三条命令

<!--@include: ../../../README.md#three-commands-->

## 一次运行产出什么

<!--@include: ../../../README.md#run-artifacts-->

## 接下来

技术文档为英文。

- [场景参考](/guide/scenarios)：`scenario.yaml` 的每个顶层字段、类型与默认值。
- [审计参考](/guide/audits)：计划文档、扰动轴目录与证据等级的判定。
- [插件](/guide/plugins)：动作、模块、提供者、策略、指标与适配器，一个文件加一次 `register` 调用。
- [CLI](/guide/cli)、[HTTP API](/guide/api)、[MCP](/guide/mcp) 与 [GUI](/guide/gui)：同一套公共 API 上的四个入口。
- [活报告](/report)：本站构建时真实跑出的审计报告。
