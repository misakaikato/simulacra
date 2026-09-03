// Kernel throughput bench: runs the echo chamber with 1 000 focal agents on the mock provider
// and the 100 000-agent cohort variant on its rule provider, 20 ticks each, then upserts the
// table into bench/RESULTS.md. Runs in a temp directory that is removed afterwards.
// 内核吞吐基准：分别以 mock provider 跑 1000 个 focal agent 的回声室、以其 rule provider 跑
// 十万 agent 的 cohort 变体，各 20 tick，然后把表格 upsert 进 bench/RESULTS.md。
// 在临时目录里运行，结束后删除。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXAMPLES_DIR,
	digest,
	loadScenario,
	ok,
	overrideScenario,
	runScenario,
	withRunLog,
	type RunResult,
	type Scenario,
} from "../src/index";
import { RESULTS_FILE, metaLines, writeSection } from "./results";

// A machine-wide HTTP proxy would swallow Bun's localhost requests; NO_PROXY keeps them local.
// 机器级 HTTP 代理会吞掉 Bun 对 localhost 的请求；NO_PROXY 让它们留在本机。
process.env.NO_PROXY ??= "127.0.0.1,localhost";

interface BenchRow {
	readonly name: string;
	readonly agents: number;
	readonly ticks: number;
	readonly seconds: number;
	readonly events: number;
	readonly complete: boolean;
	readonly status: RunResult["status"];
	readonly digest: string;
}

const TICKS = 20;
const FOCAL_AGENTS = 1000;
const SECTION = "Kernel";

const load = (file: string): Scenario => {
	const loaded = loadScenario(join(EXAMPLES_DIR, "echo_chamber", file));
	if (!loaded.ok)
		throw new Error(loaded.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
	return loaded.value;
};

// The digest is recorded next to the timing so a performance change that alters the event log
// is visible in the same table.
// 摘要值与耗时并排记录，改变了事件日志的性能改动在同一张表里就能看出来。
const bench = async (
	name: string,
	scenario: Scenario,
	root: string,
	opts: { readonly providerOverride?: string },
): Promise<BenchRow> => {
	const outDir = join(root, name);
	const started = performance.now();
	const result = await runScenario(scenario, outDir, {
		...opts,
		ticksOverride: TICKS,
		overwrite: true,
		logLevel: "warn",
	});
	const seconds = (performance.now() - started) / 1000;
	if (!result.ok) throw new Error(`${name}: ${result.error.excType}: ${result.error.message}`);
	const events = withRunLog(outDir, (log) => ok(log.count()));
	const sha = digest(outDir);
	return {
		name,
		agents: scenario.population.n,
		ticks: TICKS,
		seconds,
		events: events.ok ? events.value : -1,
		complete: result.value.integrity.complete,
		status: result.value.status,
		digest: sha.ok ? sha.value : "",
	};
};

const focalScenario = (): Scenario => {
	const sized = overrideScenario(load("scenario.yaml"), "population.n", FOCAL_AGENTS);
	if (!sized.ok) throw new Error(`population.n override: ${sized.error.kind}`);
	return sized.value;
};

const table = (rows: readonly BenchRow[]): string =>
	[
		"| run | agents | ticks | seconds | events | status | integrity.complete | digest |",
		"| --- | ---: | ---: | ---: | ---: | --- | --- | --- |",
		...rows.map(
			(r) =>
				`| ${r.name} | ${r.agents} | ${r.ticks} | ${r.seconds.toFixed(1)} | ${r.events} | ${r.status} | ${r.complete} | ${r.digest.slice(0, 12)} |`,
		),
	].join("\n");

const main = async (): Promise<void> => {
	const root = mkdtempSync(join(tmpdir(), "simulacra-bench-"));
	try {
		const rows = [
			await bench("focal 1k mock", focalScenario(), root, { providerOverride: "mock" }),
			await bench("cohort 100k rule", load("cohort.yaml"), root, {}),
		];
		const body = [...metaLines(), "", table(rows)].join("\n");
		writeSection(RESULTS_FILE, SECTION, body);
		console.log(`# simulacra kernel bench`);
		console.log(``);
		console.log(body);
		console.log(``);
		console.log(`results: ${RESULTS_FILE}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

await main();
