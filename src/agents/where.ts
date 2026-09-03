// Row filter shared by executors: a `where` clause maps column names to scalar values and
// decides which agents an executor owns, so several executors can split one entity by column.
// 执行体共用的行过滤器：`where` 子句把列名映射到标量值，决定执行体拥有哪些 agent，
// 多个执行体因此可以按列瓜分同一实体。

import { z } from "zod";
import { ScalarSchema } from "../core/schema";
import type { Scalar } from "../core/types";

export const WhereSchema = z.record(z.string().min(1), ScalarSchema);

export type Where = Readonly<Record<string, Scalar>>;

const sameScalar = (a: Scalar | undefined, b: Scalar): boolean =>
	a !== undefined && JSON.stringify(a) === JSON.stringify(b);

// An executor without a where clause owns every row; with one it owns the rows whose
// listed columns all equal the given values.
// 没有 where 子句的执行体拥有全部行；有则只拥有所列各列都等于给定值的行。
export const matchesWhere = (
	row: Readonly<Record<string, Scalar>> | undefined,
	where: Where | undefined,
): boolean => {
	if (where === undefined) return true;
	if (row === undefined) return false;
	return Object.entries(where).every(([column, value]) => sameScalar(row[column], value));
};
