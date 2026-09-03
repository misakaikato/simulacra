// Archetype provider: groups requests by the values of the `groupOn` persona columns, sends one
// synthetic representative per group (nArch times) to the downstream and broadcasts the majority
// action to every member; the per-prototype votes become the `soft` distribution.
// 原型提供者：按 `groupOn` 人设列的取值组合分组，每组合成一个代表请求（重复 nArch 次）
// 交给下游，多数动作广播给全体成员；各次原型的投票构成 `soft` 分布。

import { z } from "zod";
import { makeEvent } from "../core/events";
import { FAILURE_TYPES } from "../core/failures";
import { canonicalJson } from "../core/hash";
import { newEventId } from "../core/ids";
import { PERSONA_PREFIX } from "../core/population";
import type { DecisionProvider, Rng } from "../core/protocols";
import { err, ok } from "../core/result";
import { keyFromLabel, rngFromSeed } from "../core/rng";
import type {
	Cost,
	Decision,
	DecisionRequest,
	EventId,
	JsonObject,
	JsonValue,
	ProviderFailure,
	Result,
	RoundContext,
} from "../core/types";
import type { Logger } from "../logging/logger";

export const ARCHETYPE_KIND = "archetype";
export const GROUP_SIZE_KEY = "groupSize";

export const ArchetypeOptionsSchema = z.object({
	downstream: z.string().min(1),
	groupOn: z.array(z.string().min(1)).min(1),
	nArch: z.number().int().positive().default(1),
});

export interface ArchetypeProviderOptions {
	readonly name: string;
	readonly seed: number;
	readonly groupOn: readonly string[];
	readonly nArch: number;
	readonly privateFields: readonly string[];
}

export interface ArchetypeReport {
	readonly disagreementRate: number;
	readonly groups: number;
	readonly calls: number;
}

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const StateSchema = z.object({ seedPath: z.array(z.number()), calls: z.number().int() });

interface Group {
	readonly key: string;
	readonly members: readonly DecisionRequest[];
}

// Groups are keyed by the canonical JSON of the groupOn values and sorted by key, so group
// order (and therefore rng consumption) is independent of request order. One request missing a
// column rejects the whole batch: silently mixing grouped and ungrouped agents would bias the
// broadcast.
// 组键是 groupOn 取值的规范化 JSON，并按键排序，分组顺序（进而随机数消耗）与请求顺序无关。
// 任一请求缺列则整批拒绝：悄悄混合分组与未分组的 agent 会让广播产生偏差。
export const groupRequests = (
	requests: readonly DecisionRequest[],
	groupOn: readonly string[],
): Result<readonly Group[], readonly ProviderFailure[]> => {
	const groups = new Map<string, DecisionRequest[]>();
	const failures: ProviderFailure[] = [];
	for (const req of requests) {
		const missing = groupOn.filter((column) => req.state[column] === undefined);
		if (missing.length > 0) {
			failures.push({
				agentId: req.agentId,
				reason: `groupOn column(s) missing from state: ${missing.join(", ")}`,
				retryable: false,
				excType: FAILURE_TYPES.missingColumn,
			});
			continue;
		}
		const key = canonicalJson(groupOn.map((column) => req.state[column]));
		const members = groups.get(key);
		if (members === undefined) groups.set(key, [req]);
		else members.push(req);
	}
	if (failures.length > 0) return err(failures);
	return ok(
		[...groups.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, members]) => ({ key, members })),
	);
};

export const publicPersonaOf = (
	state: JsonObject,
	privateFields: ReadonlySet<string>,
): JsonObject => {
	const out: Record<string, JsonValue> = {};
	for (const [k, v] of Object.entries(state))
		if (k.startsWith(PERSONA_PREFIX) && !privateFields.has(k)) out[k] = v;
	return out;
};

// Numbers average, booleans take the majority, everything else keeps the first member's value.
// 数值取平均，布尔取多数，其余保留首个成员的值。
export const aggregateObservations = (observations: readonly JsonObject[]): JsonObject => {
	const first = observations[0];
	if (first === undefined) return {};
	const out: Record<string, JsonValue> = {};
	for (const key of Object.keys(first)) {
		const values = observations.map((o) => o[key]);
		if (values.every((v) => typeof v === "number"))
			out[key] = values.reduce((a, b) => a + b, 0) / values.length;
		else if (values.every((v) => typeof v === "boolean"))
			out[key] = values.filter((v) => v).length * 2 > values.length;
		else out[key] = first[key] ?? null;
	}
	return out;
};

