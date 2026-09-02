import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRegistry, loadScenario } from "../../src/index";
import { createGateway } from "../../src/llm/gateway";
import { createSimulation } from "../../src/core/simulation";
import { createMemoryEventLog } from "../../src/core/log";
import { silentLogger } from "../../src/logging/logger";

const loaded = loadScenario("../../examples/echo_chamber/cohort.yaml");
if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
for (const mode of ["memory", "sqlite"] as const) {
	const outDir = mkdtempSync(join(tmpdir(), "sim-iso-"));
	const registry = createDefaultRegistry();
	const t0 = performance.now();
	const sim = createSimulation(loaded.value, registry, {
		outDir,
		logger: silentLogger,
		createGateway: (spec, opts) => createGateway(spec, opts),
		...(mode === "memory" ? { log: createMemoryEventLog() } : {}),
	});
	if (!sim.ok) throw new Error(JSON.stringify(sim.error));
	const t1 = performance.now();
	for (let i = 0; i < 20; i++) {
		const r = await sim.value.step();
		if (!r.ok) throw new Error(JSON.stringify(r.error));
	}
	const t2 = performance.now();
	console.log(
		`| simulacra cohort 100k, ${mode} log | 20 ticks | assemble ${((t1 - t0) / 1000).toFixed(2)} s | steps ${((t2 - t1) / 1000).toFixed(2)} s | total ${((t2 - t0) / 1000).toFixed(2)} s | events ${sim.value.log.count()} |`,
	);
	rmSync(outDir, { recursive: true, force: true });
}
