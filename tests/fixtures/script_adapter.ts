import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const argOf = (flag: string): string | undefined => {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
};

const ConfigSchema = z.object({
	population: z.object({ n: z.number() }),
	params: z.record(z.string(), z.unknown()).default({}),
});

const configPath = argOf("--config");
const out = argOf("--out");
const seed = Number(argOf("--seed"));
if (configPath === undefined || out === undefined || !Number.isInteger(seed)) {
	console.error("usage: --config <file> --seed <n> --out <dir>");
	process.exit(2);
}
const config = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
const mode = typeof config.params.mode === "string" ? config.params.mode : "result";
console.log(`script mode=${mode} seed=${seed}`);
switch (mode) {
	case "fail":
		console.error("scripted failure");
		process.exit(3);
		break;
	case "silent":
		break;
	case "oasis": {
		const sql = config.params.sql;
		if (typeof sql !== "string") throw new Error("params.sql is required");
		const db = new Database(join(out, "oasis.db"));
		db.exec(readFileSync(sql, "utf8"));
		db.close();
		break;
	}
	default:
		writeFileSync(
			join(out, "result.json"),
			JSON.stringify({
				metrics: { seedTimesTwo: seed * 2, n: config.population.n },
				distributions: { d: [seed, seed + 1] },
				integrity: { activated: 4, ok: 4 },
			}),
		);
}
