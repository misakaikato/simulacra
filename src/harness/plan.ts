import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { hashOf } from "../core/hash";
import { err, ok } from "../core/result";
import { AuditPlanSchema, ScenarioSchema } from "../core/schema";
import { resolveScenarioPlugins, type ScenarioIssue } from "../core/scenario";
import type { AuditPlan, Result, Scenario } from "../core/types";

export const AuditPlanDocumentSchema = AuditPlanSchema.omit({ base: true })
	.extend({
		base: ScenarioSchema.optional(),
		baseScenario: z.string().min(1).optional(),
	})
	.refine((doc) => (doc.base === undefined) !== (doc.baseScenario === undefined), {
		message: "exactly one of base or baseScenario is required",
		path: ["base"],
	});

export type AuditPlanDocument = z.infer<typeof AuditPlanDocumentSchema>;

export type LoadScenario = (path: string) => Result<Scenario, readonly ScenarioIssue[]>;

export interface ParsePlanOptions {
	readonly baseDir: string;
	readonly loadScenario: LoadScenario;
}

const issue = (path: readonly PropertyKey[], message: string, input: unknown): ScenarioIssue => ({
	code: "custom",
	path: [...path],
	message,
	input,
});

const resolveBase = (
	doc: AuditPlanDocument,
	opts: ParsePlanOptions,
): Result<Scenario, readonly ScenarioIssue[]> => {
	if (doc.baseScenario !== undefined) {
		const path = resolve(opts.baseDir, doc.baseScenario);
		if (!existsSync(path))
			return err([issue(["baseScenario"], `${path}: file not found`, doc.baseScenario)]);
		const loaded = opts.loadScenario(path);
		if (loaded.ok) return loaded;
		return err(loaded.error.map((i) => ({ ...i, path: ["baseScenario", ...i.path] })));
	}
	if (doc.base !== undefined) return ok(resolveScenarioPlugins(doc.base, opts.baseDir));
	return err([issue(["base"], "exactly one of base or baseScenario is required", undefined)]);
};

export const parseAuditPlan = (
	value: unknown,
	opts: ParsePlanOptions,
): Result<AuditPlan, readonly ScenarioIssue[]> => {
	const doc = AuditPlanDocumentSchema.safeParse(value);
	if (!doc.success) return err(doc.error.issues);
	const base = resolveBase(doc.data, opts);
	if (!base.ok) return base;
	const { base: _inline, baseScenario: _path, ...rest } = doc.data;
	const plan = AuditPlanSchema.safeParse({ ...rest, base: base.value });
	return plan.success ? ok(plan.data) : err(plan.error.issues);
};

export const parseAuditPlanYaml = (
	text: string,
	opts: ParsePlanOptions,
): Result<AuditPlan, readonly ScenarioIssue[]> => {
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err([issue([], `YAML: ${message}`, text)]);
	}
	return parseAuditPlan(doc, opts);
};

export const planHash = (plan: AuditPlan): string => {
	const { concurrency: _concurrency, ...rest } = plan;
	return hashOf(rest);
};
