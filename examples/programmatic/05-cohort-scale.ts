// Scale with the cohort executor: override the population size of the columnar
// echo chamber, run 10 ticks with the rule provider, and report throughput.
//
//   bun examples/programmatic/05-cohort-scale.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenario, overrideScenario, runScenario, withRunLog } from "../../src/index";

const base = loadScenario("examples/echo_chamber/cohort.yaml");
if (!base.ok) throw new Error(JSON.stringify(base.error));

const n = 20_000;
const scenario = overrideScenario(base.value, "population.n", n);
if (!scenario.ok) throw new Error(JSON.stringify(scenario.error));

const outDir = mkdtempSync(join(tmpdir(), "simulacra-cohort-"));
const started = performance.now();
const result = await runScenario(scenario.value, outDir, { ticksOverride: 10, logLevel: "error" });
const seconds = (performance.now() - started) / 1000;
if (!result.ok) throw new Error(result.error.message);

const events = withRunLog(outDir, (log) => ({ ok: true as const, value: log.count() }));
if (!events.ok) throw new Error(events.error);
const agentTicks = result.value.integrity.activated;
console.log(
	`${n} agents, 10 ticks: ${seconds.toFixed(2)} s, ${agentTicks} activations (${Math.round(agentTicks / seconds)} per second), ${events.value} events, complete ${result.value.integrity.complete}`,
);
console.log(
	`mean stance: ${result.value.metrics["meanStance"]?.toFixed(4) ?? "(no meanStance metric)"}`,
);
rmSync(outDir, { recursive: true, force: true });
