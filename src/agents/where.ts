import { z } from "zod";
import { ScalarSchema } from "../core/schema";
import type { Scalar } from "../core/types";

export const WhereSchema = z.record(z.string().min(1), ScalarSchema);

export type Where = Readonly<Record<string, Scalar>>;

const sameScalar = (a: Scalar | undefined, b: Scalar): boolean =>
	a !== undefined && JSON.stringify(a) === JSON.stringify(b);

// An executor without a where clause owns every row; with one it owns the rows whose
// listed columns all equal the given values.
export const matchesWhere = (
	row: Readonly<Record<string, Scalar>> | undefined,
	where: Where | undefined,
): boolean => {
	if (where === undefined) return true;
	if (row === undefined) return false;
	return Object.entries(where).every(([column, value]) => sameScalar(row[column], value));
};
