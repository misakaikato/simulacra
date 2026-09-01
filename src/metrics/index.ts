import { z } from "zod";
import { toEntityId } from "../core/ids";
import type {
	DuplicatePlugin,
	EventLog,
	Metric,
	PluginContext,
	PluginError,
	PluginFactory,
	Registry,
	WorldView,
} from "../core/protocols";
import { parseOptions } from "../core/registry";
import { err, ok } from "../core/result";
import type { EntityId, InstrumentSpec, JsonValue, Result, Scalar } from "../core/types";
import { POST_COLUMNS, POST_ENTITY } from "../modules/posts";

export const STANCE_THRESHOLD = 0.5;
export const STANCE_GROUPS = { anti: "anti", neutral: "neutral", pro: "pro" } as const;

const SLOT = "metrics";

const numberOf = (v: Scalar | undefined): number => (typeof v === "number" ? v : 0);

const isObject = (v: JsonValue): v is { readonly [k: string]: JsonValue } =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const hasColumn = (view: WorldView, entity: string, column: string): boolean =>
	view.entities.includes(entity) && view.columns(entity).some((c) => c.name === column);

const columnSum = (view: WorldView, entity: string, column: string): number => {
	if (!hasColumn(view, entity, column)) return 0;
	let total = 0;
	for (const v of view.column<Scalar>(entity, column).toArray()) total += numberOf(v);
	return total;
};

// cooperationRate and averagePayoff: column ratios over the agent table

const RatioOptions = z.object({
	entity: z.string().min(1).default("agent"),
	numerator: z.string().min(1),
	denominator: z.string().min(1).default("pd.rounds"),
});

export const ratioMetric = (
	name: string,
	entity: string,
	numerator: string,
	denominator: string,
): Metric => ({
	name,
	compute: (view) => {
		const total = columnSum(view, entity, denominator);
		return total === 0 ? 0 : columnSum(view, entity, numerator) / total;
	},
});

const ratioFactory =
	(defaultNumerator: string): PluginFactory<Metric> =>
	(spec) => {
		const o = parseOptions(
			SLOT,
			spec,
			RatioOptions.extend({
				numerator: z.string().min(1).default(defaultNumerator),
			}),
		);
		if (!o.ok) return o;
		return ok(
			ratioMetric(
				spec.name ?? spec.kind,
				o.value.entity,
				o.value.numerator,
				o.value.denominator,
			),
		);
	};

// Interaction graph: (i, j) when i reposted or replied to a post authored by j

export const GroupOptionsSchema = z.object({
	entity: z.string().min(1).default("agent"),
	stanceColumn: z.string().min(1).optional(),
	groupColumn: z.string().min(1).optional(),
	postEntity: z.string().min(1).default(POST_ENTITY),
	authorColumn: z.string().min(1).default(POST_COLUMNS.author),
	actions: z.array(z.string().min(1)).default(["repost", "reply"]),
});

export type GroupOptions = z.output<typeof GroupOptionsSchema>;

export type InteractionEdge = readonly [EntityId, EntityId];

export const interactionEdges = (
	view: WorldView,
	log: EventLog,
	options: Pick<GroupOptions, "postEntity" | "authorColumn" | "actions">,
): readonly InteractionEdge[] => {
	if (!hasColumn(view, options.postEntity, options.authorColumn)) return [];
	const author = view.column<string>(options.postEntity, options.authorColumn);
	const edges: InteractionEdge[] = [];
	for (const e of log.query({ kind: ["decision"] })) {
		if (e.kind !== "decision" || e.agentId === undefined) continue;
		if (!options.actions.includes(e.payload.action)) continue;
		const args = e.payload.args;
		const postId = isObject(args) ? args.postId : undefined;
		if (typeof postId !== "string") continue;
		const target = author.get(toEntityId(postId));
		if (target === undefined || target.length === 0) continue;
		edges.push([e.agentId, toEntityId(target)]);
	}
	return edges;
};

