// Replay folds effect and module_step events onto a checkpointed world. It starts from the
// latest checkpoint at or before the target tick and skips everything up to that checkpoint's
// lastEventId, so replay(N) is the world at the start of tick N, equal to checkpoints/N.
// 回放把 effect 与 module_step 事件折叠到检查点世界上。起点是不晚于目标 tick 的最近检查点，
// 并跳过该检查点 lastEventId 之前的全部事件，replay(N) 因此是 tick N 开始时的世界，与 checkpoints/N 相等。

import { loadCheckpoint } from "./checkpoint";
import { ZERO_EVENT_ID } from "./ids";
import type { EventLog, World, WorldView } from "./protocols";
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

export interface ReplayedWorld extends ReplayResult {
	readonly world: WorldView;
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

// Only effect and module_step carry world changes; module_step keeps its effects inside
// summary because the event serves inspection first.
// 只有 effect 与 module_step 携带世界变更；module_step 把效果放在 summary 里，因为该事件首先服务于检视。
export const recordedEffects = (e: Event): readonly Effect[] => {
	if (e.kind === "effect") return e.payload.effects;
	if (e.kind !== "module_step" || !isObject(e.payload.summary)) return [];
	const effects = e.payload.summary.effects;
	return Array.isArray(effects) ? effects.filter(isEffect) : [];
};

// Events arrive in (t, eventId) order; folding stops before the first event of toTick so the
// result matches checkpoints/<toTick>. With the zero id nothing precedes the checkpoint.
// 事件按 (t, eventId) 顺序到达；折叠在 toTick 的第一个事件之前停止，结果与 checkpoints/<toTick> 对齐。
// afterEventId 为零 id 表示检查点之前没有任何事件。
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

// The latest checkpoint at or before toTick minimises folding; a resumed run's directory may
// lack a tick 0 checkpoint, hence a search rather than a fixed start.
// 选不晚于 toTick 的最近检查点以减少折叠量；续跑的输出目录可能没有 tick 0 检查点，所以是搜索
// 而不是固定起点。
export const replayWorld = (runDir: string, toTick?: number): Result<ReplayedWorld, string> => {
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
	const world = checkpoint.value.world;
	return withRunLog(runDir, (log) =>
		ok({
			...replayEvents(log, world, checkpoint.value.lastEventId, start, toTick),
			world,
		}),
	);
};

export const replayRun = (runDir: string, toTick?: number): Result<ReplayResult, string> => {
	const replayed = replayWorld(runDir, toTick);
	if (!replayed.ok) return replayed;
	const { world: _world, ...result } = replayed.value;
	return ok(result);
};
