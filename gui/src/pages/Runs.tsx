import { useCallback, useState, type FormEvent } from "react";
import { api, type AuditSummary, type ProviderChoice, type RunSummary } from "../api";
import { Empty, ErrorBar, Loading, StatusBadge } from "../components/Primitives";
import { errorMessage } from "../format";
import { useInterval, useLoad, type Loadable } from "../hooks";

export const runHash = (id: string): string => `#/runs/${encodeURIComponent(id)}`;
export const auditHash = (id: string): string => `#/audits/${encodeURIComponent(id)}`;

const MISSING = "–";

const Progress = ({ tick, ticks }: { readonly tick: number; readonly ticks: number }) => (
	<span className="progress-cell">
		<span className="progress">
			<span style={{ width: `${ticks > 0 ? Math.min(100, (tick / ticks) * 100) : 0}%` }} />
		</span>
		<span className="mono">
			{tick} / {ticks}
		</span>
	</span>
);

const RunsTable = ({ runs }: { readonly runs: Loadable<readonly RunSummary[]> }) => {
	if (runs.error !== undefined) return <ErrorBar message={runs.error} />;
	if (runs.data === undefined) return <Loading />;
	if (runs.data.length === 0) return <Empty label="No runs yet. Start one from the form." />;
	return (
		<table className="table">
			<thead>
				<tr>
					<th>run</th>
					<th>status</th>
					<th>progress</th>
					<th className="num">agents</th>
					<th className="num">LLM calls</th>
					<th>complete</th>
					<th className="num">rejected</th>
				</tr>
			</thead>
			<tbody>
				{runs.data.map((r) => (
					<tr key={r.runId}>
						<td>
							<a className="mono" href={runHash(r.runId)}>
								{r.runId}
							</a>
						</td>
						<td>
							<StatusBadge status={r.progress.status} />
						</td>
						<td>
							<Progress tick={r.progress.tick} ticks={r.progress.ticks} />
						</td>
						<td className="num">{r.agentCount}</td>
						<td className="num">{r.result?.cost.llmCalls ?? MISSING}</td>
						<td>
							{r.result === undefined ? (
								MISSING
							) : (
								<span className={r.result.integrity.complete ? "ok" : "danger"}>
									{String(r.result.integrity.complete)}
								</span>
							)}
						</td>
						<td className="num">{r.result?.integrity.rejectedActions ?? MISSING}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
};

const AuditsTable = ({ audits }: { readonly audits: Loadable<readonly AuditSummary[]> }) => {
	if (audits.error !== undefined) return <ErrorBar message={audits.error} />;
	if (audits.data === undefined) return <Loading />;
	if (audits.data.length === 0) return <Empty label="No audits yet" />;
	return (
		<table className="table">
			<thead>
				<tr>
					<th>audit</th>
					<th>status</th>
					<th>progress</th>
					<th>evidence</th>
					<th className="num">conditions</th>
					<th className="num">pairwise</th>
				</tr>
			</thead>
			<tbody>
				{audits.data.map((a) => (
					<tr key={a.auditId}>
						<td>
							<a className="mono" href={auditHash(a.auditId)}>
								{a.auditId}
							</a>
						</td>
						<td>
							<StatusBadge status={a.progress.status} />
						</td>
						<td>
							<Progress tick={a.progress.completed} ticks={a.progress.total} />
						</td>
						<td>{a.report?.evidenceGrade ?? MISSING}</td>
						<td className="num">{a.report?.conditions.length ?? MISSING}</td>
						<td className="num">{a.report?.pairwise.length ?? MISSING}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
};

const NewRunForm = ({ onCreated }: { readonly onCreated: (runId: string) => void }) => {
	const examples = useLoad(api.examples, []);
	const [example, setExample] = useState("");
	const [yaml, setYaml] = useState("");
	const [seed, setSeed] = useState("1");
	const [ticks, setTicks] = useState("");
	const [provider, setProvider] = useState<ProviderChoice>("mock");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const pickExample = (name: string): void => {
		setExample(name);
		const found = examples.data?.find((e) => e.name === name);
		if (found !== undefined) setYaml(found.yaml);
	};

	const submit = async (e: FormEvent): Promise<void> => {
		e.preventDefault();
		const seedValue = Number(seed);
		if (seed.trim() === "" || !Number.isInteger(seedValue)) {
			setError("seed must be an integer");
			return;
		}
		if (yaml.trim() === "") {
			setError("scenario YAML is empty");
			return;
		}
		const ticksValue = ticks.trim() === "" ? undefined : Number(ticks);
		if (ticksValue !== undefined && (!Number.isInteger(ticksValue) || ticksValue <= 0)) {
			setError("ticks must be a positive integer");
			return;
		}
		setSubmitting(true);
		setError(undefined);
		try {
			const { runId } = await api.createRun({
				scenario: yaml,
				seed: seedValue,
				provider,
				...(ticksValue === undefined ? {} : { ticks: ticksValue }),
			});
			onCreated(runId);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form className="form" onSubmit={(e) => void submit(e)}>
			<label>
				Example
				<select value={example} onChange={(e) => pickExample(e.target.value)}>
					<option value="">paste YAML below</option>
					{(examples.data ?? []).map((ex) => (
						<option key={ex.name} value={ex.name}>
							{ex.name}
						</option>
					))}
				</select>
			</label>
			{examples.error !== undefined && <ErrorBar message={examples.error} />}
			<label>
				Scenario YAML
				<textarea
					className="mono"
					rows={14}
					value={yaml}
					onChange={(e) => setYaml(e.target.value)}
					spellCheck={false}
					placeholder="scenarioId: ..."
				/>
			</label>
			<div className="form-row">
				<label>
					Seed
					<input
						className="mono"
						inputMode="numeric"
						value={seed}
						onChange={(e) => setSeed(e.target.value)}
					/>
				</label>
				<label>
					Ticks
					<input
						className="mono"
						inputMode="numeric"
						value={ticks}
						onChange={(e) => setTicks(e.target.value)}
						placeholder="scenario default"
					/>
				</label>
				<label>
					Provider
					<select
						value={provider}
						onChange={(e) => setProvider(e.target.value === "llm" ? "llm" : "mock")}
					>
						<option value="mock">mock</option>
						<option value="llm">llm</option>
					</select>
				</label>
			</div>
			{error !== undefined && <ErrorBar message={error} />}
			<button type="submit" className="primary" disabled={submitting}>
				{submitting ? "Starting" : "Start run"}
			</button>
		</form>
	);
};

export const Runs = () => {
	const runs = useLoad(api.runs, []);
	const audits = useLoad(api.audits, []);
	const running =
		(runs.data?.some((r) => r.progress.status === "running") ?? false) ||
		(audits.data?.some((a) => a.progress.status === "running") ?? false);
	const reloadRuns = runs.reload;
	const reloadAudits = audits.reload;
	const reload = useCallback(() => {
		reloadRuns();
		reloadAudits();
	}, [reloadRuns, reloadAudits]);
	useInterval(reload, running ? 3000 : null);
	return (
		<div className="page">
			<div className="runs-grid">
				<div className="stack">
					<section className="panel">
						<h3>Runs</h3>
						<RunsTable runs={runs} />
					</section>
					<section className="panel">
						<h3>Audits</h3>
						<AuditsTable audits={audits} />
					</section>
				</div>
				<aside>
					<section className="panel">
						<h3>New run</h3>
						<NewRunForm
							onCreated={(id) => {
								location.hash = runHash(id);
							}}
						/>
					</section>
				</aside>
			</div>
		</div>
	);
};
