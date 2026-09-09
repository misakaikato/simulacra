---
title: Live report
---

<script setup>
import { withBase } from "vitepress";
</script>

# Live report

The report below was produced when this site was built, not drawn by hand. `site/scripts/demo-report.ts` loads `examples/prisoners_dilemma/audit.yaml`, runs it through the public `audit` function with the deterministic mock provider and five replications per condition, and renders the result with the same `renderReportHtml` the CLI uses. No model, key or network is involved, and because the plan, the provider and the seeds are fixed, every build produces the same bytes.

Five replications are below the ten a moderate grade requires, so the grade is weak by construction. The page shows what a report looks like and how its sections relate; the [audit reference](/guide/audits#reading-the-report) explains each of them. The report follows the operating system's colour scheme rather than the site's theme switch.

[Open the report in a new tab](/demo/report.html){target="_blank" rel="noopener"}

<iframe class="report-frame" :src="withBase('/demo/report.html')" title="Robustness audit report"></iframe>

## What the plan does

Three representation axes, each with three levels: persona format (`plain`, `bullets`, `table`), framing (`canonical`, `moralized`, `risk`) and memory representation (`transcript`, `json`, `bullets`). With the one-at-a-time design that is the base plus nine conditions; five replications each make fifty runs, all against a tit-for-tat opponent. The hypothesis expects cooperation to increase under the moralised framing and leaves the payoff direction open.

With the mock provider the LLM player is a deterministic function of the prompt hash and the seed, so the numbers say nothing about any model. Run the same plan against a real endpoint to get numbers that do:

```bash
bun run simulacra audit examples/prisoners_dilemma/audit.yaml --out audits/pd
```
