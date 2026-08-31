import { z } from "zod";
import {
	ORDINAL_COLUMN,
	ZERO_EVENT_ID,
	createRuleProvider,
	defineAction,
	ok,
	parseOptions,
	type ActionDef,
	type Cost,
	type Decision,
	type DecisionRequest,
	type DeclareError,
	type DuplicatePlugin,
	type Effect,
	type EntityId,
	type JsonValue,
	type LogicalTime,
	type Module,
	type PluginContext,
	type PluginError,
	type PluginSpec,
	type Registry,
	type Result,
	type Rng,
	type RuleFn,
	type Scalar,
	type World,
	type WorldView,
} from "../../src/index";

export const PD_KIND = "pd";
export const PD_RULE_KIND = "pdRule";
export const PD_COLUMNS = {
	payoff: `${PD_KIND}.payoff`,
	cooperations: `${PD_KIND}.cooperations`,
	rounds: `${PD_KIND}.rounds`,
	lastAction: `${PD_KIND}.lastAction`,
	action: `${PD_KIND}.action`,
} as const;

const MOVES = ["cooperate", "defect"] as const;
export type Move = (typeof MOVES)[number];
const STRATEGIES = ["titForTat", "random", "alwaysCooperate", "alwaysDefect"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const PAYOFFS: Readonly<Record<`${Move}:${Move}`, readonly [number, number]>> = {
	"cooperate:cooperate": [3, 3],
	"cooperate:defect": [0, 5],
	"defect:cooperate": [5, 0],
	"defect:defect": [1, 1],
};

const ZERO_COST: Cost = {
	llmCalls: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	wallMs: 0,
};

const PdOptions = z.object({ entity: z.string().min(1).default("agent") });
const RuleOptions = z.object({ strategy: z.enum(STRATEGIES).default("titForTat") });

const isMove = (v: Scalar | undefined): v is Move =>
	typeof v === "string" && (MOVES as readonly string[]).includes(v);

const numberOf = (v: Scalar | undefined): number => (typeof v === "number" ? v : 0);

const pairsOf = (view: WorldView, entity: string): readonly (readonly [EntityId, EntityId])[] => {
	const ordinal = view.column<number>(entity, ORDINAL_COLUMN);
	const ordered = [...view.ids(entity)].sort(
		(a, b) => (ordinal.get(a) ?? 0) - (ordinal.get(b) ?? 0),
	);
	const pairs: (readonly [EntityId, EntityId])[] = [];
	for (let i = 0; i + 1 < ordered.length; i += 2) {
		const a = ordered[i];
		const b = ordered[i + 1];
		if (a !== undefined && b !== undefined) pairs.push([a, b]);
	}
	return pairs;
};

const opponentOf = (view: WorldView, entity: string, id: EntityId): EntityId | undefined => {
	for (const [a, b] of pairsOf(view, entity)) {
		if (a === id) return b;
		if (b === id) return a;
	}
	return undefined;
};

class PrisonersDilemmaModule implements Module {
	readonly name: string;
	readonly concurrencySafe = true;
	private readonly entity: string;

	constructor(name: string, entity: string) {
		this.name = name;
		this.entity = entity;
	}

	declare(world: World): Result<void, DeclareError> {
		const decls = [
			{ name: "payoff", dtype: "f64", default: 0, merge: "sum" },
			{ name: "cooperations", dtype: "i32", default: 0, merge: "sum" },
			{ name: "rounds", dtype: "i32", default: 0, merge: "sum" },
			{ name: "lastAction", dtype: "str", default: "", merge: "last" },
			{ name: "action", dtype: "str", default: "", merge: "last" },
		] as const;
		for (const decl of decls) {
			const declared = world.declare({ ...decl, entity: this.entity, owner: PD_KIND });
			if (!declared.ok) return declared;
		}
		return ok(undefined);
	}

	actions(): readonly ActionDef[] {
		const choose = (move: Move, description: string, fallback: boolean): ActionDef =>
			defineAction({
				name: move,
				description,
				params: z.object({}),
				requiresModules: [this.name],
				fallback,
				resolve: async (call) => [
					{
						op: "set",
						entity: this.entity,
						id: call.agentId,
						column: PD_COLUMNS.action,
						value: move,
						cause: call.cause,
					},
				],
			});
		return [
			choose("cooperate", "Cooperate with your opponent this round", false),
			choose("defect", "Defect against your opponent this round", true),
		];
	}

	observe(view: WorldView, ids: readonly EntityId[]): Readonly<Record<EntityId, JsonValue>> {
		const out: Record<EntityId, JsonValue> = {};
		for (const id of ids) {
			const row = view.row(this.entity, id);
			const opponent = opponentOf(view, this.entity, id);
			const opponentRow =
				opponent === undefined ? undefined : view.row(this.entity, opponent);
			const last = opponentRow?.[PD_COLUMNS.lastAction];
			out[id] = {
				pd: {
					round: numberOf(row?.[PD_COLUMNS.rounds]),
					payoff: numberOf(row?.[PD_COLUMNS.payoff]),
					opponentLastAction: isMove(last) ? last : null,
				},
			};
		}
		return out;
	}

	async step(view: WorldView, _t: LogicalTime, _rng: Rng): Promise<readonly Effect[]> {
		const effects: Effect[] = [];
		const cause = ZERO_EVENT_ID;
		for (const [a, b] of pairsOf(view, this.entity)) {
			const moveA = view.row(this.entity, a)?.[PD_COLUMNS.action];
			const moveB = view.row(this.entity, b)?.[PD_COLUMNS.action];
			if (!isMove(moveA) || !isMove(moveB)) {
				for (const [id, move] of [
					[a, moveA],
					[b, moveB],
				] as const)
					if (isMove(move)) effects.push(this.reset(id, cause));
				continue;
			}
			const [payA, payB] = PAYOFFS[`${moveA}:${moveB}`];
			for (const [id, move, pay] of [
				[a, moveA, payA],
				[b, moveB, payB],
			] as const) {
				effects.push(
					{
						op: "inc",
						entity: this.entity,
						id,
						column: PD_COLUMNS.payoff,
						value: pay,
						cause,
					},
					{
						op: "inc",
						entity: this.entity,
						id,
						column: PD_COLUMNS.rounds,
						value: 1,
						cause,
					},
					{
						op: "set",
						entity: this.entity,
						id,
						column: PD_COLUMNS.lastAction,
						value: move,
						cause,
					},
					this.reset(id, cause),
				);
				if (move === "cooperate")
					effects.push({
						op: "inc",
						entity: this.entity,
						id,
						column: PD_COLUMNS.cooperations,
						value: 1,
						cause,
					});
			}
		}
		return effects;
	}

	getState(): JsonValue {
		return null;
	}

	setState(_s: JsonValue): void {}

	private reset(id: EntityId, cause: Effect["cause"]): Effect {
		return { op: "set", entity: this.entity, id, column: PD_COLUMNS.action, value: "", cause };
	}
}

const isObject = (v: JsonValue | undefined): v is { readonly [k: string]: JsonValue } =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const opponentLastAction = (req: DecisionRequest): Move | undefined => {
	const pd = req.observation.pd;
	if (!isObject(pd)) return undefined;
	const last = pd.opponentLastAction;
	return typeof last === "string" && isMove(last) ? last : undefined;
};

const decide = (req: DecisionRequest, move: Move): Decision => ({
	agentId: req.agentId,
	action: move,
	args: {},
	provenance: "rule",
	cost: ZERO_COST,
	parseOk: true,
});

export const strategies: Readonly<Record<Strategy, RuleFn>> = {
	titForTat: (req) => decide(req, opponentLastAction(req) === "defect" ? "defect" : "cooperate"),
	random: (req, rng) => decide(req, rng.bernoulli(0.5) ? "cooperate" : "defect"),
	alwaysCooperate: (req) => decide(req, "cooperate"),
	alwaysDefect: (req) => decide(req, "defect"),
};

export const createPdModule = (
	spec: PluginSpec,
	ctx: PluginContext,
): Result<Module, PluginError> => {
	const options = parseOptions(ctx.registry.modules.slot, spec, PdOptions);
	if (!options.ok) return options;
	return ok(new PrisonersDilemmaModule(spec.name ?? spec.kind, options.value.entity));
};

export const register = (registry: Registry): Result<void, DuplicatePlugin> => {
	const module = registry.modules.register(PD_KIND, createPdModule);
	if (!module.ok) return module;
	return registry.providers.register(PD_RULE_KIND, (spec, ctx) => {
		const options = parseOptions(registry.providers.slot, spec, RuleOptions);
		if (!options.ok) return options;
		return ok(
			createRuleProvider({
				name: spec.name ?? spec.kind,
				seed: ctx.scenario.seed,
				rule: strategies[options.value.strategy],
			}),
		);
	});
};
