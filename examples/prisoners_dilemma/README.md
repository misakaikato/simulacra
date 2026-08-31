Repeated prisoner's dilemma: an LLM-driven player against a rule-driven opponent (`params.opponent`: titForTat, random, alwaysCooperate, alwaysDefect; `params.framing`: canonical, moralized, risk). The `pd` world module, its `cooperate`/`defect` actions and the `pdRule` provider live in `rules.ts` and are loaded with `--plugin`.

Run without an LLM: `bun run simulacra run examples/prisoners_dilemma/scenario.yaml --seed 1 --provider mock --plugin examples/prisoners_dilemma/rules.ts --out ./pd-run`

Run against the configured endpoint (needs `SIMULACRA_LLM_API_KEY`): drop `--provider mock`; then `bun run simulacra inspect ./pd-run --agent <id> --tick 3` shows one round's observation, prompt, decision and effects.
