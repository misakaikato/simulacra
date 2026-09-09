# Getting started

simulacra is a Bun project. Clone it to run the CLI, the examples and the GUI, or add `@misakaikato/simulacra` as a dependency to call the public API from your own code; the package ships the same `simulacra` binary.

## Install

<!--@include: ../../README.md#install-->

As a dependency:

```bash
bun add @misakaikato/simulacra
```

## Three commands

<!--@include: ../../README.md#three-commands-->

## What a run produces

<!--@include: ../../README.md#run-artifacts-->

## Next

- [Scenarios](/guide/scenarios): every top-level field of `scenario.yaml`, with its type and default.
- [Audits](/guide/audits): the plan document, the perturbation-axis catalogue and how the report grades evidence.
- [Plugins](/guide/plugins): actions, modules, providers, policies, metrics and adapters as one file plus a `register` call.
- [CLI](/guide/cli), [HTTP API](/guide/api), [MCP](/guide/mcp) and [GUI](/guide/gui): the four entry points over one public API.
- [Live report](/report): an audit report generated when this site was built.
