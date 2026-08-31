import { err, ok } from "./result";
import type { JsonObject, JsonValue, PluginSpec, Result, Scenario } from "./types";

export const PARAM_KEY = "$param";
export const MAP_KEY = "map";

export type ParamError =
	| { readonly kind: "UnknownParam"; readonly name: string; readonly path: string }
	| {
			readonly kind: "UnmappedParam";
			readonly name: string;
			readonly value: JsonValue;
			readonly path: string;
	  }
	| { readonly kind: "InvalidParamRef"; readonly path: string; readonly message: string };

const isObject = (v: JsonValue): v is JsonObject =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const mapKeyOf = (value: JsonValue): string | undefined =>
	typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value)
		: undefined;

const resolveRef = (
	ref: JsonObject,
	params: JsonObject,
	path: string,
): Result<JsonValue, ParamError> => {
	const name = ref[PARAM_KEY];
	if (typeof name !== "string" || name.length === 0)
		return err({ kind: "InvalidParamRef", path, message: `${PARAM_KEY} must be a name` });
	const value = params[name];
	if (value === undefined) return err({ kind: "UnknownParam", name, path });
	const map = ref[MAP_KEY];
	if (map === undefined) return ok(value);
	if (!isObject(map))
		return err({ kind: "InvalidParamRef", path, message: `${MAP_KEY} must be an object` });
	const key = mapKeyOf(value);
	const mapped = key === undefined ? undefined : map[key];
	if (mapped === undefined) return err({ kind: "UnmappedParam", name, value, path });
	return ok(mapped);
};

export const resolveParamRefs = (
	value: JsonValue,
	params: JsonObject,
	path = "options",
): Result<JsonValue, ParamError> => {
	if (Array.isArray(value)) {
		const out: JsonValue[] = [];
		for (const [i, item] of value.entries()) {
			const resolved = resolveParamRefs(item, params, `${path}[${i}]`);
			if (!resolved.ok) return resolved;
			out.push(resolved.value);
		}
		return ok(out);
	}
	if (!isObject(value)) return ok(value);
	if (PARAM_KEY in value) return resolveRef(value, params, path);
	const out: Record<string, JsonValue> = {};
	for (const [k, v] of Object.entries(value)) {
		const resolved = resolveParamRefs(v, params, `${path}.${k}`);
		if (!resolved.ok) return resolved;
		out[k] = resolved.value;
	}
	return ok(out);
};

const resolveSpec = <S extends PluginSpec>(
	spec: S,
	params: JsonObject,
	path: string,
): Result<S, ParamError> => {
	if (spec.options === undefined) return ok(spec);
	const resolved = resolveParamRefs(spec.options, params, `${path}.options`);
	if (!resolved.ok) return resolved;
	if (!isObject(resolved.value))
		return err({
			kind: "InvalidParamRef",
			path: `${path}.options`,
			message: "options must resolve to an object",
		});
	return ok({ ...spec, options: resolved.value });
};

const resolveList = <S extends PluginSpec>(
	specs: readonly S[],
	params: JsonObject,
	path: string,
): Result<readonly S[], ParamError> => {
	const out: S[] = [];
	for (const [i, spec] of specs.entries()) {
		const resolved = resolveSpec(spec, params, `${path}[${i}]`);
		if (!resolved.ok) return resolved;
		out.push(resolved.value);
	}
	return ok(out);
};

export const resolveScenarioParams = (scenario: Scenario): Result<Scenario, ParamError> => {
	const params = scenario.params;
	const modules = resolveList(scenario.modules, params, "modules");
	if (!modules.ok) return modules;
	const executors = resolveList(scenario.executors, params, "executors");
	if (!executors.ok) return executors;
	const instruments = resolveList(scenario.instruments, params, "instruments");
	if (!instruments.ok) return instruments;
	const policy = resolveSpec(scenario.policy, params, "policy");
	if (!policy.ok) return policy;
	const providers: Record<string, PluginSpec> = {};
	for (const [name, spec] of Object.entries(scenario.providers)) {
		const resolved = resolveSpec(spec, params, `providers.${name}`);
		if (!resolved.ok) return resolved;
		providers[name] = resolved.value;
	}
	return ok({
		...scenario,
		modules: modules.value,
		executors: executors.value,
		instruments: instruments.value,
		policy: policy.value,
		providers,
	});
};

export const describeParamError = (e: ParamError): string => {
	switch (e.kind) {
		case "UnknownParam":
			return `${e.path}: unknown param '${e.name}'`;
		case "UnmappedParam":
			return `${e.path}: param '${e.name}' = ${JSON.stringify(e.value)} has no map entry`;
		case "InvalidParamRef":
			return `${e.path}: ${e.message}`;
	}
};
