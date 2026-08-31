import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { err, ok } from "./core/result";
import { parseScenarioYaml } from "./core/scenario";
import type { Result } from "./core/types";
import { EXAMPLES_DIR, examplePath, listExamples } from "./examples";
import { probeEndpoint, type ProbeCheck } from "./llm/probe";
import { readFileSync } from "node:fs";

export const API_KEY_ENV = "SIMULACRA_LLM_API_KEY";
export const BASE_URL_ENV = "SIMULACRA_LLM_BASE_URL";
export const MODEL_ENV = "SIMULACRA_LLM_MODEL";
export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_MODEL = "deepseek-v4-flash";
const MIN_BUN = [1, 3] as const;

export type DoctorCheck = ProbeCheck;

export interface DoctorOptions {
	readonly llm: boolean;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly examplesDir?: string;
}

const bunCheck = (): DoctorCheck => {
	const [major = 0, minor = 0] = Bun.version.split(".").map(Number);
	const ok = major > MIN_BUN[0] || (major === MIN_BUN[0] && minor >= MIN_BUN[1]);
	return { name: "bun", ok, detail: `bun ${Bun.version} (need >= ${MIN_BUN.join(".")})` };
};

const writableCheck = (cwd: string): DoctorCheck => {
	const probe = join(cwd, `.simulacra-doctor-${process.pid}`);
	try {
		writeFileSync(probe, "ok");
		rmSync(probe);
		return { name: "cwd writable", ok: true, detail: cwd };
	} catch (e) {
		return {
			name: "cwd writable",
			ok: false,
			detail: `${cwd}: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
};

const examplesCheck = (dir: string): DoctorCheck => {
	if (!existsSync(dir)) return { name: "examples", ok: false, detail: `${dir} missing` };
	const names = listExamples(dir);
	const broken = names.filter(
		(n) => !parseScenarioYaml(readFileSync(examplePath(n, dir), "utf8")).ok,
	);
	return {
		name: "examples",
		ok: names.length > 0 && broken.length === 0,
		detail:
			broken.length === 0
				? `${names.length} parse (${names.join(", ")})`
				: `failed to parse: ${broken.join(", ")}`,
	};
};

export const doctor = async (
	opts: DoctorOptions,
): Promise<Result<readonly DoctorCheck[], string>> => {
	const checks: DoctorCheck[] = [
		{ name: "simulacra", ok: true, detail: `version ${pkg.version}` },
		bunCheck(),
		writableCheck(opts.cwd ?? process.cwd()),
		examplesCheck(opts.examplesDir ?? EXAMPLES_DIR),
	];
	if (!opts.llm) return ok(checks);
	const env = opts.env ?? process.env;
	const apiKey = env[API_KEY_ENV] ?? "";
	if (apiKey.length === 0) return err(`${API_KEY_ENV} is not set`);
	const probed = await probeEndpoint({
		baseUrl: opts.baseUrl ?? env[BASE_URL_ENV] ?? DEFAULT_BASE_URL,
		model: opts.model ?? env[MODEL_ENV] ?? DEFAULT_MODEL,
		apiKey,
	});
	return ok([...checks, ...probed.checks]);
};
