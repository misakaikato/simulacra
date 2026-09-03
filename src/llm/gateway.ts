// OpenAI-compatible chat gateway carrying the whole LLM policy: AIMD concurrency, retries with
// exponential backoff, a per-batch circuit breaker, json_schema-to-prompt fallback, record and
// replay keyed by sha256(promptHash, seed, params), nonce injection for the homogeneous guard,
// the call budget, and a cost ledger bucketed by purpose.
// 兼容 OpenAI 的对话网关，承载全部 LLM 策略：AIMD 并发、指数退避重试、按批次的断路器、json_schema
// 到 prompt 的回退、以 sha256(promptHash, seed, params) 为键的录制与回放、同质守卫的 nonce 注入、
// 调用预算，以及按 purpose 分桶的成本账本。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FAILURE_TYPES } from "../core/failures";
import { hashOf, sha256Hex } from "../core/hash";
import type {
	LLMFailure,
	LLMGateway,
	LLMRequest,
	LLMResponse,
	StructuredMode,
} from "../core/protocols";
import { err, ok } from "../core/result";
import { JsonValueSchema } from "../core/schema";
import type { Cost, JsonObject, JsonValue, LLMSpec, PromptMessage, Result } from "../core/types";
import type { Logger } from "../logging/logger";
import { extractLastJsonBlock, schemaInstruction } from "./structured";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GatewayDeps {
	readonly logger: Logger;
	readonly fetch?: FetchLike;
	readonly backoffBaseMs?: number;
	readonly onFailure?: (failure: LLMFailure) => void;
}

export interface Gateway extends LLMGateway {
	concurrencyLimit(): number;
	callsStarted(): number;
}

// Retry, backoff and breaker constants from the spec: three retries with 1s doubling to a 60s
// cap, twenty stable successes per additive step, ten final failures to open the circuit.
// 规格给定的重试、退避与断路常量：最多重试三次，1s 起倍增、封顶 60s，每二十次稳定成功加一并发，
// 十次最终失败断路。
const MAX_RETRIES = 3;
const BACKOFF_CAP_MULTIPLIER = 60;
const AIMD_STABLE_SUCCESSES = 20;
const CIRCUIT_THRESHOLD = 10;
const PREVIEW_CHARS = 200;

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const addCost = (a: Cost, b: Cost): Cost => ({
	llmCalls: a.llmCalls + b.llmCalls,
	promptTokens: a.promptTokens + b.promptTokens,
	completionTokens: a.completionTokens + b.completionTokens,
	cachedTokens: a.cachedTokens + b.cachedTokens,
	wallMs: a.wallMs + b.wallMs,
});

// AIMD: a 429 or timeout halves the limit at once, twenty consecutive successes add one; the
// limit stays within [1, max]. Waiters are released as the limit grows.
// AIMD：一次 429 或超时立即把并发减半，连续二十次成功加一；上限始终在 [1, max] 内。
// 并发放宽时唤醒等待者。
class AdaptiveSemaphore {
	private limit: number;
	private readonly max: number;
	private active = 0;
	private streak = 0;
	private readonly waiters: (() => void)[] = [];

	constructor(initial: number, max: number) {
		this.max = Math.max(1, max);
		this.limit = Math.max(1, Math.min(initial, this.max));
	}

	get currentLimit(): number {
		return this.limit;
	}

	acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active += 1;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		this.active -= 1;
		this.drain();
	}

	halve(): void {
		this.limit = Math.max(1, Math.floor(this.limit / 2));
		this.streak = 0;
	}

	succeed(): void {
		this.streak += 1;
		if (this.streak >= AIMD_STABLE_SUCCESSES) {
			this.streak = 0;
			this.limit = Math.min(this.max, this.limit + 1);
			this.drain();
		}
	}

	private drain(): void {
		while (this.active < this.limit && this.waiters.length > 0) {
			const next = this.waiters.shift();
			if (next === undefined) break;
			this.active += 1;
			next();
		}
	}
}

