// Plugin registry: one NamedRegistry per slot mapping a kind string to a factory. Registration
// returns a Result so duplicates cannot silently shadow a plugin; parseOptions turns a plugin's
// option-schema failure into a PluginError with paths.
// 插件注册表：每个槽位一个 NamedRegistry，把 kind 字符串映射到工厂。注册返回 Result，重复项不会悄悄
// 遮蔽已有插件；parseOptions 把插件选项 schema 的校验失败转成带路径的 PluginError。

import type { z } from "zod";
import { createActionRegistry } from "./actions";
import type {
	ActivationPolicy,
	Adapter,
	DecisionProvider,
	DuplicatePlugin,
	Executor,
	Metric,
	Module,
	PluginContext,
	PluginError,
	PluginFactory,
	PluginRegistry,
	Questionnaire,
	Registry,
	Transition,
} from "./protocols";
import { err, ok } from "./result";
import type { PluginSpec, Result } from "./types";

class NamedRegistry<T> implements PluginRegistry<T> {
	readonly slot: string;
	private readonly factories = new Map<string, PluginFactory<T>>();

	constructor(slot: string) {
		this.slot = slot;
	}

	register(kind: string, factory: PluginFactory<T>): Result<void, DuplicatePlugin> {
		if (this.factories.has(kind))
			return err({ kind: "DuplicatePlugin", slot: this.slot, pluginKind: kind });
		this.factories.set(kind, factory);
		return ok(undefined);
	}

	get(kind: string): PluginFactory<T> | undefined {
		return this.factories.get(kind);
	}

	has(kind: string): boolean {
		return this.factories.has(kind);
	}

	kinds(): readonly string[] {
		return [...this.factories.keys()];
	}

	create(spec: PluginSpec, ctx: PluginContext): Result<T, PluginError> {
		const factory = this.factories.get(spec.kind);
		if (factory === undefined)
			return err({ reason: "unknown_kind", slot: this.slot, kind: spec.kind });
		return factory(spec, ctx);
	}
}

export const parseOptions = <S extends z.ZodType>(
	slot: string,
	spec: PluginSpec,
	schema: S,
): Result<z.output<S>, PluginError> => {
	const parsed = schema.safeParse(spec.options ?? {});
	if (parsed.success) return ok(parsed.data);
	return err({
		reason: "invalid_options",
		slot,
		kind: spec.kind,
		issues: parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`),
	});
};

export const createRegistry = (): Registry => ({
	actions: createActionRegistry(),
	executors: new NamedRegistry<Executor>("executors"),
	transitions: new NamedRegistry<Transition>("transitions"),
	modules: new NamedRegistry<Module>("modules"),
	providers: new NamedRegistry<DecisionProvider>("providers"),
	policies: new NamedRegistry<ActivationPolicy>("policies"),
	metrics: new NamedRegistry<Metric>("metrics"),
	instruments: new NamedRegistry<Questionnaire>("instruments"),
	adapters: new NamedRegistry<Adapter>("adapters"),
});
