import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { hashOf } from "./hash";
import { err, ok } from "./result";
import { ScenarioSchema } from "./schema";
import type { JsonValue, Result, Scenario } from "./types";

export type ScenarioIssue = z.ZodIssue;

export const parseScenario = (value: unknown): Result<Scenario, readonly ScenarioIssue[]> => {
	const parsed = ScenarioSchema.safeParse(value);
	return parsed.success ? ok(parsed.data) : err(parsed.error.issues);
};

export const parseScenarioYaml = (text: string): Result<Scenario, readonly ScenarioIssue[]> => {
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err([{ code: "custom", path: [], message: `YAML: ${message}`, input: text }]);
	}
	return parseScenario(doc);
};

export const resolveScenarioPlugins = (scenario: Scenario, baseDir: string): Scenario =>
	scenario.plugins === undefined
		? scenario
		: { ...scenario, plugins: scenario.plugins.map((p) => resolve(baseDir, p)) };

export const spawnReplications = (s: Scenario, n: number): readonly Scenario[] =>
	Array.from({ length: n }, (_, i) => ({
		...s,
		replicationId: i,
		seedPath: [...s.seedPath, i],
	}));

export interface UnknownOverride {
	readonly kind: "UnknownOverride";
	readonly path: string;
}

export interface InvalidOverride {
	readonly kind: "InvalidOverride";
	readonly path: string;
	readonly issues: readonly ScenarioIssue[];
}

export type OverrideError = UnknownOverride | InvalidOverride;

type Container = Record<string, unknown> | unknown[];

const isContainer = (v: unknown): v is Container => typeof v === "object" && v !== null;

const hasKey = (c: Container, key: string): boolean =>
	Array.isArray(c)
		? /^\d+$/.test(key) && Number(key) < c.length
		: Object.prototype.hasOwnProperty.call(c, key);

const read = (c: Container, key: string): unknown =>
	Array.isArray(c) ? c[Number(key)] : (c as Record<string, unknown>)[key];

const cloneWith = (c: Container, key: string, value: unknown): Container => {
	if (Array.isArray(c)) {
		const copy = [...c];
		copy[Number(key)] = value;
		return copy;
	}
	return { ...c, [key]: value };
};

const setPath = (
	root: Container,
	segments: readonly string[],
	value: unknown,
): Container | undefined => {
	if (segments.length === 0) return undefined;
	const [head, ...rest] = segments;
	if (head === undefined) return undefined;
	if (rest.length === 0) return hasKey(root, head) ? cloneWith(root, head, value) : undefined;
	if (hasKey(root, head)) {
		const child = read(root, head);
		if (isContainer(child)) {
			const updated = setPath(child, rest, value);
			if (updated !== undefined) return cloneWith(root, head, updated);
		}
	}
	const flat = segments.join(".");
	return hasKey(root, flat) ? cloneWith(root, flat, value) : undefined;
};

export const overrideScenario = (
	s: Scenario,
	dotted: string,
	value: JsonValue,
): Result<Scenario, OverrideError> => {
	const segments = dotted.split(".").filter((seg) => seg.length > 0);
	const root: Record<string, unknown> = { ...s };
	const fromRoot = setPath(root, segments, value);
	const updated =
		fromRoot ??
		(() => {
			const params = setPath({ ...s.params }, segments, value);
			return params === undefined ? undefined : { ...root, params };
		})();
	if (updated === undefined) return err({ kind: "UnknownOverride", path: dotted });
	const parsed = ScenarioSchema.safeParse(updated);
	if (!parsed.success)
		return err({ kind: "InvalidOverride", path: dotted, issues: parsed.error.issues });
	return ok(parsed.data);
};

export const scenarioHash = (s: Scenario): string => {
	const { replicationId: _replicationId, seedPath: _seedPath, ...rest } = s;
	return hashOf(rest);
};