const UsageSchema = z
	.object({
		prompt_tokens: z.number().optional(),
		completion_tokens: z.number().optional(),
		prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
	})
	.optional();

// Only the fields the gateway reads are parsed; reasoning_content is needed to tell an empty
// answer apart from an answer that went entirely into the reasoning channel.
// 只解析网关会读的字段；reasoning_content 用于区分真正的空回复与整段落进推理通道的回复。
const CompletionSchema = z.object({
	model: z.string().optional(),
	choices: z
		.array(
			z.object({
				message: z.object({
					content: z.string().nullable().optional(),
					reasoning_content: z.string().nullable().optional(),
				}),
				finish_reason: z.string().nullable().optional(),
			}),
		)
		.min(1),
	usage: UsageSchema,
});

const FINISH_LENGTH = "length";

// Request-body keys the gateway owns; LLMSpec.extra never overrides them
// 网关自有的请求体键；LLMSpec.extra 永远不能覆盖它们
const RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"max_tokens",
	"temperature",
	"seed",
	"response_format",
]);

// A recording stores request metadata and the raw response text; parsed output is derived
// again on replay so a recording never bakes in a parser version.
// 录制文件保存请求元数据与原始响应文本；解析结果在回放时重新推导，录制不会固化某个解析器版本。
const RecordingSchema = z.object({
	version: z.literal(1),
	key: z.string(),
	request: z.object({
		promptHash: z.string(),
		model: z.string(),
		temperature: z.number(),
		maxTokens: z.number(),
		seed: z.number().nullable(),
		structured: z.enum(["auto", "json_schema", "prompt"]),
		extra: z.record(z.string(), JsonValueSchema).optional(),
		tags: z.record(z.string(), z.string()),
		preview: z.string(),
	}),
	response: z.object({
		text: z.string(),
		usage: z.object({
			promptTokens: z.number(),
			completionTokens: z.number(),
			cachedTokens: z.number(),
		}),
		model: z.string(),
		latencyMs: z.number(),
		structured: z.enum(["json_schema", "prompt"]).optional(),
		finishReason: z.string().optional(),
	}),
});

type Recording = z.output<typeof RecordingSchema>;

type Outcome =
	| { readonly kind: "ok"; readonly body: unknown; readonly latencyMs: number }
	| { readonly kind: "http"; readonly status: number; readonly text: string }
	| { readonly kind: "timeout" }
	| { readonly kind: "network"; readonly message: string };

interface Circuit {
	consecutiveFailures: number;
	open: boolean;
}

interface Attempted {
	readonly text: string;
	readonly usage: LLMResponse["usage"];
	readonly model: string;
	readonly latencyMs: number;
	readonly attempts: number;
	readonly structured?: StructuredMode;
	readonly finishReason?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isTimeout = (e: unknown): boolean =>
	e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

const systemOf = (messages: readonly PromptMessage[]): string =>
	messages.find((m) => m.role === "system")?.content ?? "";

const withSystemSuffix = (
	messages: readonly PromptMessage[],
	suffix: string,
): readonly PromptMessage[] => {
	const index = messages.findIndex((m) => m.role === "system");
	if (index < 0) return [{ role: "system", content: suffix }, ...messages];
	return messages.map((m, i) =>
		i === index ? { role: m.role, content: `${m.content}\n${suffix}` } : m,
	);
};

// The nonce is appended to the system message after promptHash is taken, so identical prompts
// across agents get distinct text (defeating provider-side cache collapse) without changing
// promptHash or the recording key.
// nonce 在计算 promptHash 之后追加到 system 消息末尾，不同 agent 的相同 prompt 因此文本各异
//（避免提供方缓存把它们折叠），而 promptHash 与录制键都不受影响。
const nonceOf = (req: LLMRequest): string | undefined => {
	const id = req.tags.eventId ?? req.tags.requestId;
	return id === undefined ? undefined : `<!-- nonce:${id} -->`;
};

const preview = (messages: readonly PromptMessage[]): string =>
	messages
		.map((m) => m.content)
		.join("\n")
		.slice(0, PREVIEW_CHARS);

class HttpGateway implements Gateway {
	private readonly spec: LLMSpec;
	private readonly logger: Logger;
	private readonly fetchImpl: FetchLike;
	private readonly backoffBaseMs: number;
	private readonly onFailure: ((failure: LLMFailure) => void) | undefined;
	private readonly semaphore: AdaptiveSemaphore;
	private promptFallback = false;
	private started = 0;
	private failed = 0;
	private total: Cost = ZERO_COST;
	private readonly byPurpose = new Map<string, Cost>();

