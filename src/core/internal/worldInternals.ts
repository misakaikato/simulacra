// Internal write handle shared only between world.ts and resolver.ts.
// It bypasses applyEffects, the sole public write entry, so it must never be
// re-exported from src/index.ts or any other public module.
// 只在 world.ts 与 resolver.ts 之间共享的内部写句柄。它绕过唯一的公共写入口 applyEffects，
// 因此绝不能从 src/index.ts 或任何其它公共模块再导出。
import type { World } from "../protocols";
import type { EntityId, JsonValue, Result, Scalar } from "../types";

export interface WorldInternals {
	insertRow(
		entity: string,
		id: EntityId,
		row: Readonly<Record<string, Scalar>>,
	): Result<void, string>;
	deleteRow(entity: string, id: EntityId): Result<void, string>;
	setCell(
		entity: string,
		id: EntityId,
		column: string,
		value: Scalar,
		tick: number,
	): Result<void, string>;
	setCells(
		entity: string,
		column: string,
		ids: readonly EntityId[],
		values: readonly Scalar[],
		tick: number,
	): Result<void, string>;
	incCell(
		entity: string,
		id: EntityId,
		column: string,
		delta: number,
		tick: number,
	): Result<void, string>;
	appendCell(
		entity: string,
		id: EntityId,
		column: string,
		value: string,
		tick: number,
	): Result<void, string>;
	setEnv(key: string, value: JsonValue): void;
}

// The handle is looked up by world instance instead of being a method, so a WorldView handed
// to a plugin carries no way to write.
// 句柄按 world 实例查找而不是作为方法暴露，交给插件的 WorldView 因此没有任何写入途径。
const internals = new WeakMap<World, WorldInternals>();

export const attachInternals = (world: World, handle: WorldInternals): void => {
	internals.set(world, handle);
};

export const internalOf = (world: World): WorldInternals => {
	const found = internals.get(world);
	if (found === undefined)
		throw new TypeError("world was not created by createWorld or restoreWorld");
	return found;
};