const summedCost = (costs: readonly Cost[]): Cost =>
	costs.reduce(
		(acc, c) => ({
			llmCalls: acc.llmCalls + c.llmCalls,
			promptTokens: acc.promptTokens + c.promptTokens,
			completionTokens: acc.completionTokens + c.completionTokens,
			cachedTokens: acc.cachedTokens + c.cachedTokens,
			wallMs: acc.wallMs + c.wallMs,
		}),
		ZERO_COST,
	);

export interface Vote {
	readonly action: string;
	readonly soft: Readonly<Record<string, number>>;
	readonly agreement: number;
}

// Majority action over the prototype decisions; ties break on the action name.
// 原型决策的多数动作；平票按动作名裁决。
export const majorityVote = (decisions: readonly Decision[]): Vote | undefined => {
	if (decisions.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const d of decisions) counts.set(d.action, (counts.get(d.action) ?? 0) + 1);
	const ranked = [...counts.entries()].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : 1));
	const [action, count] = ranked[0] ?? ["", 0];
	const soft: Record<string, number> = {};
	for (const [name, n] of ranked) soft[name] = n / decisions.length;
	return { action, soft, agreement: count / decisions.length };
};

class ArchetypeDecisionProvider implements DecisionProvider {
	readonly name: string;
	private readonly options: ArchetypeProviderOptions;
	private readonly downstream: DecisionProvider;
	private readonly privateFields: ReadonlySet<string>;
	private readonly logger: Logger;
	private seedPath: readonly number[] = [];
	private calls = 0;
	private lastRound: { readonly groups: number; readonly disagreementRate: number } = {
		groups: 0,
		disagreementRate: 0,
	};

	constructor(options: ArchetypeProviderOptions, downstream: DecisionProvider, logger: Logger) {
		this.name = options.name;
		this.options = options;
		this.downstream = downstream;
		this.privateFields = new Set(options.privateFields.map((f) => `${PERSONA_PREFIX}${f}`));
		this.logger = logger.child({ component: `provider:${options.name}` });
	}

	// Each of the nArch passes gets its own seed path suffix so downstream randomness differs per
	// prototype; downstream cost is charged to the group's first member only (appendix H).
	// nArch 次调用各带自己的种子路径后缀，下游随机性逐原型不同；
	// 下游成本只记在组内首个成员上（附录 H）。
	async decide(
		requests: readonly DecisionRequest[],
		ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]> {
		const grouped = groupRequests(requests, this.options.groupOn);
		if (!grouped.ok) {
			const byAgent = new Map(grouped.error.map((f) => [f.agentId, f] as const));
			return requests.map((req) => {
				const failure = byAgent.get(req.agentId);
				return failure === undefined
					? err({
							agentId: req.agentId,
							reason: "batch rejected: another request lacks the groupOn columns",
							retryable: false,
							excType: FAILURE_TYPES.missingColumn,
						})
					: err(failure);
			});
		}
		const groups = grouped.value;
		const eventRng = rngFromSeed(this.options.seed, [
			...ctx.seedPath,
			keyFromLabel(`archetype:${this.name}`),
		]);
		const perGroup: Result<Decision, ProviderFailure>[][] = groups.map(() => []);
		for (let k = 0; k < this.options.nArch; k += 1) {
			const representatives = groups.map((g) => this.representative(g, k, ctx, eventRng));
			const results = await this.downstream.decide(representatives, {
				...ctx,
				seedPath: [...ctx.seedPath, keyFromLabel(`archetype:${this.name}:${k}`)],
			});
			this.calls += representatives.length;
			for (const [i, result] of results.entries()) perGroup[i]?.push(result);
		}
		const byAgent = new Map<string, Result<Decision, ProviderFailure>>();
		let disagreement = 0;
		for (const [i, group] of groups.entries()) {
			const results = perGroup[i] ?? [];
			const okDecisions = results.flatMap((r) => (r.ok ? [r.value] : []));
			const vote = majorityVote(okDecisions);
			if (vote === undefined) {
				const first = results.find((r) => !r.ok);
				const failure: Omit<ProviderFailure, "agentId"> =
					first !== undefined && !first.ok
						? first.error
						: { reason: "downstream returned no result", retryable: false };
				for (const member of group.members)
					byAgent.set(member.agentId, err({ ...failure, agentId: member.agentId }));
				continue;
			}
			disagreement += 1 - vote.agreement;
			const chosen = okDecisions.find((d) => d.action === vote.action) ?? okDecisions[0];
			if (chosen === undefined) continue;
			const cost = summedCost(okDecisions.map((d) => d.cost));
			group.members.forEach((member, index) => {
				byAgent.set(
					member.agentId,
					ok({
						agentId: member.agentId,
						action: vote.action,
						args: chosen.args,
						soft: vote.soft,
						...(chosen.rationale === undefined ? {} : { rationale: chosen.rationale }),
						provenance: "prototype",
						cost: index === 0 ? cost : ZERO_COST,
						parseOk: true,
						...(chosen.llmEvent === undefined ? {} : { llmEvent: chosen.llmEvent }),
					}),
				);
			});
		}
		this.lastRound = {
			groups: groups.length,
			disagreementRate: groups.length === 0 ? 0 : disagreement / groups.length,
		};
		this.logger.debug("archetype round", {
			groups: groups.length,
			nArch: this.options.nArch,
			disagreementRate: this.lastRound.disagreementRate,
		});
		return requests.map(
			(req) =>
				byAgent.get(req.agentId) ??
				err({
					agentId: req.agentId,
					reason: "no decision for agent",
					retryable: false,
					excType: FAILURE_TYPES.providerContractViolation,
				}),
		);
	}

