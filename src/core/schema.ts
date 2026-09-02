import { z } from "zod";
import { MAP_KEY, PARAM_KEY, describeParamError, resolveParamRefs } from "./params";
import type { JsonObject, JsonValue, Scalar } from "./types";

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema),
		z.record(z.string(), JsonValueSchema),
	]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const ScalarSchema: z.ZodType<Scalar> = z.union([
	z.number(),
	z.string(),
	z.boolean(),
	z.null(),
	z.array(z.string()),
]);

export const ParamRefSchema = z.object({
	[PARAM_KEY]: z.string().min(1),
	[MAP_KEY]: z.record(z.string(), JsonValueSchema).optional(),
});

export const ColumnDtypeSchema = z.enum(["f64", "i32", "bool", "str", "strlist"]);

export const PersonaSamplingSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("value"), value: ScalarSchema }),
	z.object({
		kind: z.literal("choice"),
		choices: z.array(ScalarSchema).min(1),
		weights: z.array(z.number().nonnegative()).optional(),
	}),
	z.object({ kind: z.literal("range"), min: z.number(), max: z.number() }),
]);

export const PersonaFieldSchema = z.object({
	name: z.string().min(1),
	dtype: ColumnDtypeSchema,
	private: z.boolean().optional(),
	sampling: PersonaSamplingSchema,
});

export const PopulationSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("synthetic") }),
	z.object({ kind: z.literal("csv"), path: z.string().min(1) }),
	z.object({ kind: z.literal("json"), path: z.string().min(1) }),
]);

const PopulationSize = z.number().int().positive();

const PopulationFields = {
	fields: z.array(PersonaFieldSchema).default([]),
	source: PopulationSourceSchema.default({ kind: "synthetic" }),
	provenance: z.enum(["demographic", "survey", "interview", "synthetic"]).default("synthetic"),
	stratify: z.record(z.string(), z.record(z.string(), z.number())).optional(),
};

export const PopulationSpecSchema = z.object({ n: PopulationSize, ...PopulationFields });

// In a scenario document the population size may reference a scenario param;
// the reference is resolved while the scenario is parsed so that Scenario.population.n is a number.
const PopulationSpecInputSchema = z.object({
	n: z.union([PopulationSize, ParamRefSchema]),
	...PopulationFields,
});

export const PluginSpecSchema = z.object({
	kind: z.string().min(1),
	name: z.string().min(1).optional(),
	options: JsonObjectSchema.optional(),
});

export const ModuleSpecSchema = PluginSpecSchema;
export const ExecutorSpecSchema = PluginSpecSchema;
export const ProviderSpecSchema = PluginSpecSchema;
export const PolicySpecSchema = PluginSpecSchema;

export const InstrumentSpecSchema = PluginSpecSchema.extend({
	every: z.number().int().positive().optional(),
});

export const SelectorPredicateSchema = z.union([
	z.strictObject({ in: z.array(ScalarSchema) }),
	z.strictObject({ gt: z.number() }),
	z.strictObject({ lt: z.number() }),
	JsonValueSchema,
]);

export const SelectorSchema = z.object({
	where: z.record(z.string(), SelectorPredicateSchema),
	fraction: z.number().min(0).max(1).optional(),
	n: z.number().int().positive().optional(),
});

export const StepSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("run"), ticks: z.number().int().positive() }),
	z.object({
		kind: z.literal("intervene"),
		arm: z.string().min(1),
		instruction: z.string().optional(),
	}),
	z.object({
		kind: z.literal("questionnaire"),
		name: z.string().min(1),
		targets: SelectorSchema.optional(),
	}),
	z.object({ kind: z.literal("checkpoint") }),
]);

export const LLMSpecSchema = z.object({
	baseUrl: z.string().min(1).default("https://api.deepseek.com/v1"),
	model: z.string().min(1).default("deepseek-v4-flash"),
	apiKeyEnv: z.string().min(1).default("SIMULACRA_LLM_API_KEY"),
	mode: z.enum(["live", "record", "replay"]).default("live"),
	recordDir: z.string().min(1).optional(),
	concurrency: z
		.object({
			initial: z.number().int().positive().default(4),
			max: z.number().int().positive().default(16),
		})
		.prefault({}),
	structured: z.enum(["auto", "json_schema", "prompt"]).default("auto"),
	budget: z
		.object({
			maxCalls: z.number().int().nonnegative().default(1000),
			maxCompletionTokens: z.number().int().positive().default(512),
		})
		.prefault({}),
	timeoutMs: z.number().int().positive().default(60000),
	sendSeed: z.boolean().default(true),
	extra: z.record(z.string(), JsonValueSchema).optional(),
});

export const PromptOptionsSchema = z.object({
	personaFormat: z.enum(["plain", "bullets", "table"]).default("plain"),
	instructionOrder: z.enum(["first", "last"]).default("first"),
	rolePlacement: z.enum(["system", "user"]).default("system"),
	naming: z.enum(["id", "name", "anonymous"]).default("id"),
	memoryRepresentation: z.enum(["transcript", "json", "bullets"]).default("transcript"),
	contextWindow: z.number().int().positive().default(4000),
});

export const ArmSchema = z.object({
	name: z.string().min(1),
	role: z.enum(["treatment", "control"]),
	overrides: JsonObjectSchema.default({}),
	selection: SelectorSchema.optional(),
});

export const OutcomeSchema = z.object({
	name: z.string().min(1),
	metric: z.string().min(1),
	direction: z.enum(["increase", "decrease", "any"]).default("any"),
	targetDistribution: z.array(z.number()).optional(),
});