	constructor(spec: LLMSpec, deps: GatewayDeps) {
		if (spec.mode !== "live" && spec.recordDir === undefined)
			throw new TypeError(`llm mode '${spec.mode}' requires recordDir`);
		this.spec = spec;
		this.logger = deps.logger;
		this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
		this.backoffBaseMs = deps.backoffBaseMs ?? 1000;
		this.onFailure = deps.onFailure;
		this.semaphore = new AdaptiveSemaphore(spec.concurrency.initial, spec.concurrency.max);
	}

	complete(req: LLMRequest): Promise<Result<LLMResponse, LLMFailure>> {
		return this.run(req, undefined);
	}

	// Requests are sorted by system prefix so prefix-cached calls run adjacent; results return in
	// request order. The circuit is per batch: once open, the rest of the batch fails at once.
	// 请求按 system 前缀排序，前缀缓存命中的调用相邻发出；结果按请求顺序返回。断路器按批次：
	// 一旦打开，本批余下请求立即失败。
	async completeMany(
		reqs: readonly LLMRequest[],
	): Promise<readonly Result<LLMResponse, LLMFailure>[]> {
		const circuit: Circuit = { consecutiveFailures: 0, open: false };
		const order = reqs
			.map((req, index) => ({ req, index, key: systemOf(req.messages) }))
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
		const results: Result<LLMResponse, LLMFailure>[] = new Array<
			Result<LLMResponse, LLMFailure>
		>(reqs.length);
		await Promise.all(
			order.map(async ({ req, index }) => {
				results[index] = await this.run(req, circuit);
			}),
		);
		return results;
	}

	ledger(): Cost {
		return this.total;
	}

	ledgerByPurpose(): Readonly<Record<string, Cost>> {
		const out: Record<string, Cost> = {};
		for (const [purpose, cost] of this.byPurpose) out[purpose] = cost;
		return out;
	}

	failures(): number {
		return this.failed;
	}

	concurrencyLimit(): number {
		return this.semaphore.currentLimit;
	}

	callsStarted(): number {
		return this.started;
	}