	audit(): Readonly<Record<string, number>> {
		return {
			disagreementRate: this.lastRound.disagreementRate,
			groups: this.lastRound.groups,
			calls: this.calls,
		};
	}

	report(): ArchetypeReport {
		return { ...this.lastRound, calls: this.calls };
	}

	reset(seedPath: readonly number[]): void {
		this.seedPath = [...seedPath];
		this.calls = 0;
	}

	getState(): JsonValue {
		return { seedPath: [...this.seedPath], calls: this.calls };
	}

	setState(s: JsonValue): void {
		const parsed = StateSchema.safeParse(s);
		if (!parsed.success) return;
		this.seedPath = parsed.data.seedPath;
		this.calls = parsed.data.calls;
	}

	// One synthetic request stands for the whole group; its observation event links back to
	// every member observation and gives each prototype call its own nonce.
	// 一个合成请求代表整个组；其观察事件回链到每个成员的观察，并给每次原型调用独立的 nonce。
	private representative(group: Group, k: number, ctx: RoundContext, rng: Rng): DecisionRequest {
		const first = group.members[0];
		if (first === undefined) throw new RangeError("empty archetype group");
		const state: JsonObject = {
			...publicPersonaOf(first.state, this.privateFields),
			[GROUP_SIZE_KEY]: group.members.length,
		};
		const observation: JsonObject = {
			...aggregateObservations(group.members.map((m) => m.observation)),
			[GROUP_SIZE_KEY]: group.members.length,
		};
		const contentSha = ctx.log.putContent(
			JSON.stringify({ group: group.key, prototype: k, state, observation }),
		);
		const eventId: EventId = newEventId(rng);
		ctx.log.append(
			makeEvent(
				{
					eventId,
					runId: ctx.runId,
					t: ctx.t,
					seedPath: ctx.seedPath,
					parent: first.observationEvent,
					provenance: "prototype",
				},
				{
					kind: "observation",
					payload: {
						contentSha,
						refs: group.members.map((m) => m.observationEvent),
						truncated: false,
						...(first.prompt === undefined ? {} : { promptHash: first.prompt.hash }),
					},
				},
			),
		);
		return {
			agentId: first.agentId,
			t: ctx.t,
			state,
			observation,
			observationEvent: eventId,
			...(first.features === undefined ? {} : { features: first.features }),
			actionSpace: first.actionSpace,
			...(first.prompt === undefined ? {} : { prompt: first.prompt }),
		};
	}
}

export interface ArchetypeProvider extends DecisionProvider {
	report(): ArchetypeReport;
}

export const createArchetypeProvider = (
	options: ArchetypeProviderOptions,
	downstream: DecisionProvider,
	logger: Logger,
): ArchetypeProvider => new ArchetypeDecisionProvider(options, downstream, logger);
