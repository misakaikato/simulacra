// Run the echo chamber with the deterministic mock provider, read the result,
// query the event log with SQL and print one agent's causal chain.
//
//   bun examples/programmatic/01-run-and-inspect.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, loadScenario, runScenario, withRunLog } from "../../src/index";

const scenario = loadScenario("examples/echo_chamber/scenario.yaml");
if (!scenario.ok) throw new Error(JSON.stringify(scenario.error));

const outDir = mkdtempSync(join(tmpdir(), "simulacra-example-"));
const result = await runScenario(scenario.value, outDir, {
	providerOverride: "mock",
	ticksOverride: 5,
	logLevel: "error",
});
if (!result.ok) throw new Error(result.error.message);

const run = result.value;
console.log(`status ${run.status}, ${run.integrity.activated} activations, metrics:`);
for (const [name, value] of Object.entries(run.metrics))
	console.log(`  ${name} = ${value.toFixed(4)}`);

const summary = withRunLog(outDir, (log) => {
	const byKind = log.sql<{ kind: string; n: number }>(
		"select kind, count(*) as n from events group by kind order by n desc",
	);
	const posts = log
		.query({ kind: ["decision"], tick: 2, limit: 1000 })
		.filter((e) => e.kind === "decision" && e.payload.action === "post");
	return { ok: true as const, value: { byKind, firstPoster: posts[0]?.agentId } };
});
if (!summary.ok) throw new Error(summary.error);
for (const row of summary.value.byKind) console.log(`  ${row.kind.padEnd(12)} ${row.n}`);

const agentId = summary.value.firstPoster;
if (agentId !== undefined) {
	const trace = inspect(outDir, { agentId, tick: 2 });
	if (!trace.ok) throw new Error(trace.error);
	console.log(
		`agent ${agentId} at tick 2: ${trace.value.chain.length} events in the causal chain`,
	);
	console.log(`  prompt preview: ${trace.value.promptPreview?.slice(0, 80) ?? "(none)"}`);
	console.log(`  decision: ${trace.value.decision?.payload.action ?? "(none)"}`);
	console.log(`  effects: ${trace.value.effects.length}`);
}

rmSync(outDir, { recursive: true, force: true });
