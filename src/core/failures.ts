// The closed vocabulary of failure excType values written by the kernel, the gateway and the
// built-in plugins. Integrity counting and tests match on these strings, so nothing invents
// its own.
// 内核、网关与内置插件写入的 failure excType 封闭词汇表。Integrity 计数与测试都按这些字符串匹配，
// 任何地方都不得自造。

export const FAILURE_TYPES = {
	budgetExhausted: "budget_exhausted",
	structuredFallback: "structured_fallback",
	replayMiss: "ReplayMiss",
	circuitOpen: "CircuitOpen",
	rateLimited: "RateLimited",
	serverError: "ServerError",
	clientError: "ClientError",
	timeout: "Timeout",
	network: "NetworkError",
	malformed: "MalformedResponse",
	truncated: "truncated",
	emptyContent: "empty_content",
	noPrompt: "no_prompt",
	gatewayMissing: "gateway_missing",
	parseFailure: "parse_failure",
	invalidAction: "invalid_action",
	noAvailableActions: "no_available_actions",
	ruleThrew: "rule_threw",
	providerThrew: "provider_threw",
	providerContractViolation: "provider_contract_violation",
	invalidArgs: "invalid_args",
	unknownAction: "unknown_action",
	noFallbackAction: "no_fallback_action",
	effectRejected: "effect_rejected",
	moduleStepFailed: "module_step_failed",
	moduleInitializeFailed: "module_initialize_failed",
	memorySummaryFailed: "memory_summary_failed",
	notImplemented: "not_implemented",
	consecutiveBatchFailures: "consecutive_batch_failures",
	consecutiveModuleFailures: "consecutive_module_failures",
	incompleteTick: "IncompleteTick",
	missingColumn: "missing_column",
	noFeatures: "no_features",
	notFitted: "not_fitted",
	unknownQuestionnaire: "unknown_questionnaire",
	invalidAnswer: "invalid_answer",
	emptySelection: "empty_selection",
	unknownArm: "unknown_arm",
	overrideNotHot: "override_not_hot",
	overrideFailed: "override_failed",
	noOwner: "no_owner",
} as const;

export type FailureType = (typeof FAILURE_TYPES)[keyof typeof FAILURE_TYPES];

// Failures counted in Integrity.parseFailures and decision_batch.parseFailures: the provider
// answered but produced nothing the action space can honour, as opposed to transport or
// kernel failures.
// 计入 Integrity.parseFailures 与 decision_batch.parseFailures 的失败：提供者有回复但产出的东西
// 动作空间无法执行，区别于传输或内核失败。
export const PARSE_FAILURE_TYPES: readonly string[] = [
	FAILURE_TYPES.parseFailure,
	FAILURE_TYPES.invalidAction,
];
