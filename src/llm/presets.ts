import { LLMSpecSchema } from "../core/schema";
import type { LLMSpec } from "../core/types";

const LOCAL_CONCURRENCY = { initial: 4, max: 8 } as const;
const LOCAL_MODEL = "default";

export const deepseek = (): LLMSpec =>
	LLMSpecSchema.parse({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" });

export const mlxLm = (baseUrl: string): LLMSpec =>
	LLMSpecSchema.parse({
		baseUrl,
		model: LOCAL_MODEL,
		concurrency: LOCAL_CONCURRENCY,
		structured: "prompt",
		sendSeed: false,
	});

export const lmStudio = (baseUrl: string): LLMSpec =>
	LLMSpecSchema.parse({ baseUrl, model: LOCAL_MODEL, concurrency: LOCAL_CONCURRENCY });
