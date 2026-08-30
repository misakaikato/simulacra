import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hashOf, sha256Hex } from "../core/hash";
import type { LLMFailure, LLMGateway, LLMRequest, LLMResponse } from "../core/protocols";
import { err, ok } from "../core/result";
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

export const FAILURE_TYPES = {
	budgetExhausted: "budget_exhausted",
	structuredFallback: "structured_fallback",
	replayMiss: "ReplayMiss",
	circuitOpen: "CircuitOpen",
	rateLimited: "RateLimited",
	serverError: "ServerError",
	clientError: "ClientError",
	timeout: "Timeout",
	network: "NetworkError",
	malformed: "MalformedResponse",
} as const;

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

const CompletionSchema = z.object({
	model: z.string().optional(),
	choices: z
		.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
		.min(1),
	usage: UsageSchema,
});

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
		const settle = (r: Result<LLMResponse, LLMFailure>): Result<LLMResponse, LLMFailure> => {
			const wallMs = performance.now() - startedAt;
			const cost: Cost = r.ok
				? { llmCalls: 1, ...r.value.usage, wallMs }
				: { ...ZERO_COST, wallMs };
			this.total = addCost(this.total, cost);
			this.byPurpose.set(purpose, addCost(this.byPurpose.get(purpose) ?? ZERO_COST, cost));
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

		if (this.started >= this.spec.budget.maxCalls)
			return fail(
				FAILURE_TYPES.budgetExhausted,
				`budget of ${this.spec.budget.maxCalls} calls exhausted`,
				false,
				0,
			);
		this.started += 1;
		this.logger.trace("llm prompt", { promptHash, preview: preview(req.messages) });

		const maxTokens = Math.min(req.maxTokens, this.spec.budget.maxCompletionTokens);
		const key = hashOf([
			promptHash,
			req.seed ?? null,
			{
				model: this.spec.model,
				temperature: req.temperature,
				maxTokens,
				structured: this.spec.structured,
			},
		]);

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
					}),
				),
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
		};
	}

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

	private buildBody(req: LLMRequest, maxTokens: number, promptMode: boolean): JsonObject {
		const body: Record<string, JsonValue> = {
			model: this.spec.model,
			messages: this.buildMessages(req, promptMode).map((m) => ({
				role: m.role,
				content: m.content,
			})),
			temperature: req.temperature,
			max_tokens: maxTokens,
		};
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
				const outcome = await this.send(body);

				if (outcome.kind === "ok") {
					const completion = CompletionSchema.safeParse(outcome.body);
					const content = completion.success
						? completion.data.choices[0]?.message.content
						: undefined;
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
					});
				}

				if (
					outcome.kind === "http" &&
					outcome.status === 400 &&
					!promptMode &&
					req.schema !== undefined &&
					this.spec.structured === "auto"
				) {
					if (!this.promptFallback) {
						this.promptFallback = true;
						const failure: LLMFailure = {
							promptHash,
							excType: FAILURE_TYPES.structuredFallback,
							message: `json_schema rejected with 400, switching to prompt mode: ${outcome.text.slice(0, PREVIEW_CHARS)}`,
							retryable: true,
							attempts,
						};
						this.logger.warn("structured output fallback", {
							promptHash,
							message: failure.message,
						});
						this.onFailure?.(failure);
					}
					attempts -= 1;
					continue;
				}

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
				tags: { ...req.tags },
				preview: preview(req.messages),
			},
			response: {
				text: attempted.text,
				usage: attempted.usage,
				model: attempted.model,
				latencyMs: attempted.latencyMs,
			},
		};
		const dir = this.spec.recordDir ?? "";
		mkdirSync(dir, { recursive: true });
		writeFileSync(this.recordingPath(key), JSON.stringify(recording, null, "\t"));
	}
}

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
