// Catalogue of perturbation-axis templates following the TRAILS taxonomy: design dimensions
// (what the simulation is made of) and representation categories (how the same design is
// written down for the model). A template fixes level, kind, dimension and a default target;
// a plan supplies the levels and may override the target.
// 扰动轴模板目录，沿用 TRAILS 分类：设计维度（模拟由什么构成）与表示类别
// （同一设计如何写给模型）。模板固定层级、种类、维度与默认 target；计划提供取值并可覆盖 target。

import type { JsonValue, PerturbationAxis } from "../core/types";

export type AxisLevel = PerturbationAxis["level"];
export type AxisKind = PerturbationAxis["kind"];

export interface AxisTemplate {
	readonly id: string;
	readonly code: string;
	readonly level: AxisLevel;
	readonly kind: AxisKind;
	readonly dimension: string;
	readonly target: string;
	readonly description: string;
}

// TRAILS design dimensions D1 to D8: what the simulation is made of
// TRAILS 设计维度 D1 到 D8：模拟由什么构成

export const DESIGN_AXES: readonly AxisTemplate[] = [
	{
		id: "model_substrate",
		code: "D1",
		level: "micro",
		kind: "design",
		dimension: "model substrate",
		target: "llm.model",
		description: "Which model family or size produces the agents' decisions.",
	},
	{
		id: "agent_specification",
		code: "D2",
		level: "micro",
		kind: "design",
		dimension: "agent specification",
		target: "population.fields",
		description: "Which persona fields exist and how they are sampled.",
	},
	{
		id: "internal_state",
		code: "D3",
		level: "micro",
		kind: "design",
		dimension: "internal state",
		target: "executors.0.options.components",
		description: "Which internal components (instructions, memory, goals) an agent carries.",
	},
	{
		id: "memory_temporality",
		code: "D4",
		level: "micro",
		kind: "design",
		dimension: "memory and temporality",
		target: "params.memoryWindow",
		description: "How much history an agent recalls and how it is compressed.",
	},
	{
		id: "interaction_protocol",
		code: "D5",
		level: "meso",
		kind: "design",
		dimension: "interaction protocol",
		target: "policy.options.p",
		description: "Who acts when: activation policy, turn taking and synchrony.",
	},
	{
		id: "intervention_design",
		code: "D6",
		level: "macro",
		kind: "design",
		dimension: "intervention design",
		target: "params.intervention",
		description: "How a treatment is administered: timing, dose and selection.",
	},
	{
		id: "environment_structure",
		code: "D7",
		level: "meso",
		kind: "design",
		dimension: "environment structure",
		target: "params.homophily",
		description: "Network topology and platform mechanics such as recommenders.",
	},
	{
		id: "population_scale",
		code: "D8",
		level: "macro",
		kind: "design",
		dimension: "population scale",
		target: "population.n",
		description: "How many agents take part.",
	},
];

// TRAILS representation categories R1 to R5: how the same design is written down for the model
// TRAILS 表示类别 R1 到 R5：同一设计如何写给模型

export const REPRESENTATION_AXES: readonly AxisTemplate[] = [
	{
		id: "representational_format",
		code: "R1",
		level: "micro",
		kind: "representation",
		dimension: "representational format",
		target: "prompt.personaFormat",
		description: "Prose, bullets or a table for the same persona.",
	},
	{
		id: "instruction_hierarchy",
		code: "R2",
		level: "micro",
		kind: "representation",
		dimension: "instruction hierarchy",
		target: "prompt.instructionOrder",
		description: "Where task instructions sit relative to the persona.",
	},
	{
		id: "linguistic_framing",
		code: "R3",
		level: "micro",
		kind: "representation",
		dimension: "linguistic framing",
		target: "params.framing",
		description: "Wording of the same situation: neutral, moralised or risk framed.",
	},
	{
		id: "context_representation",
		code: "R4",
		level: "micro",
		kind: "representation",
		dimension: "context representation",
		target: "prompt.memoryRepresentation",
		description: "Transcript, JSON or bullets for the same memory.",
	},
	{
		id: "interaction_sequencing",
		code: "R5",
		level: "meso",
		kind: "representation",
		dimension: "interaction sequencing",
		target: "prompt.rolePlacement",
		description: "Whether the role lives in the system turn or the user turn.",
	},
];

export const AXIS_CATALOG: readonly AxisTemplate[] = [...DESIGN_AXES, ...REPRESENTATION_AXES];

export const axisTemplate = (id: string): AxisTemplate | undefined =>
	AXIS_CATALOG.find((axis) => axis.id === id);

// Default targets name the example scenarios' parameters (params.homophily, policy.options.p);
// a plan overrides `target` with whatever path its own scenario exposes.
// 默认 target 指向示例场景的参数（params.homophily、policy.options.p）；
// 计划可用自己场景暴露的任意路径覆盖 `target`。
export const axisFromTemplate = (
	id: string,
	levels: readonly JsonValue[],
	overrides: Partial<Pick<PerturbationAxis, "id" | "target">> = {},
): PerturbationAxis | undefined => {
	const template = axisTemplate(id);
	if (template === undefined) return undefined;
	return {
		id: overrides.id ?? template.id,
		level: template.level,
		kind: template.kind,
		dimension: template.dimension,
		target: overrides.target ?? template.target,
		levels,
	};
};
