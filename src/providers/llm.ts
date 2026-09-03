// LLM provider: one gateway call per request, batched through completeMany; the structured
// reply is validated as {action, args, rationale} and must name an action in the request's
// action space. Every response, parseable or not, is recorded as an llm_call event.
// LLM 提供者：每条请求一次网关调用，经 completeMany 批发；结构化回复按 {action, args, rationale}
// 校验，动作必须在请求的动作空间内。无论能否解析，每次响应都记一条 llm_call 事件。

import { z } from "zod";
import { makeEvent } from "../core/events";
import { FAILURE_TYPES } from "../core/failures";
import { newEventId } from "../core/ids";
import { decisionSchema } from "../core/prompt";
import type { DecisionProvider, LLMGateway, LLMRequest, LLMResponse } from "../core/protocols";
import { err, ok } from "../core/result";
import { keyFromLabel, rngFromSeed } from "../core/rng";
import { JsonValueSchema } from "../core/schema";
import type {
	Decision,
	DecisionRequest,
	EventId,
	JsonValue,
	ProviderFailure,
	Result,
	RoundContext,
} from "../core/types";
import type { Logger } from "../logging/logger";
import { readSeedPathState, seedPathState } from "./state";

export interface LlmProviderOptions {
	readonly name: string;
	readonly seed: number;
	readonly temperature: number;
	readonly maxTokens: number;
	readonly homogeneousGuard: boolean;
	readonly purpose: string;
}

export interface LlmProviderDeps {
	readonly gateway?: LLMGateway;
	readonly logger: Logger;
}

const DecisionOutputSchema = z.object({
	action: z.string(),
	args: z.record(z.string(), JsonValueSchema).default({}),
	rationale: z.string().optional(),
});

const NO_PROMPT: Omit<ProviderFailure, "agentId"> = {
	reason: "request carries no rendered prompt",
	retryable: false,
	excType: FAILURE_TYPES.noPrompt,
};

const NO_GATEWAY: Omit<ProviderFailure, "agentId"> = {
	reason: "gateway_missing",
	retryable: false,
	excType: FAILURE_TYPES.gatewayMissing,
};

class LlmProvider implements DecisionProvider {
	readonly name: string;
	private readonly options: LlmProviderOptions;
	private readonly gateway: LLMGateway | undefined;
	private readonly logger: Logger;
	private seedPath: readonly number[] = [];

	constructor(options: LlmProviderOptions, deps: LlmProviderDeps) {
		this.name = options.name;
		this.options = options;
		this.gateway = deps.gateway;
		this.logger = deps.logger.child({ component: `provider:${options.name}` });
	}

	// Requests without a rendered prompt never reach the gateway and fail as noPrompt. llm_call
	// event ids come from an rng derived from the round seed path and provider name, drawn in
	// request order, so they are identical on replay whatever the gateway's timing.
	// 没有渲染 prompt 的请求不会到达网关，直接记 noPrompt 失败。llm_call 事件 id 由本轮种子路径
	// 与提供者名派生的 rng 按请求顺序抽取，回放时与网关时序无关。
	async decide(
		requests: readonly DecisionRequest[],
		ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]> {
		const gateway = this.gateway;
		if (gateway === undefined)
			return requests.map((req) => err({ agentId: req.agentId, ...NO_GATEWAY }));
		const indexed = requests.flatMap((req, index) =>
			req.prompt === undefined ? [] : [{ req, index, llm: this.toLlmRequest(req, ctx) }],
		);
		const responses = await gateway.completeMany(indexed.map((x) => x.llm));
		const eventRng = rngFromSeed(this.options.seed, [
			...ctx.seedPath,
			keyFromLabel(`provider:${this.name}`),
		]);
		const results: Result<Decision, ProviderFailure>[] = requests.map((req) =>
			err({ agentId: req.agentId, ...NO_PROMPT }),
		);
		indexed.forEach(({ req, index }, k) => {
			const response = responses[k];
			if (response === undefined) return;
			results[index] = response.ok
				? this.interpret(req, response.value, ctx, newEventId(eventRng))
				: err({
						agentId: req.agentId,
						reason: response.error.message,
						retryable: response.error.retryable,
						excType: response.error.excType,
					});
		});
		return results;
	}

