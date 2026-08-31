import { loadCheckpoint } from "./checkpoint";
import { ZERO_EVENT_ID } from "./ids";
import type { EventLog, World } from "./protocols";
import { applyEffects } from "./resolver";
import { err, ok } from "./result";
import { checkpointDirOf, checkpointTicks, readRunScenario, withRunLog } from "./runDir";
import { scenarioHash } from "./scenario";
import type { Effect, Event, EventId, JsonValue, Result } from "./types";

export interface ReplayResult {
	readonly worldHash: string;
	readonly tick: number;
	readonly fromTick: number;
	readonly folded: number;
}

const EFFECT_OPS: readonly string[] = [
	"set",
	"inc",
	"append",
	"create",
	"delete",
	"envSet",
	"setColumn",
];

const isObject = (v: JsonValue): v is { readonly [k: string]: JsonValue } =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const isEffect = (v: JsonValue): v is Effect =>
	isObject(v) && typeof v.op === "string" && EFFECT_OPS.includes(v.op);

export const recordedEffects = (e: Event): readonly Effect[] => {
	if (e.kind === "effect") return e.payload.effects;
	if (e.kind !== "module_step" || !isObject(e.payload.summary)) return [];
	const effects = e.payload.summary.effects;
	return Array.isArray(effects) ? effects.filter(isEffect) : [];
};

export const replayEvents = (
	log: EventLog,
	world: World,
	afterEventId: EventId,
	fromTick: number,
	toTick: number | undefined,
): ReplayResult => {
	let past = afterEventId === ZERO_EVENT_ID;
	let folded = 0;
	let reached = fromTick;
	for (const e of log.query({})) {
		if (!past) {
			if (e.eventId === afterEventId) past = true;
			continue;
		}
		if (toTick !== undefined && e.t.tick >= toTick) break;
		const effects = recordedEffects(e);
		if (effects.length === 0) continue;
		applyEffects(world, effects, e.t);
		folded += effects.length;
		reached = Math.max(reached, e.t.tick + 1);
	}
	return {
		worldHash: world.hash(),
		tick: toTick === undefined ? reached : Math.min(toTick, reached),
		fromTick,
		folded,
	};
};

export const replayRun = (runDir: string, toTick?: number): Result<ReplayResult, string> => {
	if (toTick !== undefined && (!Number.isInteger(toTick) || toTick < 0))
		return err(`toTick must be a non-negative integer, got ${toTick}`);
	const scenario = readRunScenario(runDir);
	if (!scenario.ok) return scenario;
	const [start] = checkpointTicks(runDir).filter((t) => toTick === undefined || t <= toTick);
	if (start === undefined)
		return err(
			toTick === undefined
				? `${runDir} has no checkpoints`
				: `${runDir} has no checkpoint at or before tick ${toTick}`,
		);
	const checkpoint = loadCheckpoint(checkpointDirOf(runDir, start), scenarioHash(scenario.value));
	if (!checkpoint.ok) return err(`tick ${start} checkpoint: ${checkpoint.error.message}`);
	return withRunLog(runDir, (log) =>
		ok(replayEvents(log, checkpoint.value.world, checkpoint.value.lastEventId, start, toTick)),
	);
};
