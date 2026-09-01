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
	version,
	withRunLog,
	type RunResult,
	type Scenario,
} from "../src/index";

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

const load = (file: string): Scenario => {
	const loaded = loadScenario(join(EXAMPLES_DIR, "echo_chamber", file));
	if (!loaded.ok)
		throw new Error(loaded.error.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
	return loaded.value;
};

const machine = (): string => {
	const proc = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"]);
	const text = proc.success ? proc.stdout.toString().trim() : "";
	return text.length > 0 ? text : `${process.arch} (${process.platform})`;
};

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
		console.log(`# simulacra kernel bench`);
		console.log(``);
		console.log(`- date: ${new Date().toISOString().slice(0, 10)}`);
		console.log(`- simulacra: ${version}`);
		console.log(`- bun: ${Bun.version}`);
		console.log(`- machine: ${machine()}`);
		console.log(``);
		console.log(table(rows));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

await main();
