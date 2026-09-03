// LLMSpec presets: DeepSeek with reasoning disabled by default so the completion budget goes to
// the answer, MLX-LM (prompt mode, no seed field) and LM Studio.
// LLMSpec 预设：DeepSeek 默认关闭推理，让补全预算用于回答本身；MLX-LM（prompt 模式、不发 seed 字段）
// 与 LM Studio。

import { LLMSpecSchema } from "../core/schema";
import type { LLMSpec } from "../core/types";

const LOCAL_CONCURRENCY = { initial: 4, max: 8 } as const;
const LOCAL_MODEL = "default";

// Reasoning tokens count against max_tokens; with it enabled a small budget yields an empty
// structured answer, which the gateway reports as truncated.
// 推理 token 计入 max_tokens；开启时小预算会得到空的结构化回答，网关将其报告为 truncated。
export const DEEPSEEK_EXTRA = { thinking: { type: "disabled" } } as const;

export const deepseek = (): LLMSpec =>
	LLMSpecSchema.parse({
		baseUrl: "https://api.deepseek.com/v1",
		model: "deepseek-v4-flash",
		extra: DEEPSEEK_EXTRA,
	});

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