	private async run(
		req: LLMRequest,
		circuit: Circuit | undefined,
	): Promise<Result<LLMResponse, LLMFailure>> {
		const promptHash = hashOf(req.messages);
		const purpose = req.tags.purpose ?? "unknown";
		const startedAt = performance.now();
		// Cost is counted once per outcome, never per attempt, and never for replay hits; a failure
		// adds wall time only. Every failure also reaches onFailure so the kernel records it.
		// 成本按结果计一次，不按尝试次数计，回放命中不计；失败只累加墙钟时间。每个失败同时送到
		// onFailure，由内核记录。
		const settle = (
			r: Result<LLMResponse, LLMFailure>,
			replayed = false,
		): Result<LLMResponse, LLMFailure> => {
			if (!replayed) {
				const wallMs = performance.now() - startedAt;
				const cost: Cost = r.ok
					? { llmCalls: 1, ...r.value.usage, wallMs }
					: { ...ZERO_COST, wallMs };
				this.total = addCost(this.total, cost);
				this.byPurpose.set(
					purpose,
					addCost(this.byPurpose.get(purpose) ?? ZERO_COST, cost),
				);
			}
			if (r.ok) {
				this.logger.debug("llm call", {
					promptHash,
					latencyMs: r.value.latencyMs,
					usage: r.value.usage,
					model: r.value.model,
					recorded: r.value.recorded,
					purpose,
				});
			} else {
				this.failed += 1;
				this.logger.warn("llm call failed", {
					promptHash,
					excType: r.error.excType,
					message: r.error.message,
					retryable: r.error.retryable,
					attempts: r.error.attempts,
					purpose,
				});
				this.onFailure?.(r.error);
			}
			return r;
		};
		const fail = (
			excType: string,
			message: string,
			retryable: boolean,
			attempts: number,
		): Result<LLMResponse, LLMFailure> =>
			settle(err({ promptHash, excType, message, retryable, attempts }));

		this.logger.trace("llm prompt", { promptHash, preview: preview(req.messages) });

		const maxTokens = Math.min(req.maxTokens, this.spec.budget.maxCompletionTokens);
		// Recording key: promptHash, seed and the parameters that change the answer (model,
		// temperature, capped maxTokens, structured mode, extra). Tags and the nonce are excluded.
		// 录制键：promptHash、seed，以及会改变回答的参数（model、temperature、封顶后的 maxTokens、
		// 结构化模式、extra）。tags 与 nonce 不参与。
		const key = hashOf([
			promptHash,
			req.seed ?? null,
			{
				model: this.spec.model,
				temperature: req.temperature,
				maxTokens,
				structured: this.spec.structured,
				...(this.spec.extra === undefined ? {} : { extra: this.spec.extra }),
			},
		]);

		// Replay never touches the network: a miss is a final failure the kernel turns into a
		// fallback decision.
		// 回放从不访问网络：未命中是最终失败，由内核转成回退决策。
		if (this.spec.mode === "replay") {
			const recording = this.readRecording(key);
			if (recording === undefined)
				return fail(
					FAILURE_TYPES.replayMiss,
					`no recording ${key} for prompt ${promptHash}`,
					false,
					0,
				);
			return settle(
				ok(
					this.respond(req, promptHash, {
						text: recording.response.text,
						usage: recording.response.usage,
						model: recording.response.model,
						latencyMs: recording.response.latencyMs,
						recorded: true,
						...(recording.response.structured === undefined
							? {}
							: { structured: recording.response.structured }),
						...(recording.response.finishReason === undefined
							? {}
							: { finishReason: recording.response.finishReason }),
					}),
				),
				true,
			);
		}

		if (circuit?.open === true)
			return fail(FAILURE_TYPES.circuitOpen, "circuit open for this batch", false, 0);

		const attempted = await this.attempt(req, promptHash, maxTokens, circuit);
		if (!attempted.ok) return settle(attempted);
		if (this.spec.mode === "record")
			this.writeRecording(key, req, promptHash, maxTokens, attempted.value);
		return settle(
			ok(
				this.respond(req, promptHash, {
					text: attempted.value.text,
					usage: attempted.value.usage,
					model: attempted.value.model,
					latencyMs: attempted.value.latencyMs,
					recorded: false,
					...(attempted.value.structured === undefined
						? {}
						: { structured: attempted.value.structured }),
					...(attempted.value.finishReason === undefined
						? {}
						: { finishReason: attempted.value.finishReason }),
				}),
			),
		);
	}

	private respond(
		req: LLMRequest,
		promptHash: string,
		body: {
			readonly text: string;
			readonly usage: LLMResponse["usage"];
			readonly model: string;
			readonly latencyMs: number;
			readonly recorded: boolean;
			readonly structured?: StructuredMode;
			readonly finishReason?: string;
		},
	): LLMResponse {
		const parsed = req.schema === undefined ? undefined : extractLastJsonBlock(body.text);
		return {
			text: body.text,
			...(parsed !== undefined && parsed.ok ? { parsed: parsed.value } : {}),
			usage: body.usage,
			latencyMs: body.latencyMs,
			model: body.model,
			promptHash,
			responseSha: sha256Hex(body.text),
			recorded: body.recorded,
			...(body.structured === undefined ? {} : { structured: body.structured }),
			...(body.finishReason === undefined ? {} : { finishReason: body.finishReason }),
		};
	}