	reset(seedPath: readonly number[]): void {
		this.seedPath = [...seedPath];
	}

	getState(): JsonValue {
		return seedPathState(this.seedPath);
	}

	setState(s: JsonValue): void {
		const seedPath = readSeedPathState(s);
		if (seedPath !== undefined) this.seedPath = seedPath;
	}

	// tags.eventId is the observation event: the gateway turns it into the homogeneous-guard nonce
	// so identical prompts from different agents cannot collide in a prefix cache.
	// tags.eventId 是观察事件 id：网关把它变成同质守卫的 nonce，
	// 不同 agent 的相同 prompt 不会在前缀缓存里撞车。
	private toLlmRequest(req: DecisionRequest, ctx: RoundContext): LLMRequest {
		const prompt = req.prompt;
		return {
			messages: prompt?.messages ?? [],
			schema: prompt?.schema ?? decisionSchema(req.actionSpace),
			temperature: this.options.temperature,
			maxTokens: this.options.maxTokens,
			seed: this.options.seed,
			tags: {
				purpose: this.options.purpose,
				eventId: req.observationEvent,
				agentId: req.agentId,
				tick: String(ctx.t.tick),
			},
			homogeneousGuard: this.options.homogeneousGuard,
		};
	}

	// The llm_call event is appended before parsing so an unparseable reply still leaves its cost
	// and response hash in the log; the decision links back to it through llmEvent.
	// llm_call 事件在解析之前落日志，无法解析的回复也留下成本与响应哈希；
	// 决策通过 llmEvent 回链到它。
	private interpret(
		req: DecisionRequest,
		response: LLMResponse,
		ctx: RoundContext,
		eventId: EventId,
	): Result<Decision, ProviderFailure> {
		ctx.log.putContent(response.text);
		ctx.log.append(
			makeEvent(
				{
					eventId,
					runId: ctx.runId,
					t: ctx.t,
					seedPath: ctx.seedPath,
					agentId: req.agentId,
					parent: req.observationEvent,
					provenance: "llm",
				},
				{
					kind: "llm_call",
					payload: {
						promptHash: response.promptHash,
						responseSha: response.responseSha,
						model: response.model,
						params: {
							temperature: this.options.temperature,
							maxTokens: this.options.maxTokens,
							seed: this.options.seed,
							structured: response.structured ?? null,
						},
						usage: response.usage,
						latencyMs: response.latencyMs,
						recorded: response.recorded,
					},
				},
			),
		);
		const parsed =
			response.parsed === undefined
				? undefined
				: DecisionOutputSchema.safeParse(response.parsed);
		if (parsed === undefined || !parsed.success) {
			this.logger.debug("unparseable decision", {
				agentId: req.agentId,
				responseSha: response.responseSha,
			});
			return err({
				agentId: req.agentId,
				reason:
					parsed === undefined
						? "response contains no JSON object"
						: `decision does not match schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
				retryable: false,
				excType: FAILURE_TYPES.parseFailure,
			});
		}
		if (!req.actionSpace.includes(parsed.data.action))
			return err({
				agentId: req.agentId,
				reason: `action '${parsed.data.action}' is not in the action space`,
				retryable: false,
				excType: FAILURE_TYPES.invalidAction,
			});
		return ok({
			agentId: req.agentId,
			action: parsed.data.action,
			args: parsed.data.args,
			...(parsed.data.rationale === undefined ? {} : { rationale: parsed.data.rationale }),
			provenance: "llm",
			cost: { llmCalls: 1, ...response.usage, wallMs: response.latencyMs },
			parseOk: true,
			llmEvent: eventId,
		});
	}
}

export const createLlmProvider = (
	options: LlmProviderOptions,
	deps: LlmProviderDeps,
): DecisionProvider => new LlmProvider(options, deps);
