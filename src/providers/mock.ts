import { zodToJsonSchema } from "../core/actions";
import { FAILURE_TYPES } from "../core/failures";
import { canonicalJson, hashOf } from "../core/hash";
import type { ActionRegistry, DecisionProvider } from "../core/protocols";
import { ANSWERS_ARG, ANSWER_ACTION, questionsOf } from "../core/questionnaire";
import { err, ok } from "../core/result";
import type {
	Cost,
	Decision,
	DecisionRequest,
	JsonObject,
	JsonValue,
	ProviderFailure,
	Result,
	RoundContext,
} from "../core/types";

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

export const ID_PLACEHOLDER = "...";
const ID_SUFFIX = "Id";
const TARGET_FIELD = "target";
const MOCK_INTEGER_RANGE = 11;
const TWO_POW_32 = 4294967296;

const isObject = (v: JsonValue | undefined): v is JsonObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const exampleFromJsonSchema = (schema: JsonValue): JsonValue => {
	if (!isObject(schema)) return null;
	if ("const" in schema) return schema.const ?? null;
	const options = schema.enum;
	if (Array.isArray(options)) return options[0] ?? null;
	switch (schema.type) {
		case "object": {
			const properties = schema.properties;
			const required = schema.required;
			const out: Record<string, JsonValue> = {};
			if (isObject(properties) && Array.isArray(required)) {
				for (const key of required) {
					if (typeof key !== "string") continue;
					const property: JsonValue = properties[key] ?? null;
					out[key] = exampleFromJsonSchema(property);
				}
			}
			return out;
		}
		case "string":
			return ID_PLACEHOLDER;
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		case "array":
			return [];
		default:
			return null;
	}
};

// Id-typed parameters are filled from the lists the agent can see in its observation

export interface CandidateGroup {
	readonly key: string;
	readonly ids: readonly string[];
	readonly fromObjects: boolean;
}

const idsOfObjects = (items: readonly JsonValue[]): readonly string[] =>
	items.flatMap((item) => (isObject(item) && typeof item.id === "string" ? [item.id] : []));

export const candidateGroupsOf = (observation: JsonObject): readonly CandidateGroup[] =>
	Object.keys(observation)
		.sort()
		.flatMap((key): readonly CandidateGroup[] => {
			const value = observation[key];
			if (!Array.isArray(value) || value.length === 0) return [];
			if (value.every((v) => typeof v === "string"))
				return [{ key, ids: value as readonly string[], fromObjects: false }];
			const ids = idsOfObjects(value);
			return ids.length === 0 ? [] : [{ key, ids, fromObjects: true }];
		});

export const isIdField = (name: string): boolean =>
	name === TARGET_FIELD || (name.length > ID_SUFFIX.length && name.endsWith(ID_SUFFIX));

export const candidatesForField = (
	field: string,
	groups: readonly CandidateGroup[],
): readonly string[] | undefined => {
	if (groups.length === 0) return undefined;
	const stem =
		field === TARGET_FIELD ? undefined : field.slice(0, -ID_SUFFIX.length).toLowerCase();
	const byKey =
		stem === undefined ? undefined : groups.find((g) => g.key.toLowerCase().includes(stem));
	if (byKey !== undefined) return byKey.ids;
	const fromObjects = field !== TARGET_FIELD;
	return groups.find((g) => g.fromObjects === fromObjects)?.ids;
};

const indexFromHash = (hash: string, n: number): number =>
	Number.parseInt(hash.slice(0, 8), 16) % n;

export const withCandidateIds = (
	args: JsonObject,
	observation: JsonObject,
	hashKey: readonly JsonValue[],
): JsonObject => {
	const groups = candidateGroupsOf(observation);
	const out: Record<string, JsonValue> = { ...args };
	for (const [field, value] of Object.entries(args)) {
		if (value !== ID_PLACEHOLDER || !isIdField(field)) continue;
		const candidates = candidatesForField(field, groups);
		if (candidates === undefined || candidates.length === 0) continue;
		const chosen = candidates[indexFromHash(hashOf([...hashKey, field]), candidates.length)];
		if (chosen !== undefined) out[field] = chosen;
	}
	return out;
};