	// auto starts with json_schema and flips to prompt for the rest of the run after one 400;
	// the flip is gateway-wide because the endpoint, not the request, rejected the mode.
	// auto 先用 json_schema，遇到一次 400 后本 run 余下全部改用 prompt；切换作用于整个网关，
	// 因为拒绝该模式的是端点而不是某个请求。
	private usePromptMode(req: LLMRequest): boolean {
		if (req.schema === undefined) return false;
		if (this.spec.structured === "prompt") return true;
		if (this.spec.structured === "json_schema") return false;
		return this.promptFallback;
	}

	private buildMessages(req: LLMRequest, promptMode: boolean): readonly PromptMessage[] {
		let messages = req.messages;
		if (promptMode && req.schema !== undefined)
			messages = withSystemSuffix(messages, schemaInstruction(req.schema));
		if (req.homogeneousGuard) {
			const nonce = nonceOf(req);
			if (nonce !== undefined) messages = withSystemSuffix(messages, nonce);
		}
		return messages;
	}

	// extra is merged first so the gateway-owned keys always win; seed is sent only when the
	// spec allows it, since some local servers reject the field.
	// extra 先合并，网关自有的键始终覆盖它；seed 只在规格允许时发送，部分本地服务会拒绝该字段。
	private buildBody(req: LLMRequest, maxTokens: number, promptMode: boolean): JsonObject {
		const body: Record<string, JsonValue> = {};
		for (const [key, value] of Object.entries(this.spec.extra ?? {}))
			if (!RESERVED_BODY_KEYS.has(key)) body[key] = value;
		Object.assign(body, {
			model: this.spec.model,
			messages: this.buildMessages(req, promptMode).map((m) => ({
				role: m.role,
				content: m.content,
			})),
			temperature: req.temperature,
			max_tokens: maxTokens,
		});
		if (req.seed !== undefined && this.spec.sendSeed) body.seed = req.seed;
		if (req.schema !== undefined && !promptMode)
			body.response_format = {
				type: "json_schema",
				json_schema: { name: "decision", schema: req.schema, strict: true },
			};
		return body;
	}

