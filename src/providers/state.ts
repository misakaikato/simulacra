// Minimal checkpoint state shared by stateless providers: only the seed path handed to reset,
// so a restored provider derives the same rng streams as the original run.
// 无状态提供者共用的最小检查点状态：只保存 reset 时收到的种子路径，
// 恢复后的提供者能派生与原运行相同的随机流。

import { z } from "zod";
import type { JsonValue } from "../core/types";

const SeedPathState = z.object({ seedPath: z.array(z.number()) });

export const seedPathState = (seedPath: readonly number[]): JsonValue => ({
	seedPath: [...seedPath],
});

export const readSeedPathState = (s: JsonValue): readonly number[] | undefined => {
	const parsed = SeedPathState.safeParse(s);
	return parsed.success ? parsed.data.seedPath : undefined;
};
