// Run the echo chamber with the deterministic mock provider, read the result,
// query the event log with SQL and print one agent's causal chain.
// 用确定性的 mock provider 跑回声室，读取结果，用 SQL 查询事件日志并打印一个 agent 的因果链。
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

// withRunLog opens the SQLite log, runs the callback and closes it; sql() is free-form SQL over
// the events table, query() the typed filter.
// withRunLog 打开 SQLite 日志、执行回调并关闭；sql() 是对 events 表的自由 SQL，query() 是类型化过滤。
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
	// inspect assembles the chain around the agent's decision at that tick: observation, prompt
	// preview, decision and the effects it caused.
	// inspect 围绕该 agent 在这个 tick 的决策拼出链条：观察、提示词预览、决策与它引起的效果。
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
