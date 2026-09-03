// Environment and endpoint checks behind `simulacra doctor` and the MCP doctor tool: Bun
// version, writable cwd, parseable built-in examples and, with llm, the endpoint probe from
// llm/probe (at most PROBE_MAX_CALLS requests). Also names the SIMULACRA_LLM_* variables.
// `simulacra doctor` 与 MCP doctor 工具背后的环境与端点检查：Bun 版本、cwd 可写、内置示例可解析，
// 带 llm 时再做 llm/probe 的端点探测（最多 PROBE_MAX_CALLS 次请求）。同时定义 SIMULACRA_LLM_*
// 变量名。

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

// The probe file carries the pid so two doctors in one directory do not delete each other's.
// 探测文件带 pid，同一目录里两个 doctor 不会互删。
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
	// A missing API key aborts with an error instead of a failed check: the probe cannot run at
	// all, and a partial list would read like a diagnosis.
	// 缺 API key 直接以错误中止而不是记一条失败检查：探测根本跑不了，残缺的列表会被当成诊断结论。
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