export const stanceGroup = (stance: number): string =>
	stance < -STANCE_THRESHOLD
		? STANCE_GROUPS.anti
		: stance > STANCE_THRESHOLD
			? STANCE_GROUPS.pro
			: STANCE_GROUPS.neutral;

export const groupLookup = (
	view: WorldView,
	options: Pick<GroupOptions, "entity" | "stanceColumn" | "groupColumn">,
): ((id: EntityId) => string | undefined) => {
	if (options.groupColumn !== undefined) {
		const column = view.column<Scalar>(options.entity, options.groupColumn);
		return (id) => {
			const v = column.get(id);
			return v === undefined ? undefined : String(v);
		};
	}
	const column = view.column<Scalar>(options.entity, options.stanceColumn ?? "");
	return (id) => {
		const v = column.get(id);
		return v === undefined ? undefined : stanceGroup(numberOf(v));
	};
};

export const groupedEdges = (
	edges: readonly InteractionEdge[],
	groupOf: (id: EntityId) => string | undefined,
): readonly (readonly [string, string])[] =>
	edges.flatMap(([i, j]) => {
		const a = groupOf(i);
		const b = groupOf(j);
		return a === undefined || b === undefined ? [] : [[a, b] as const];
	});

// r = (sum_u e_uu - sum_u a_u b_u) / (1 - sum_u a_u b_u)
export const assortativityOf = (edges: readonly (readonly [string, string])[]): number => {
	const m = edges.length;
	if (m === 0) return 0;
	const out = new Map<string, number>();
	const inn = new Map<string, number>();
	let same = 0;
	for (const [a, b] of edges) {
		out.set(a, (out.get(a) ?? 0) + 1);
		inn.set(b, (inn.get(b) ?? 0) + 1);
		if (a === b) same += 1;
	}
	let sumAB = 0;
	for (const [group, count] of out) sumAB += (count / m) * ((inn.get(group) ?? 0) / m);
	const denominator = 1 - sumAB;
	return denominator === 0 ? 0 : (same / m - sumAB) / denominator;
};

export const sameGroupRatioOf = (edges: readonly (readonly [string, string])[]): number =>
	edges.length === 0 ? 0 : edges.filter(([a, b]) => a === b).length / edges.length;

const groupFactory =
	(reduce: (edges: readonly (readonly [string, string])[]) => number): PluginFactory<Metric> =>
	(spec) => {
		const o = parseOptions(SLOT, spec, GroupOptionsSchema);
		if (!o.ok) return o;
		if (o.value.stanceColumn === undefined && o.value.groupColumn === undefined)
			return err({
				reason: "invalid_options",
				slot: SLOT,
				kind: spec.kind,
				issues: ["stanceColumn or groupColumn is required"],
			});
		const options = o.value;
		return ok({
			name: spec.name ?? spec.kind,
			compute: (view, log) =>
				reduce(
					groupedEdges(interactionEdges(view, log, options), groupLookup(view, options)),
				),
		});
	};

// actionShare: share of decision events choosing one action

const ActionShareOptions = z.object({ action: z.string().min(1) });

export const actionShareMetric = (name: string, action: string): Metric => ({
	name,
	compute: (_view, log) => {
		const decisions = log.query({ kind: ["decision"] });
		if (decisions.length === 0) return 0;
		return (
			decisions.filter((e) => e.kind === "decision" && e.payload.action === action).length /
			decisions.length
		);
	},
});

// tvdToTarget: total variation distance between a column histogram and a target

const TvdOptions = z.object({
	entity: z.string().min(1).default("agent"),
	column: z.string().min(1),
	target: z.array(z.number().nonnegative()).min(1),
	range: z.tuple([z.number(), z.number()]).optional(),
	categories: z.array(z.string()).optional(),
});

export type TvdOptions = z.output<typeof TvdOptions>;

