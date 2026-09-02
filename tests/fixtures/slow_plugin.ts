import { createMockProvider, ok, type DecisionProvider, type Registry } from "../../src/index";

export const SLOW_KIND = "slow";
export const DELAY_MS = 40;

const slowProvider = (inner: DecisionProvider, delayMs: number): DecisionProvider => ({
	name: inner.name,
	decide: async (requests, ctx) => {
		await Bun.sleep(delayMs);
		return inner.decide(requests, ctx);
	},
	reset: (seedPath) => inner.reset(seedPath),
	getState: () => inner.getState(),
	setState: (s) => inner.setState(s),
});

export const register = (registry: Registry) =>
	registry.providers.register(SLOW_KIND, (spec, ctx) => {
		const delay = spec.options?.delayMs;
		return ok(
			slowProvider(
				createMockProvider(ctx.registry.actions, spec.name ?? SLOW_KIND),
				typeof delay === "number" ? delay : DELAY_MS,
			),
		);
	});
