// Scale with the cohort executor: override the population size of the columnar
// echo chamber, run 10 ticks with the rule provider, and report throughput.
// 用 cohort 执行体做规模化：覆盖列式回声室的人口规模，用 rule provider 跑 10 个 tick 并报告吞吐。
//
//   bun examples/programmatic/05-cohort-scale.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenario, overrideScenario, runScenario, withRunLog } from "../../src/index";

const base = loadScenario("examples/echo_chamber/cohort.yaml");
if (!base.ok) throw new Error(JSON.stringify(base.error));

const n = 20_000;
// overrideScenario applies a dotted-path override the way an audit axis does and validates the
// result again, so an impossible value fails here rather than inside the run.
// overrideScenario 像审计轴那样按点分路径覆盖并重新校验结果，不可能的值在这里就失败，而不是在运行里。
const scenario = overrideScenario(base.value, "population.n", n);
if (!scenario.ok) throw new Error(JSON.stringify(scenario.error));

const outDir = mkdtempSync(join(tmpdir(), "simulacra-cohort-"));
const started = performance.now();
const result = await runScenario(scenario.value, outDir, { ticksOverride: 10, logLevel: "error" });
const seconds = (performance.now() - started) / 1000;
if (!result.ok) throw new Error(result.error.message);

const events = withRunLog(outDir, (log) => ({ ok: true as const, value: log.count() }));
if (!events.ok) throw new Error(events.error);
// activated counts agent-ticks; activations per second is the number the kernel bench reports.
// activated 计的是 agent-tick；每秒激活数就是内核基准报告的数字。
const agentTicks = result.value.integrity.activated;
console.log(
	`${n} agents, 10 ticks: ${seconds.toFixed(2)} s, ${agentTicks} activations (${Math.round(agentTicks / seconds)} per second), ${events.value} events, complete ${result.value.integrity.complete}`,
);
console.log(
	`mean stance: ${result.value.metrics["meanStance"]?.toFixed(4) ?? "(no meanStance metric)"}`,
);
rmSync(outDir, { recursive: true, force: true });
