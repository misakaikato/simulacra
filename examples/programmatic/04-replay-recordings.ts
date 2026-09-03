// Replay the shipped DeepSeek recordings offline: the LLM player in the prisoner's
// dilemma answers from examples/prisoners_dilemma/recordings, so no key, no
// network and no tokens are needed, and two replays produce the same digest.
// 离线回放随包发布的 DeepSeek 录制：囚徒困境里的 LLM 玩家从 examples/prisoners_dilemma/recordings
// 作答，不需要密钥、网络与 token，两次回放产生相同的摘要值。
//
//   bun examples/programmatic/04-replay-recordings.ts

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, loadScenario, runScenario, type LLMSpec } from "../../src/index";

const scenario = loadScenario("examples/prisoners_dilemma/scenario.yaml");
if (!scenario.ok) throw new Error(JSON.stringify(scenario.error));

const recordDir = scenario.value.llm.recordDir;
if (recordDir === undefined) throw new Error("scenario declares no recordDir");
const recordings = readdirSync(recordDir).filter((f) => f.endsWith(".json"));
if (recordings.length === 0) throw new Error("no recordings; run bench/llm.ts with a key first");

// Recordings are keyed by model and request parameters, so replay with the same model
// and the same extra parameters that produced them.
// 录制按模型与请求参数作键，因此回放要用产生它们的同一模型与同样的 extra 参数。
const first = JSON.parse(readFileSync(join(recordDir, recordings[0] ?? ""), "utf8")) as {
	readonly request: { readonly model: string; readonly extra?: LLMSpec["extra"] };
};
const llmOverride: Partial<LLMSpec> = {
	mode: "replay",
	model: first.request.model,
	...(first.request.extra === undefined ? {} : { extra: first.request.extra }),
};

// Two passes into separate directories: equal digests show that replay is deterministic end
// to end, not only for the LLM answers.
// 两遍跑进不同目录：摘要值相等说明回放端到端确定，而不只是 LLM 回答确定。
const digests: string[] = [];
for (const pass of [1, 2]) {
	const outDir = mkdtempSync(join(tmpdir(), `simulacra-replay-${pass}-`));
	const result = await runScenario(scenario.value, outDir, {
		llmOverride,
		ticksOverride: 5,
		logLevel: "error",
	});
	if (!result.ok) throw new Error(result.error.message);
	const d = digest(outDir);
	if (!d.ok) throw new Error(d.error);
	digests.push(d.value);
	console.log(
		`pass ${pass}: ${result.value.status}, llmCalls ${result.value.integrity.llmCalls} (replay is free), llmFailures ${result.value.integrity.llmFailures}, cooperationRate ${result.value.metrics["cooperationRate"]?.toFixed(2)}`,
	);
	rmSync(outDir, { recursive: true, force: true });
}
console.log(`digests equal: ${digests[0] === digests[1]}`);
