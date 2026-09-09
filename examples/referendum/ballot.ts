// Plugin of the referendum example: one metric that turns the ballot questionnaire's per-agent
// answers into a single support share the audit can compare across conditions. Questionnaire
// answers are measurement events rather than world state, so the metric reads them back out of
// the event log, restricted to the latest tick the ballot ran at.
// 公投示例的插件：一个指标，把选票问卷的逐 agent 答案汇成审计可以跨条件比较的支持率。问卷答案是
// measurement 事件而非世界状态，因此指标从事件日志读回，并限定在选票最近一次运行的 tick 上。

import { z } from "zod";
import {
	ok,
	parseOptions,
	type DuplicatePlugin,
	type Metric,
	type PluginContext,
	type PluginError,
	type PluginSpec,
	type Registry,
	type Result,
} from "../../src/index";

export const SUPPORT_SHARE_KIND = "supportShare";

const Options = z.object({
	instrument: z.string().min(1).default("ballot"),
	question: z.string().min(1).default("vote"),
	choice: z.string().min(1).default("support"),
});

// The inner select pins the tick, so a scenario that runs the ballot twice reports the last one
// and the value stays stable on every later tick.
// 内层 select 锁定 tick，因此跑两次选票的场景报告的是最后一次，且之后每个 tick 该值都保持不变。
const SQL = `
	select json_extract(payload, '$.value') as value, count(*) as n
	from events
	where kind = 'measurement'
	  and json_extract(payload, '$.instrument') = ?1
	  and json_extract(payload, '$.name') = ?2
	  and tick = (
	    select max(tick) from events
	    where kind = 'measurement'
	      and json_extract(payload, '$.instrument') = ?1
	      and json_extract(payload, '$.name') = ?2
	  )
	group by value
`;

export const createSupportShare = (
	spec: PluginSpec,
	ctx: PluginContext,
): Result<Metric, PluginError> => {
	const options = parseOptions(ctx.registry.metrics.slot, spec, Options);
	if (!options.ok) return options;
	const { instrument, question, choice } = options.value;
	return ok({
		name: spec.name ?? spec.kind,
		compute: (_view, log) => {
			const rows = log.sql<{ value: string; n: number }>(SQL, [instrument, question]);
			const total = rows.reduce((acc, row) => acc + row.n, 0);
			return total === 0 ? 0 : (rows.find((row) => row.value === choice)?.n ?? 0) / total;
		},
	});
};

export const register = (registry: Registry): Result<void, DuplicatePlugin> =>
	registry.metrics.register(SUPPORT_SHARE_KIND, createSupportShare);
