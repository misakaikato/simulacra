import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { toEntityId, toEventId } from "./ids";
import type { World } from "./protocols";
import { err, ok } from "./result";
import {
	CheckpointMetaSchema,
	ClockStateSchema,
	JsonObjectSchema,
	JsonValueSchema,
	WorldSnapshotSchema,
} from "./schema";
import type { EventId, JsonObject, JsonValue, LogicalTime, Result, WorldSnapshot } from "./types";
import { restoreWorld } from "./world";

export const CHECKPOINT_FILES = {
	world: "world.json",
	clock: "clock.json",
	executors: "executors.json",
	providers: "providers.json",
	modules: "modules.json",
	rng: "rng.json",
	meta: "meta.json",
} as const;

export interface CheckpointInput {
	readonly world: World;
	readonly clock: { readonly now: LogicalTime };
	readonly executors: JsonObject;
	readonly providers: JsonObject;
	readonly modules?: JsonObject;
	readonly rngPaths: JsonValue;
	readonly scenarioHash: string;
	readonly digest: string;
	readonly lastEventId: EventId;
}

export interface CheckpointState {
	readonly world: World;
	readonly clock: { readonly now: LogicalTime };
	readonly executors: JsonObject;
	readonly providers: JsonObject;
	readonly modules: JsonObject;
	readonly rngPaths: JsonValue;
	readonly scenarioHash: string;
	readonly digest: string;
	readonly lastEventId: EventId;
	readonly worldHash: string;
}

export type CheckpointError = {
	readonly kind: "ConfigDrift" | "Corrupt";
	readonly message: string;
};

const describeError = (e: unknown): string =>
	e instanceof Error ? `${e.name}: ${e.message}` : String(e);

export const saveCheckpoint = (
	state: CheckpointInput,
	dir: string,
): Result<{ readonly worldHash: string }, string> => {
	const { now } = state.clock;
	if (now.substep !== 0 || now.seq !== 0)
		return err(
			`checkpoint requires a tick boundary, clock is at ${now.tick}.${now.substep}.${now.seq}`,
		);
	const worldHash = state.world.hash();
	const files: Readonly<Record<keyof typeof CHECKPOINT_FILES, unknown>> = {
		world: state.world.snapshot(),
		clock: { now },
		executors: state.executors,
		providers: state.providers,
		modules: state.modules ?? {},
		rng: state.rngPaths,
		meta: {
			version: 1,
			scenarioHash: state.scenarioHash,
			digest: state.digest,
			lastEventId: state.lastEventId,
			worldHash,
			tick: now.tick,
		},
	};
	try {
		mkdirSync(dir, { recursive: true });
		for (const [key, name] of Object.entries(CHECKPOINT_FILES)) {
			writeFileSync(
				join(dir, name),
				JSON.stringify(files[key as keyof typeof CHECKPOINT_FILES]),
			);
		}
	} catch (e) {
		return err(`write checkpoint ${dir}: ${describeError(e)}`);
	}
	return ok({ worldHash });
};

const readJson = <S extends z.ZodType>(
	dir: string,
	name: string,
	schema: S,
): Result<z.output<S>, CheckpointError> => {
	let text: string;
	try {
		text = readFileSync(join(dir, name), "utf8");
	} catch (e) {
		return err({ kind: "Corrupt", message: `${name}: ${describeError(e)}` });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return err({ kind: "Corrupt", message: `${name}: ${describeError(e)}` });
	}
	const checked = schema.safeParse(parsed);
	if (!checked.success)
		return err({
			kind: "Corrupt",
			message: `${name}: ${checked.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
		});
	return ok(checked.data);
};

export const loadCheckpoint = (
	dir: string,
	scenarioHash: string,
): Result<CheckpointState, CheckpointError> => {
	const meta = readJson(dir, CHECKPOINT_FILES.meta, CheckpointMetaSchema);
	if (!meta.ok) return meta;
	if (meta.value.scenarioHash !== scenarioHash)
		return err({
			kind: "ConfigDrift",
			message: `checkpoint was written for scenario ${meta.value.scenarioHash}, current scenario is ${scenarioHash}`,
		});
	const snapshot = readJson(dir, CHECKPOINT_FILES.world, WorldSnapshotSchema);
	if (!snapshot.ok) return snapshot;
	const clock = readJson(dir, CHECKPOINT_FILES.clock, ClockStateSchema);
	if (!clock.ok) return clock;
	const executors = readJson(dir, CHECKPOINT_FILES.executors, JsonObjectSchema);
	if (!executors.ok) return executors;
	const providers = readJson(dir, CHECKPOINT_FILES.providers, JsonObjectSchema);
	if (!providers.ok) return providers;
	const modules = readJson(dir, CHECKPOINT_FILES.modules, JsonObjectSchema);
	if (!modules.ok) return modules;
	const rngPaths = readJson(dir, CHECKPOINT_FILES.rng, JsonValueSchema);
	if (!rngPaths.ok) return rngPaths;
	const worldSnapshot: WorldSnapshot = {
		version: 1,
		entities: snapshot.value.entities.map((e) => ({ ...e, ids: e.ids.map(toEntityId) })),
		env: snapshot.value.env,
	};
	let world: World;
	try {
		world = restoreWorld(worldSnapshot);
	} catch (e) {
		return err({ kind: "Corrupt", message: `world.json: ${describeError(e)}` });
	}
	const worldHash = world.hash();
	if (worldHash !== meta.value.worldHash)
		return err({
			kind: "Corrupt",
			message: `world.json hashes to ${worldHash}, meta.json expects ${meta.value.worldHash}`,
		});
	if (clock.value.now.tick !== meta.value.tick)
		return err({
			kind: "Corrupt",
			message: `clock.json is at tick ${clock.value.now.tick}, meta.json expects ${meta.value.tick}`,
		});
	return ok({
		world,
		clock: clock.value,
		executors: executors.value,
		providers: providers.value,
		modules: modules.value,
		rngPaths: rngPaths.value,
		scenarioHash: meta.value.scenarioHash,
		digest: meta.value.digest,
		lastEventId: toEventId(meta.value.lastEventId),
		worldHash,
	});
};
