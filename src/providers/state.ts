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