class MockProvider implements DecisionProvider {
	readonly name: string;
	private readonly actions: ActionRegistry;
	private decided = 0;

	constructor(actions: ActionRegistry, name: string) {
		this.actions = actions;
		this.name = name;
	}

	async decide(
		requests: readonly DecisionRequest[],
		ctx: RoundContext,
	): Promise<readonly Result<Decision, ProviderFailure>[]> {
		return requests.map((req) => this.decideOne(req, ctx));
	}

	reset(): void {
		this.decided = 0;
	}

	getState(): JsonValue {
		return { decided: this.decided };
	}

	setState(s: JsonValue): void {
		if (isObject(s) && typeof s.decided === "number") this.decided = s.decided;
	}

	private decideOne(req: DecisionRequest, ctx: RoundContext): Result<Decision, ProviderFailure> {
		if (req.actionSpace.length === 0)
			return err({
				agentId: req.agentId,
				reason: "action space is empty",
				retryable: false,
				excType: FAILURE_TYPES.noAvailableActions,
			});
		const key = req.prompt?.hash ?? canonicalJson(req.observation);
		const action =
			req.actionSpace[indexFromHash(hashOf([key, ctx.seedPath]), req.actionSpace.length)];
		if (action === undefined)
			return err({
				agentId: req.agentId,
				reason: "action space yielded no action",
				retryable: false,
				excType: FAILURE_TYPES.invalidAction,
			});
		const def = this.actions.get(action);
		if (action === ANSWER_ACTION && def === undefined) return this.answer(req, key, ctx);
		// Actions outside the registry are virtual (batch executors resolve them): no args to build.
		if (def === undefined) {
			this.decided += 1;
			return ok({
				agentId: req.agentId,
				action,
				args: {},
				provenance: "rule",
				cost: ZERO_COST,
				parseOk: true,
			});
		}
		const example = exampleFromJsonSchema(zodToJsonSchema(def.params));
		const args = withCandidateIds(isObject(example) ? example : {}, req.observation, [
			key,
			[...ctx.seedPath],
			req.agentId,
		]);
		const validated = this.actions.validate({
			agentId: req.agentId,
			name: action,
			args,
			cause: req.observationEvent,
		});
		if (!validated.ok)
			return err({
				agentId: req.agentId,
				reason: `generated args rejected for '${action}'`,
				retryable: false,
				excType: FAILURE_TYPES.invalidArgs,
			});
		this.decided += 1;
		return ok({
			agentId: req.agentId,
			action,
			args: validated.value.args,
			provenance: "rule",
			cost: ZERO_COST,
			parseOk: true,
		});
	}

	// Questionnaire answers: a valid value per question, drawn deterministically from the key.
	private answer(
		req: DecisionRequest,
		key: string,
		ctx: RoundContext,
	): Result<Decision, ProviderFailure> {
		const questions = questionsOf(req.observation);
		if (questions === undefined)
			return err({
				agentId: req.agentId,
				reason: "observation carries no questionnaire",
				retryable: false,
				excType: FAILURE_TYPES.invalidAction,
			});
		const answers: Record<string, JsonValue> = {};
		for (const question of questions) {
			const hash = hashOf([key, [...ctx.seedPath], req.agentId, question.id]);
			switch (question.responseType) {
				case "integer":
					answers[question.id] = indexFromHash(hash, MOCK_INTEGER_RANGE);
					break;
				case "float":
					answers[question.id] = Number.parseInt(hash.slice(0, 8), 16) / TWO_POW_32;
					break;
				case "choice": {
					const choices = question.choices ?? [];
					answers[question.id] = choices[indexFromHash(hash, choices.length)] ?? "";
					break;
				}
				case "text":
					answers[question.id] = `${ID_PLACEHOLDER} ${question.id}`;
					break;
			}
		}
		this.decided += 1;
		return ok({
			agentId: req.agentId,
			action: ANSWER_ACTION,
			args: { [ANSWERS_ARG]: answers },
			provenance: "rule",
			cost: ZERO_COST,
			parseOk: true,
		});
	}
}

export const createMockProvider = (actions: ActionRegistry, name = "mock"): DecisionProvider =>
	new MockProvider(actions, name);
