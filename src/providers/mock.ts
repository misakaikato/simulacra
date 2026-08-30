import { zodToJsonSchema } from "../core/actions";
import { FAILURE_TYPES } from "../core/failures";
import { canonicalJson, hashOf } from "../core/hash";
import type { ActionRegistry, DecisionProvider } from "../core/protocols";
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
			return "...";
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

const indexFromHash = (hash: string, n: number): number =>
	Number.parseInt(hash.slice(0, 8), 16) % n;

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
		const def = action === undefined ? undefined : this.actions.get(action);
		if (action === undefined || def === undefined)
			return err({
				agentId: req.agentId,
				reason: `action '${String(action)}' is not registered`,
				retryable: false,
				excType: FAILURE_TYPES.invalidAction,
			});
		const example = exampleFromJsonSchema(zodToJsonSchema(def.params));
		const args = isObject(example) ? example : {};
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
}

export const createMockProvider = (actions: ActionRegistry, name = "mock"): DecisionProvider =>
	new MockProvider(actions, name);
