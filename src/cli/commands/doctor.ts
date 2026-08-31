import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { LLMSpecSchema } from "../../core/schema";
import { loadScenario, version } from "../../index";
import { createGateway } from "../../llm/gateway";
import { silentLogger } from "../../logging/logger";
import type { LLMRequest } from "../../core/protocols";
import { EXAMPLES_DIR, listExamples } from "./examples";
import { fail, print } from "./shared";

export const API_KEY_ENV = "SIMULACRA_LLM_API_KEY";
export const BASE_URL_ENV = "SIMULACRA_LLM_BASE_URL";
export const MODEL_ENV = "SIMULACRA_LLM_MODEL";
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const MIN_BUN = [1, 3] as const;
const PARALLEL = 4;
const MAX_CALLS = 6;
const SHARED_PREFIX = Array.from(
	{ length: 40 },
	(_, i) => `Fact ${i + 1}: the simulation kernel records every decision as an event.`,
).join(" ");

export interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

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
	const broken = names.filter((n) => !loadScenario(join(dir, n, "scenario.yaml")).ok);
	return {
		name: "examples",
		ok: names.length > 0 && broken.length === 0,
		detail:
			broken.length === 0
				? `${names.length} parse (${names.join(", ")})`
				: `failed to parse: ${broken.join(", ")}`,
	};
};

const request = (content: string, schema?: LLMRequest["schema"]): LLMRequest => ({
	messages: [
		{ role: "system", content: SHARED_PREFIX },
		{ role: "user", content },
	],
	...(schema === undefined ? {} : { schema }),
	temperature: 0,
	maxTokens: 32,
	tags: { purpose: "doctor" },
	homogeneousGuard: false,
});

const llmChecks = async (opts: DoctorOptions): Promise<readonly DoctorCheck[]> => {
	const env = opts.env ?? process.env;
	if ((env[API_KEY_ENV] ?? "").length === 0) return fail(`${API_KEY_ENV} is not set`);
	const spec = LLMSpecSchema.parse({
		baseUrl: opts.baseUrl ?? env[BASE_URL_ENV] ?? DEFAULT_BASE_URL,
		model: opts.model ?? env[MODEL_ENV] ?? DEFAULT_MODEL,
		apiKeyEnv: API_KEY_ENV,
		concurrency: { initial: PARALLEL, max: PARALLEL },
		budget: { maxCalls: MAX_CALLS, maxCompletionTokens: 32 },
		timeoutMs: 30000,
	});
	const gateway = createGateway(spec, { logger: silentLogger });
	const structured = await gateway.complete(
		request('Reply with the JSON object {"ok": true}.', {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
			additionalProperties: false,
		}),
	);
	const checks: DoctorCheck[] = [
		{
			name: "endpoint",
			ok: structured.ok,
			detail: structured.ok
				? `${spec.baseUrl} model=${structured.value.model} latency=${structured.value.latencyMs}ms`
				: `${spec.baseUrl}: ${structured.error.excType}: ${structured.error.message}`,
		},
	];
	if (!structured.ok) return checks;
	checks.push({
		name: "json_schema",
		ok: structured.value.structured === "json_schema",
		detail:
			structured.value.structured === "json_schema"
				? "response_format json_schema accepted"
				: "endpoint rejected json_schema, prompt mode used",
	});
	const parallel = await gateway.completeMany(
		Array.from({ length: PARALLEL }, (_, i) =>
			request(`Reply with the single word ready. Request ${i + 1}.`),
		),
	);
	const succeeded = parallel.filter((r) => r.ok).length;
	checks.push({
		name: "concurrency",
		ok: succeeded === PARALLEL,
		detail: `${succeeded}/${PARALLEL} parallel requests succeeded, limit ${gateway.concurrencyLimit()}`,
	});
	const cached = parallel.some((r) => r.ok && r.value.usage.cachedTokens > 0);
	checks.push({
		name: "cached_tokens",
		ok: true,
		detail: cached
			? "cached_tokens reported on repeated prefixes"
			: "cached_tokens not reported (prefix caching unavailable or not exposed)",
	});
	checks.push({
		name: "calls",
		ok: gateway.ledger().llmCalls <= MAX_CALLS,
		detail: `${gateway.ledger().llmCalls} calls made (budget ${MAX_CALLS})`,
	});
	return checks;
};

export const doctor = async (opts: DoctorOptions): Promise<readonly DoctorCheck[]> => {
	const checks: DoctorCheck[] = [
		{ name: "simulacra", ok: true, detail: `version ${version}` },
		bunCheck(),
		writableCheck(opts.cwd ?? process.cwd()),
		examplesCheck(opts.examplesDir ?? EXAMPLES_DIR),
	];
	if (opts.llm) checks.push(...(await llmChecks(opts)));
	return checks;
};

export const doctorCommand = defineCommand({
	meta: {
		name: "doctor",
		description: "Check the environment; with --llm probe the endpoint (at most 6 calls)",
	},
	args: {
		llm: { type: "boolean", description: "probe the LLM endpoint" },
		"base-url": {
			type: "string",
			description: `endpoint base URL (default: $${BASE_URL_ENV} or DeepSeek)`,
		},
		model: {
			type: "string",
			description: `model name (default: $${MODEL_ENV} or ${DEFAULT_MODEL})`,
		},
	},
	run: async ({ args }) => {
		const checks = await doctor({
			llm: args.llm === true,
			...(args["base-url"] === undefined ? {} : { baseUrl: args["base-url"] }),
			...(args.model === undefined ? {} : { model: args.model }),
		});
		for (const c of checks) print(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
		const failed = checks.filter((c) => !c.ok);
		if (failed.length > 0) return fail(`${failed.length} check(s) failed`);
	},
});