export const HypothesisSchema = z.object({
	id: z.string().min(1),
	claim: z.string(),
	claimType: z.enum(["exploratory", "mechanism", "policy"]),
	arms: z.array(ArmSchema),
	outcomes: z.array(OutcomeSchema),
});

export const QuestionSchema = z
	.object({
		id: z.string().min(1),
		prompt: z.string().min(1),
		responseType: z.enum(["text", "integer", "float", "choice"]),
		choices: z.array(z.string().min(1)).optional(),
	})
	.refine((q) => q.responseType !== "choice" || (q.choices?.length ?? 0) > 0, {
		message: "choice questions need at least one choice",
		path: ["choices"],
	});

export const QuestionnaireOptionsSchema = z.object({
	questions: z.array(QuestionSchema).min(1),
	entersMemory: z.boolean().default(true),
});

const ScenarioObjectSchema = z.object({
	scenarioId: z.string().min(1),
	replicationId: z.number().int().nonnegative().default(0),
	seed: z.number().int(),
	seedPath: z.array(z.number().int()).default([]),
	params: JsonObjectSchema.default({}),
	population: PopulationSpecInputSchema,
	modules: z.array(ModuleSpecSchema).default([]),
	executors: z.array(ExecutorSpecSchema).default([]),
	providers: z.record(z.string(), ProviderSpecSchema).default({}),
	policy: PolicySpecSchema.default({ kind: "allAgents" }),
	instruments: z.array(InstrumentSpecSchema).default([]),
	steps: z.array(StepSchema).default([]),
	llm: LLMSpecSchema.prefault({}),
	prompt: PromptOptionsSchema.prefault({}),
	plugins: z.array(z.string().min(1)).optional(),
	hypothesis: HypothesisSchema.optional(),
});

type ScenarioInput = z.output<typeof ScenarioObjectSchema>;
type ScenarioOutput = Omit<ScenarioInput, "population"> & {
	readonly population: z.output<typeof PopulationSpecSchema>;
};

const POPULATION_SIZE_PATH = ["population", "n"];

const resolvePopulationSize = (scenario: ScenarioInput, ctx: z.RefinementCtx): ScenarioOutput => {
	const { n, ...population } = scenario.population;
	if (typeof n === "number") return { ...scenario, population: { ...population, n } };
	const map = n[MAP_KEY];
	const ref: JsonObject = {
		[PARAM_KEY]: n[PARAM_KEY],
		...(map === undefined ? {} : { [MAP_KEY]: map }),
	};
	const resolved = resolveParamRefs(ref, scenario.params, POPULATION_SIZE_PATH.join("."));
	const value = resolved.ok ? resolved.value : undefined;
	if (typeof value === "number" && Number.isInteger(value) && value > 0)
		return { ...scenario, population: { ...population, n: value } };
	ctx.addIssue({
		code: "custom",
		path: POPULATION_SIZE_PATH,
		message: resolved.ok
			? `must resolve to a positive integer, got ${JSON.stringify(value)}`
			: describeParamError(resolved.error),
		input: n,
	});
	return { ...scenario, population: { ...population, n: 0 } };
};

export const ScenarioSchema = ScenarioObjectSchema.transform(resolvePopulationSize);

export const PerturbationAxisSchema = z.object({
	id: z.string().min(1),
	level: z.enum(["micro", "meso", "macro"]),
	kind: z.enum(["design", "representation"]),
	dimension: z.string().min(1),
	target: z.string().min(1),
	levels: z.array(JsonValueSchema).min(1),
});

export const AuditPlanSchema = z.object({
	base: ScenarioSchema,
	hypothesis: HypothesisSchema.optional(),
	axes: z.array(PerturbationAxisSchema).default([]),
	design: z.enum(["one_at_a_time", "full_factorial"]).default("one_at_a_time"),
	replications: z.number().int().positive().default(1),
	models: z.array(z.string().min(1)).default([]),
	metrics: z.array(z.string().min(1)).default([]),
	claimType: z.enum(["exploratory", "mechanism", "policy"]).default("exploratory"),
	concurrency: z.number().int().positive().default(1),
});

export const ColumnDeclSchema = z.object({
	entity: z.string().min(1),
	name: z.string().min(1),
	dtype: ColumnDtypeSchema,
	default: ScalarSchema,
	owner: z.string().min(1),
	merge: z.enum(["last", "sum", "max", "append"]),
});

export const ColumnSnapshotSchema = z.discriminatedUnion("encoding", [
	z.object({ decl: ColumnDeclSchema, encoding: z.literal("base64"), data: z.string() }),
	z.object({ decl: ColumnDeclSchema, encoding: z.literal("strings"), data: z.array(z.string()) }),
	z.object({
		decl: ColumnDeclSchema,
		encoding: z.literal("stringLists"),
		data: z.array(z.array(z.string())),
	}),
]);

export const WorldSnapshotSchema = z.object({
	version: z.literal(1),
	entities: z.array(
		z.object({
			name: z.string().min(1),
			ids: z.array(z.string()),
			columns: z.array(ColumnSnapshotSchema),
		}),
	),
	env: JsonObjectSchema,
});

export const LogicalTimeSchema = z.object({
	tick: z.number().int().nonnegative(),
	substep: z.number().int().nonnegative(),
	seq: z.number().int().nonnegative(),
});

export const CheckpointMetaSchema = z.object({
	version: z.literal(1),
	scenarioHash: z.string().min(1),
	digest: z.string().min(1),
	lastEventId: z.string().min(1),
	worldHash: z.string().min(1),
	tick: z.number().int().nonnegative(),
});

export const ClockStateSchema = z.object({ now: LogicalTimeSchema });
