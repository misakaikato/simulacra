# GUI

The GUI is a Vite and React application in `gui/` that talks only to the [HTTP API](/guide/api). Build it once, then `simulacra serve` serves it from `gui/dist` next to the API:

```bash
bun run build:gui
bun run simulacra serve --data .
```

`--data .` points the server at a directory whose `runs/` and `audits/` hold what the CLI produced; the default is `./simulacra-data`. Until the GUI is built, `/` answers with a plain-text note and the API is available regardless. For development, `bun run dev:gui` starts Vite and `bun run dev:mock` a mock API.

The GUI has three pages.

## Runs

Runs and audits with their progress, and a form that starts a run: pick a built-in example or paste YAML, set the seed (default 1), optionally the number of ticks (the scenario's total by default) and the provider, `mock` or `llm`. Submitting posts to `/api/runs`; the new run appears in the list and streams its events.

<div class="screenshot">

![Runs list with the new-run form](/screenshots/runs.jpg)

</div>

## Run

One run: the tick timeline with failure counts, the force-directed network coloured by stance, an agent inspector that shows the causal chain from observation through prompt to decision and effects, the metric series, and the integrity and cost panels. The inspector reads the same chain `simulacra inspect` prints.

<div class="screenshot">

![Run view](/screenshots/run.jpg)

</div>

## Audit

One audit: the plan and its evidence grade, the perturbation axes, the conditions, the pairwise tests with Holm-corrected p values, the sensitivity ranking, direction consistency, cross-model means, distribution tests, integrity and cost. The offline HTML report of the same audit is served at `/api/audits/:id/report.html`; the [audit reference](/guide/audits#reading-the-report) explains each section.

<div class="screenshot">

![Audit view](/screenshots/audit.jpg)

</div>

<div class="screenshot">

![HTML audit report](/screenshots/report.jpg)

</div>
