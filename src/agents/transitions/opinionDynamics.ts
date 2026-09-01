import { z } from "zod";
import { ZERO_EVENT_ID } from "../../core/ids";
import type { Transition } from "../../core/protocols";
import type { EntityId, Scalar } from "../../core/types";

export const OPINION_DYNAMICS_KIND = "opinionDynamics";

export const OpinionDynamicsOptionsSchema = z.object({
	entity: z.string().min(1).default("agent"),
	rate: z.number().min(0).max(1).default(0.2),
	stanceColumn: z.string().min(1).default("persona.stance"),
	stubbornnessColumn: z.string().min(1).optional(),
	postAction: z.string().min(1).default("post"),
});

export type OpinionDynamicsOptions = z.output<typeof OpinionDynamicsOptionsSchema>;

const numberOf = (v: Scalar | undefined): number | undefined =>
	typeof v === "number" ? v : undefined;

// stance <- stance + rate * (1 - stubbornness) * (mean stance of neighbours who posted - stance)
// Only neighbours whose decision this round is the post action exert influence; silent ones do not.
export const opinionDynamics = (options: OpinionDynamicsOptions): Transition => {
	const { entity, rate, stanceColumn, stubbornnessColumn, postAction } = options;
	return {
		name: OPINION_DYNAMICS_KIND,
		reads:
			stubbornnessColumn === undefined ? [stanceColumn] : [stanceColumn, stubbornnessColumn],
		writes: [stanceColumn],
		apply: (view, ids, decisions, _rng, graph) => {
			if (graph === undefined || ids.length === 0) return [];
			const posters = new Set<EntityId>();
			for (const d of decisions) if (d.action === postAction) posters.add(d.agentId);
			if (posters.size === 0) return [];
			const stance = view.column<Scalar>(entity, stanceColumn);
			const stubbornness =
				stubbornnessColumn === undefined
					? undefined
					: view.column<Scalar>(entity, stubbornnessColumn);
			const updated: EntityId[] = [];
			const values: Scalar[] = [];
			for (const id of ids) {
				let sum = 0;
				let count = 0;
				for (const neighbour of graph.neighbors(id)) {
					if (!posters.has(neighbour)) continue;
					const v = numberOf(stance.get(neighbour));
					if (v === undefined) continue;
					sum += v;
					count += 1;
				}
				if (count === 0) continue;
				const current = numberOf(stance.get(id));
				if (current === undefined) continue;
				const resistance = numberOf(stubbornness?.get(id)) ?? 0;
				const next = current + rate * (1 - resistance) * (sum / count - current);
				if (next === current) continue;
				updated.push(id);
				values.push(next);
			}
			if (updated.length === 0) return [];
			return [
				{
					op: "setColumn",
					entity,
					column: stanceColumn,
					ids: updated,
					values,
					cause: ZERO_EVENT_ID,
				},
			];
		},
	};
};
