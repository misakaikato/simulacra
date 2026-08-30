import { z } from "zod";
import type {
	ActionDef,
	ActionRegistry,
	DuplicateAction,
	DuplicateFallback,
	ValidationFailure,
} from "./protocols";
import { err, ok } from "./result";
import type { ActionCall, JsonObject, JsonValue, Result } from "./types";

export const defineAction = <P extends z.ZodType>(def: ActionDef<P>): ActionDef<P> => def;

const withDescription = (schema: z.ZodType, node: JsonObject): JsonObject =>
	schema.description === undefined ? node : { ...node, description: schema.description };

const isJsonValue = (v: unknown): v is JsonValue => {
	if (v === null) return true;
	switch (typeof v) {
		case "string":
		case "number":
		case "boolean":
			return true;
		case "object":
			return Array.isArray(v)
				? v.every(isJsonValue)
				: Object.values(v as Record<string, unknown>).every(isJsonValue);
		default:
			return false;
	}
};

const classic = (inner: unknown): z.ZodType => {
	if (inner instanceof z.ZodType) return inner;
	throw new TypeError("nested schema is not a zod classic schema");
};

const convert = (schema: z.ZodType): JsonObject => {
	if (schema instanceof z.ZodOptional) return convert(classic(schema.unwrap()));
	if (schema instanceof z.ZodDefault) {
		const fallback: unknown = schema.def.defaultValue;
		const inner = convert(classic(schema.def.innerType));
		return isJsonValue(fallback) ? { ...inner, default: fallback } : inner;
	}
	if (schema instanceof z.ZodObject) {
		const properties: Record<string, JsonValue> = {};
		const required: string[] = [];
		for (const [key, sub] of Object.entries(schema.shape)) {
			const child = classic(sub);
			properties[key] = convert(child);
			if (!(child instanceof z.ZodOptional) && !(child instanceof z.ZodDefault))
				required.push(key);
		}
		return withDescription(schema, {
			type: "object",
			properties,
			required,
			additionalProperties: false,
		});
	}
	if (schema instanceof z.ZodString) return withDescription(schema, { type: "string" });
	if (schema instanceof z.ZodNumber)
		return withDescription(schema, { type: schema.isInt ? "integer" : "number" });
	if (schema instanceof z.ZodBoolean) return withDescription(schema, { type: "boolean" });
	if (schema instanceof z.ZodEnum)
		return withDescription(schema, { type: "string", enum: schema.options.map(String) });
	if (schema instanceof z.ZodLiteral) {
		const value: unknown = schema.value;
		if (!isJsonValue(value)) throw new TypeError("literal value is not JSON-compatible");
		return withDescription(schema, { const: value });
	}
	if (schema instanceof z.ZodArray)
		return withDescription(schema, { type: "array", items: convert(classic(schema.element)) });
	throw new TypeError(`unsupported zod type ${schema.constructor.name} in action parameters`);
};

export const zodToJsonSchema = (schema: z.ZodType): JsonObject => convert(schema);

export const toolSchema = (def: ActionDef): JsonObject => ({
	type: "function",
	function: {
		name: def.name,
		description: def.description,
		parameters: zodToJsonSchema(def.params),
	},
});

class MapActionRegistry implements ActionRegistry {
	private readonly defs = new Map<string, ActionDef>();
	private readonly schemas = new Map<string, JsonObject>();
	private fallbackName: string | undefined;

	register(a: ActionDef): Result<void, DuplicateAction | DuplicateFallback> {
		if (this.defs.has(a.name)) return err({ kind: "DuplicateAction", name: a.name });
		if (a.fallback && this.fallbackName !== undefined)
			return err({ kind: "DuplicateFallback", name: a.name, existing: this.fallbackName });
		if (!(a.params instanceof z.ZodObject))
			throw new TypeError(`action '${a.name}': params must be a zod object schema`);
		const schema = toolSchema(a);
		this.defs.set(a.name, a);
		this.schemas.set(a.name, schema);
		if (a.fallback) this.fallbackName = a.name;
		return ok(undefined);
	}

	get(name: string): ActionDef | undefined {
		return this.defs.get(name);
	}

	names(): readonly string[] {
		return [...this.defs.keys()];
	}

	fallback(): ActionDef | undefined {
		return this.fallbackName === undefined ? undefined : this.defs.get(this.fallbackName);
	}

	toolSchemas(names: readonly string[]): readonly JsonValue[] {
		return names.map((name) => {
			const schema = this.schemas.get(name);
			if (schema === undefined) throw new RangeError(`unknown action '${name}'`);
			return schema;
		});
	}

	validate(call: ActionCall): Result<ActionCall, ValidationFailure> {
		const def = this.defs.get(call.name);
		if (def === undefined) return err({ kind: "UnknownAction", name: call.name });
		const parsed = def.params.safeParse(call.args);
		if (!parsed.success)
			return err({
				kind: "InvalidArgs",
				name: call.name,
				issues: parsed.error.issues.map((i) => ({
					path: i.path.map(String).join("."),
					message: i.message,
				})),
			});
		return ok({ ...call, args: parsed.data as JsonObject });
	}
}

export const createActionRegistry = (): ActionRegistry => new MapActionRegistry();