	private async send(body: JsonObject): Promise<Outcome> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		const key = process.env[this.spec.apiKeyEnv];
		if (key !== undefined && key.length > 0) headers.authorization = `Bearer ${key}`;
		const started = performance.now();
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.spec.baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.spec.timeoutMs),
			});
		} catch (e) {
			if (isTimeout(e)) return { kind: "timeout" };
			return { kind: "network", message: e instanceof Error ? e.message : String(e) };
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return { kind: "http", status: response.status, text };
		}
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch (e) {
			return { kind: "network", message: e instanceof Error ? e.message : String(e) };
		}
		return { kind: "ok", body: parsed, latencyMs: performance.now() - started };
	}

	// The circuit counts final failures after retries; once open, every remaining request in
	// the batch fails immediately with CircuitOpen.
	// 断路器统计重试耗尽后的最终失败；一旦打开，本批余下请求立即以 CircuitOpen 失败。
	private async attempt(
		req: LLMRequest,
		promptHash: string,
		maxTokens: number,
		circuit: Circuit | undefined,
	): Promise<Result<Attempted, LLMFailure>> {
		const finalFailure = (
			failure: Pick<LLMFailure, "excType" | "message" | "retryable">,
			attempts: number,
		): Result<Attempted, LLMFailure> => {
			if (circuit !== undefined) {
				circuit.consecutiveFailures += 1;
				if (circuit.consecutiveFailures >= CIRCUIT_THRESHOLD) circuit.open = true;
			}
			return err({ promptHash, ...failure, attempts });
		};
		let attempts = 0;
		let sent = false;
		for (;;) {
			attempts += 1;
			const promptMode = this.usePromptMode(req);
			const body = this.buildBody(req, maxTokens, promptMode);
			await this.semaphore.acquire();
			try {
				if (circuit?.open === true)
					return err({
						promptHash,
						excType: FAILURE_TYPES.circuitOpen,
						message: "circuit open for this batch",
						retryable: false,
						attempts: attempts - 1,
					});
				// The budget counts started network calls once per request: retries of the same
				// request do not consume it, and the check runs under the semaphore so concurrent
				// requests cannot overshoot maxCalls.
				// 预算按请求计一次已发起的网络调用：同一请求的重试不再消耗，且检查在信号量内进行，
				// 并发请求不会超出 maxCalls。
				if (!sent) {
					if (this.started >= this.spec.budget.maxCalls)
						return err({
							promptHash,
							excType: FAILURE_TYPES.budgetExhausted,
							message: `budget of ${this.spec.budget.maxCalls} calls exhausted`,
							retryable: false,
							attempts: 0,
						});
					this.started += 1;
					sent = true;
				}
				const outcome = await this.send(body);

				if (outcome.kind === "ok") {
					const completion = CompletionSchema.safeParse(outcome.body);
					const choice = completion.success ? completion.data.choices[0] : undefined;
					const content = choice?.message.content;
					const finishReason = choice?.finish_reason ?? undefined;
					const reasoning = choice?.message.reasoning_content ?? "";
					const empty = typeof content !== "string" || content.trim().length === 0;
					const completionTokens = completion.success
						? (completion.data.usage?.completion_tokens ?? 0)
						: 0;
					// Empty content with finish_reason length means the token budget went to
					// reasoning; empty content beside reasoning_content means the model answered
					// only in the reasoning channel. Both are final; the message names the knob.
					// content 为空且 finish_reason 为 length，说明 token 预算被推理耗尽；content 为空但有
					// reasoning_content，说明模型只在推理通道作答。两者都是最终失败，消息指明该调哪个开关。
					if (completion.success && empty && finishReason === FINISH_LENGTH)
						return finalFailure(
							{
								excType: FAILURE_TYPES.truncated,
								message: `empty content with finish_reason=length after ${completionTokens} completion tokens; raise budget.maxCompletionTokens or disable reasoning via llm.extra`,
								retryable: false,
							},
							attempts,
						);
					if (completion.success && empty && reasoning.length > 0)
						return finalFailure(
							{
								excType: FAILURE_TYPES.emptyContent,
								message: `empty content beside ${reasoning.length} characters of reasoning_content; disable reasoning via llm.extra`,
								retryable: false,
							},
							attempts,
						);
					if (!completion.success || typeof content !== "string")
						return finalFailure(
							{
								excType: FAILURE_TYPES.malformed,
								message: "response has no choices[0].message.content",
								retryable: false,
							},
							attempts,
						);
					this.semaphore.succeed();
					if (circuit !== undefined) circuit.consecutiveFailures = 0;
					const usage = completion.data.usage;
					return ok({
						text: content,
						usage: {
							promptTokens: usage?.prompt_tokens ?? 0,
							completionTokens: usage?.completion_tokens ?? 0,
							cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
						},
						model: completion.data.model ?? this.spec.model,
						latencyMs: outcome.latencyMs,
						attempts,
						...(req.schema === undefined
							? {}
							: { structured: promptMode ? "prompt" : "json_schema" }),
						...(finishReason === undefined ? {} : { finishReason }),
					});
				}

				if (
					outcome.kind === "http" &&
					outcome.status === 400 &&
					!promptMode &&
					req.schema !== undefined &&
					this.spec.structured === "auto"
				) {
					// The structured fallback attempt does not count as a retry, and its failure
					// event is recorded once per gateway rather than once per request.
					// 结构化回退的那次尝试不计入重试次数，其 failure 事件按网关只记一次，而不是每个请求一次。
					if (!this.promptFallback) {
						this.promptFallback = true;
						const failure: LLMFailure = {
							promptHash,
							excType: FAILURE_TYPES.structuredFallback,
							message: `json_schema rejected with 400, switching to prompt mode: ${outcome.text.slice(0, PREVIEW_CHARS)}`,
							retryable: true,
							attempts,
						};
						this.logger.error("structured output fallback", {
							promptHash,
							message: failure.message,
						});
						this.onFailure?.(failure);
					}
					attempts -= 1;
					continue;
				}

				// 429 and timeouts shrink the concurrency window before the retry decision; the
				// backoff sleeps outside the semaphore so the slot stays free for other requests.
				// 429 与超时在决定重试之前先收缩并发窗口；退避等待在信号量之外进行，槽位留给其它请求。
				const classified = classify(outcome);
				if (
					outcome.kind === "timeout" ||
					(outcome.kind === "http" && outcome.status === 429)
				)
					this.semaphore.halve();
				if (!classified.retryable || attempts > MAX_RETRIES)
					return finalFailure(classified, attempts);
				this.logger.warn("llm call retry", {
					promptHash,
					excType: classified.excType,
					attempt: attempts,
				});
			} finally {
				this.semaphore.release();
			}
			await sleep(
				Math.min(
					this.backoffBaseMs * 2 ** (attempts - 1),
					this.backoffBaseMs * BACKOFF_CAP_MULTIPLIER,
				),
			);
		}
	}

	private recordingPath(key: string): string {
		return join(this.spec.recordDir ?? "", `${key}.json`);
	}

	private readRecording(key: string): Recording | undefined {
		const path = this.recordingPath(key);
		if (!existsSync(path)) return undefined;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			this.logger.warn("unreadable recording", {
				path,
				error: e instanceof Error ? e.message : String(e),
			});
			return undefined;
		}
		const parsed = RecordingSchema.safeParse(raw);
		if (!parsed.success) {
			this.logger.warn("malformed recording", { path });
			return undefined;
		}
		return parsed.data;
	}

	private writeRecording(
		key: string,
		req: LLMRequest,
		promptHash: string,
		maxTokens: number,
		attempted: Attempted,
	): void {
		const recording: Recording = {
			version: 1,
			key,
			request: {
				promptHash,
				model: this.spec.model,
				temperature: req.temperature,
				maxTokens,
				seed: req.seed ?? null,
				structured: this.spec.structured,
				...(this.spec.extra === undefined ? {} : { extra: this.spec.extra }),
				tags: { ...req.tags },
				preview: preview(req.messages),
			},
			response: {
				text: attempted.text,
				usage: attempted.usage,
				model: attempted.model,
				latencyMs: attempted.latencyMs,
				...(attempted.structured === undefined ? {} : { structured: attempted.structured }),
				...(attempted.finishReason === undefined
					? {}
					: { finishReason: attempted.finishReason }),
			},
		};
		const dir = this.spec.recordDir ?? "";
		mkdirSync(dir, { recursive: true });
		writeFileSync(this.recordingPath(key), JSON.stringify(recording, null, "\t"));
	}
}

// 429 and 5xx are retryable, other 4xx are final; timeouts and network errors retry.
// 429 与 5xx 可重试，其它 4xx 为最终失败；超时与网络错误可重试。
const classify = (
	outcome: Exclude<Outcome, { readonly kind: "ok" }>,
): Pick<LLMFailure, "excType" | "message" | "retryable"> => {
	switch (outcome.kind) {
		case "timeout":
			return {
				excType: FAILURE_TYPES.timeout,
				message: "request timed out",
				retryable: true,
			};
		case "network":
			return { excType: FAILURE_TYPES.network, message: outcome.message, retryable: true };
		case "http": {
			const message = `HTTP ${outcome.status}: ${outcome.text.slice(0, PREVIEW_CHARS)}`;
			if (outcome.status === 429)
				return { excType: FAILURE_TYPES.rateLimited, message, retryable: true };
			if (outcome.status >= 500)
				return { excType: FAILURE_TYPES.serverError, message, retryable: true };
			return { excType: FAILURE_TYPES.clientError, message, retryable: false };
		}
	}
};

export const createGateway = (spec: LLMSpec, deps: GatewayDeps): Gateway =>
	new HttpGateway(spec, deps);
