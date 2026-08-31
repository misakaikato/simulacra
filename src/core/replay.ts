import { loadCheckpoint } from "./checkpoint";
import { ZERO_EVENT_ID } from "./ids";
import type { EventLog } from "./protocols";
import { applyEffects } from "./resolver";
import { err, ok } from "./result";
import { checkpointDirOf, readRunScenario, withRunLog } from "./runDir";
import { scenarioHash } from "./scenario";
import type { Effect, Event, JsonValue, Result } from "./types";

export interface ReplayResult {
	readonly worldHash: string;
	readonly tick: number;
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
	world: Parameters<typeof applyEffects>[0],
	afterEventId: Event["eventId"],
	toTick: number | undefined,
): ReplayResult => {
	let past = afterEventId === ZERO_EVENT_ID;
	let folded = 0;
	let lastTick = -1;
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
		lastTick = e.t.tick;
	}
	return { worldHash: world.hash(), tick: toTick ?? lastTick + 1, folded };
};

export const replayRun = (runDir: string, toTick?: number): Result<ReplayResult, string> => {
	const scenario = readRunScenario(runDir);
	if (!scenario.ok) return scenario;
	const checkpoint = loadCheckpoint(checkpointDirOf(runDir, 0), scenarioHash(scenario.value));
	if (!checkpoint.ok) return err(`tick 0 checkpoint: ${checkpoint.error.message}`);
	return withRunLog(runDir, (log) =>
		ok(replayEvents(log, checkpoint.value.world, checkpoint.value.lastEventId, toTick)),
	);
};
