# Agent change trials

The trials measure how much of the code an agent must read and touch, and whether it stays green, for eight typical
changes (ADR 0028 stopping rule and trials; 2.1-Q226). The main agent runs them; stream agents never do.

- `tasks/t1.json` .. `t8.json`: the task text the trial agent gets, its user path or roadmap item, its owners in
  layer-table coordinates (the scenario fixtures' format, matched by `policy/adapters/scenario-owners.mjs`), a note
  for the reviewer, and its start rule.
- `seeds/t8.patch`: t8's seeded bug, applied in the run's start commit; `seeds/t8-expected.md`: the expected fix and
  the credit notes. The trial agent never sees either.
- `score.py`: `prepare`, `run` and `compare` (its docstring has the metrics); `transcript.py`: the one transcript
  reader, which the tools repo's `retro-tokens.py` imports too.
- `baseline.json`: the baseline runs, written by main: `{"start": "<commit>", "runs": [<run record>, ...]}`.

## Runner procedure

Run everything from main's checkout of the harness (`scripts/agent_trials/` at the phase tip), never from the trial
repository. For each task and run:

1. Start commit: the task's `start.baseline` (F0's result, a699e290b) for the baseline, the phase tip at a close.
2. `python3 scripts/agent_trials/score.py prepare <task> <start commit> ~/.cache/canopi-trials/trial-<task>-<phase>-r<n>`,
   with Node 24 on `PATH`. The directory sits outside every Canopi checkout (prepare refuses one inside), so no
   relative path reaches the harness, the seeds, `.rq-scratch/` worktrees or earlier run records; an agent searching
   the disk by absolute path still could. prepare makes the trial repository: one root commit on `main` (this
   directory removed, the seed applied) and no other history or ref, so the agent cannot reach the harness or the
   seed through git; then sets it up as `mkwt.sh` does a worktree. It prints the start commit and the repository's
   own `CARGO_TARGET_DIR` under `.rq-scratch/targets/` (2.1-M201).
3. A `stale seed` refusal stops that task: write a new seed for the same bug against this start, update
   `seeds/t8-expected.md`, note the re-expression in the results, and prepare again. The old seed is never scored.
4. Prompt: the task's `task` text, the trial repository's path and the usual environment lines (the printed
   `CARGO_TARGET_DIR`, Node 24 on `PATH`, `CANOPI_SKIP_BUNDLED_DB=1`); the agent reads `AGENTS.md` as usual. Never
   pass the owners, path, note, seed or expected-fix file.
5. Score once the agent ends:
   `python3 scripts/agent_trials/score.py run <task> <trial repository> --start <printed start> --transcript <agent .jsonl> --run <n> --phase <phase>`.
   `--start` is the full hash prepare printed, never `main`, which moves with the agent's own commits; run refuses
   anything else. The record and gate logs go to `.rq-scratch/trials/<phase>/`. A transcript ending in a usage-limit
   stop leaves the run `unscored` and nothing schedules a resume: rerun the task from a fresh start once the user
   types Resume.
6. Review: a reviewer who did not run the trial fills `reviewer.violations` and `reviewer.notes` in the record (the
   violations only review catches), and for t8 the credit in `seeds/t8-expected.md`.
7. Clean up: delete the trial repository and its target directory.

## Run counts and comparison (2.1-Q226)

| When | Runs per task | Compared with |
|---|---|---|
| Baseline (F0's result) | 3 | it becomes `baseline.json` |
| Phase 0 close | 3 | `baseline.json` |
| Phases 1, 2, 3 closes | 1 | `baseline.json`; each task `compare` names as worse is rerun three times |
| Phase 4 close | 3 | `baseline.json` |

`python3 scripts/agent_trials/score.py compare scripts/agent_trials/baseline.json .rq-scratch/trials/<phase>`
prints each metric's median per task, the scorer's gates ending red and the reviewer's violations among them, and
names the tasks that got worse (exit 1). Unscored runs, unreviewed runs and absent transcript metrics never enter a
median.