const normalize = (xs: readonly number[]): readonly number[] => {
	const total = xs.reduce((a, b) => a + b, 0);
	return total > 0 ? xs.map((x) => x / total) : xs.map(() => 1 / xs.length);
};

export const histogramOf = (values: readonly Scalar[], options: TvdOptions): readonly number[] => {
	const bins = options.target.length;
	const counts = new Array<number>(bins).fill(0);
	if (options.categories !== undefined) {
		const index = new Map(options.categories.map((c, i) => [c, i] as const));
		for (const v of values) {
			const i = index.get(String(v));
			if (i !== undefined && i < bins) counts[i] = (counts[i] ?? 0) + 1;
		}
		return counts;
	}
	const numbers = values.map(numberOf);
	const lo = options.range?.[0] ?? Math.min(...numbers);
	const hi = options.range?.[1] ?? Math.max(...numbers);
	const width = hi - lo;
	for (const v of numbers) {
		const raw = width > 0 ? Math.floor(((v - lo) / width) * bins) : 0;
		const i = Math.max(0, Math.min(bins - 1, raw));
		counts[i] = (counts[i] ?? 0) + 1;
	}
	return counts;
};

export const tvdOf = (p: readonly number[], q: readonly number[]): number =>
	0.5 * p.reduce((acc, pi, i) => acc + Math.abs(pi - (q[i] ?? 0)), 0);

export const tvdToTargetMetric = (name: string, options: TvdOptions): Metric => ({
	name,
	compute: (view) => {
		const values = hasColumn(view, options.entity, options.column)
			? view.column<Scalar>(options.entity, options.column).toArray()
			: [];
		const counts = histogramOf(values, options);
		const total = counts.reduce((a, b) => a + b, 0);
		const p = total > 0 ? counts.map((c) => c / total) : counts.map(() => 0);
		return tvdOf(p, normalize(options.target));
	},
});

// columnMean: arithmetic mean of a numeric column over all rows of an entity

const ColumnMeanOptions = z.object({
	entity: z.string().min(1).default("agent"),
	column: z.string().min(1),
});

export const columnMeanMetric = (name: string, entity: string, column: string): Metric => ({
	name,
	compute: (view) => {
		if (!hasColumn(view, entity, column)) return 0;
		const values = view.column<Scalar>(entity, column);
		const n = values.length;
		if (n === 0) return 0;
		let total = 0;
		for (let i = 0; i < n; i += 1) total += numberOf(values.at(i));
		return total / n;
	},
});

export const registerBuiltinMetrics = (registry: Registry): Result<void, DuplicatePlugin> => {
	const factories: readonly (readonly [string, PluginFactory<Metric>])[] = [
		[
			"columnMean",
			(spec) => {
				const o = parseOptions(SLOT, spec, ColumnMeanOptions);
				return o.ok
					? ok(columnMeanMetric(spec.name ?? spec.kind, o.value.entity, o.value.column))
					: o;
			},
		],
		["cooperationRate", ratioFactory("pd.cooperations")],
		["averagePayoff", ratioFactory("pd.payoff")],
		["stanceAssortativity", groupFactory(assortativityOf)],
		["sameGroupRatio", groupFactory(sameGroupRatioOf)],
		[
			"actionShare",
			(spec: InstrumentSpec, _ctx: PluginContext): Result<Metric, PluginError> => {
				const o = parseOptions(SLOT, spec, ActionShareOptions);
				return o.ok ? ok(actionShareMetric(spec.name ?? spec.kind, o.value.action)) : o;
			},
		],
		[
			"tvdToTarget",
			(spec) => {
				const o = parseOptions(SLOT, spec, TvdOptions);
				return o.ok ? ok(tvdToTargetMetric(spec.name ?? spec.kind, o.value)) : o;
			},
		],
	];
	for (const [kind, factory] of factories) {
		const registered = registry.metrics.register(kind, factory);
		if (!registered.ok) return registered;
	}
	return ok(undefined);
};
