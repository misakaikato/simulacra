// Bottom-right panel of the run page: integrity counters, cost, scenario hash, seed and log
// path from the RunResult, plus the failure when the run failed; available once the run ended.
// 运行页右下面板：RunResult 里的完整性计数、成本、场景哈希、种子与日志路径，运行失败时
// 还有失败信息；运行结束后才可用。

import { Fragment } from "react";
import type { Cost, Integrity } from "../../../src/core/types";
import type { RunSummary } from "../api";
import { millis, short } from "../format";
import { Empty } from "./Primitives";

// Key lists are typed against Integrity and Cost so a renamed field fails to compile instead of
// silently vanishing from the panel.
// 键列表按 Integrity 与 Cost 类型约束，字段改名会编译失败，而不是悄悄从面板消失。
const INTEGRITY_KEYS = [
	"activated",
	"ok",
	"failed",
	"parseFailures",
	"llmCalls",
	"llmFailures",
	"droppedEffects",
	"rejectedActions",
] as const satisfies readonly (keyof Integrity)[];

const COST_KEYS = [
	"llmCalls",
	"promptTokens",
	"completionTokens",
	"cachedTokens",
] as const satisfies readonly (keyof Cost)[];

export const CostList = ({ cost }: { readonly cost: Cost }) => (
	<dl className="kv">
		{COST_KEYS.map((k) => (
			<Fragment key={k}>
				<dt>{k}</dt>
				<dd className="mono">{cost[k]}</dd>
			</Fragment>
		))}
		<dt>wall</dt>
		<dd className="mono">{millis(cost.wallMs)}</dd>
	</dl>
);

export const IntegrityPanel = ({ summary }: { readonly summary: RunSummary }) => {
	const result = summary.result;
	return (
		<div className="integrity">
			<div className="pane-title">Integrity and cost</div>
			{result === undefined ? (
				<Empty label="Available when the run finishes" small />
			) : (
				<>
					<div className="kv-cols">
						<dl className="kv">
							<dt>complete</dt>
							<dd className={`mono ${result.integrity.complete ? "ok" : "danger"}`}>
								{String(result.integrity.complete)}
							</dd>
							{INTEGRITY_KEYS.map((k) => (
								<Fragment key={k}>
									<dt>{k}</dt>
									<dd className="mono">{result.integrity[k]}</dd>
								</Fragment>
							))}
						</dl>
						<div>
							<CostList cost={result.cost} />
							<dl className="kv">
								<dt>scenario</dt>
								<dd className="mono" title={result.scenarioHash}>
									{short(result.scenarioHash, 12)}
								</dd>
								<dt>seed</dt>
								<dd className="mono">{result.seed}</dd>
								<dt>log</dt>
								<dd className="mono" title={result.logPath}>
									{short(result.logPath, 28)}
								</dd>
							</dl>
						</div>
					</div>
					{result.failure !== undefined && (
						<div className="error-bar">
							<strong>{result.failure.stage}</strong> {result.failure.excType}:{" "}
							{result.failure.message}
						</div>
					)}
				</>
			)}
		</div>
	);
};
