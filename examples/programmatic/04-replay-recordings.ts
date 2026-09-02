// Replay the shipped DeepSeek recordings offline: the LLM player in the prisoner's
// dilemma answers from examples/prisoners_dilemma/recordings, so no key, no
// network and no tokens are needed, and two replays produce the same digest.
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
const first = JSON.parse(readFileSync(join(recordDir, recordings[0] ?? ""), "utf8")) as {
	readonly request: { readonly model: string; readonly extra?: LLMSpec["extra"] };
};
const llmOverride: Partial<LLMSpec> = {
	mode: "replay",
	model: first.request.model,
	...(first.request.extra === undefined ? {} : { extra: first.request.extra }),
};

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
