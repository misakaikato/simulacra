// Internal write handle shared only between world.ts and resolver.ts.
// It bypasses applyEffects, the sole public write entry, so it must never be
// re-exported from src/index.ts or any other public module.
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
