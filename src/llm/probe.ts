// Endpoint probe behind `simulacra doctor --llm`: one structured call, one parallel batch and a
// cached-token check through the real gateway, capped at PROBE_MAX_CALLS so a probe never
// spends more than six requests.
// `simulacra doctor --llm` 背后的端点探测：经真实网关发一次结构化调用、一批并行请求并检查缓存 token，
// 以 PROBE_MAX_CALLS 封顶，一次探测最多花费六个请求。

import type { LLMRequest } from "../core/protocols";
import { LLMSpecSchema } from "../core/schema";
import type { LLMSpec } from "../core/types";
import { silentLogger } from "../logging/logger";
import { createGateway, type FetchLike } from "./gateway";

export const PROBE_MAX_CALLS = 6;
const PARALLEL = 4;
// A long shared system prefix gives prefix caching something to hit; cached_tokens reported
// on the parallel batch is the evidence that the endpoint exposes it.
// 较长的共享 system 前缀给前缀缓存提供命中机会；并行批次报告的 cached_tokens 就是端点暴露
// 该能力的证据。
const SHARED_PREFIX = Array.from(
	{ length: 40 },
	(_, i) => `Fact ${i + 1}: the simulation kernel records every decision as an event.`,
).join(" ");

export interface ProbeOptions {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey: string;
	readonly timeoutMs?: number;
	// Endpoint-specific body fields, e.g. DeepSeek's thinking switch. Without it a reasoning
	// model spends the whole 32-token probe budget on reasoning and the probe reports truncated.
	// 端点特有的请求体字段，例如 DeepSeek 的 thinking 开关。不带它时，推理模型会把 32 个 token 的
	// 探测预算全用在推理上，探测结果报 truncated。
	readonly extra?: LLMSpec["extra"];
}

export interface ProbeCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

export interface ProbeResult {
	readonly checks: readonly ProbeCheck[];
	readonly reachable: boolean;
	readonly jsonSchema: boolean;
	readonly concurrency: boolean;
	readonly cachedTokens: boolean;
	readonly calls: number;
}

// The key is injected through a fetch wrapper rather than the environment so the probe can
// test a key the shell does not export.
// 密钥经 fetch 包装注入而不是走环境变量，探测可以测试 shell 未导出的密钥。
const authorized =
	(apiKey: string): FetchLike =>
	(url, init) => {
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${apiKey}`);
		return fetch(url, { ...init, headers });
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

export const probeEndpoint = async (opts: ProbeOptions): Promise<ProbeResult> => {
	const spec = LLMSpecSchema.parse({
		baseUrl: opts.baseUrl,
		model: opts.model,
		concurrency: { initial: PARALLEL, max: PARALLEL },
		budget: { maxCalls: PROBE_MAX_CALLS, maxCompletionTokens: 32 },
		timeoutMs: opts.timeoutMs ?? 30000,
		...(opts.extra === undefined ? {} : { extra: opts.extra }),
	});
	const gateway = createGateway(spec, { logger: silentLogger, fetch: authorized(opts.apiKey) });
	const structured = await gateway.complete(
		request('Reply with the JSON object {"ok": true}.', {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
			additionalProperties: false,
		}),
	);
	const checks: ProbeCheck[] = [
		{
			name: "endpoint",
			ok: structured.ok,
			detail: structured.ok
				? `${spec.baseUrl} model=${structured.value.model} latency=${structured.value.latencyMs}ms`
				: `${spec.baseUrl}: ${structured.error.excType}: ${structured.error.message}`,
		},
	];
	if (!structured.ok)
		return {
			checks,
			reachable: false,
			jsonSchema: false,
			concurrency: false,
			cachedTokens: false,
			calls: gateway.ledger().llmCalls,
		};
	// An optional capability with a working fallback, reported like cached_tokens below: the
	// gateway switches to prompt mode on its own, so its absence is not a broken environment.
	// ProbeResult.jsonSchema stays the machine-readable answer.
	// 一个有可用降级路径的可选能力，与下方的 cached_tokens 同样处理：网关会自行切到 prompt 模式，
	// 缺少它并不代表环境有问题。机器可读的答案仍在 ProbeResult.jsonSchema。
	const jsonSchema = structured.value.structured === "json_schema";
	checks.push({
		name: "json_schema",
		ok: true,
		detail: jsonSchema
			? "response_format json_schema accepted"
			: "endpoint rejected json_schema, prompt mode used instead",
	});
	const parallel = await gateway.completeMany(
		Array.from({ length: PARALLEL }, (_, i) =>
			request(`Reply with the single word ready. Request ${i + 1}.`),
		),
	);
	const succeeded = parallel.filter((r) => r.ok).length;
	const concurrency = succeeded === PARALLEL;
	checks.push({
		name: "concurrency",
		ok: concurrency,
		detail: `${succeeded}/${PARALLEL} parallel requests succeeded, limit ${gateway.concurrencyLimit()}`,
	});
	const cachedTokens = parallel.some((r) => r.ok && r.value.usage.cachedTokens > 0);
	checks.push({
		name: "cached_tokens",
		ok: true,
		detail: cachedTokens
			? "cached_tokens reported on repeated prefixes"
			: "cached_tokens not reported (prefix caching unavailable or not exposed)",
	});
	const calls = gateway.ledger().llmCalls;
	checks.push({
		name: "calls",
		ok: calls <= PROBE_MAX_CALLS,
		detail: `${calls} calls made (budget ${PROBE_MAX_CALLS})`,
	});
	return { checks, reachable: true, jsonSchema, concurrency, cachedTokens, calls };
};
