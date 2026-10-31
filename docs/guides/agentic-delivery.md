# Agentic delivery

Covers: none

How agents run Canopi work with the user-level `phased-agentic-delivery` skill, whose loop and procedure apply as written. This page holds only Canopi's places, commands, triggers and measured costs; the rules and their reasons are in [`AGENTS.md`](../../AGENTS.md).

## Places

Paths are relative to `/home/daylon/projects/canopi`; use them absolute in commands (agents work from worktrees under `.rq-scratch/`).

- **User's checkout** `/home/daylon/projects/canopi`: read-only for agents. The user runs `cargo tauri dev` there; never pull, commit, stage, stash or push in it, and never touch its `target/` without asking.
- **Integration worktree** `.rq-scratch/<step>` on an intent-named branch from `origin/main` (`git worktree add -b <branch> .rq-scratch/<step> origin/main`). Before each merge or push: `git fetch`, then `git rebase --rebase-merges origin/main` if behind. Push once per step, after its pre-push review, open a PR into `main` and merge it when green (a direct push to `main` turns the Commit gate red), then `git fetch origin`. Push to GitHub by URL; Codeberg waits until the user says. Stable fixes: [release/2.0](native-and-release.md#stable-fixes). One agent at a time works there.
- **Stream worktrees**: `.rq-scratch/tools/mkwt.sh <stream> [base]` makes `.rq-scratch/wt-<stream>` on `wt/<stream>` (base: the step's branch) with `npm ci` (`HUSKY=0` on an old tag; hooks: the tracked `.githooks`), the PDF fonts and a copy of the pinned plant DB, `.rq-scratch/shared-build/canopi-core.db` (the `canopi-core-db` asset of the pinned export; refresh it when the pin changes).
- **Build folders**: `CARGO_TARGET_DIR=/home/daylon/projects/canopi/.rq-scratch/targets/<stream>/target` in every worktree shell, npm scripts that call cargo included; the last component must be `target`, or Tauri reads the installed app's resources. One per stream: a shared one stalls on cargo's build lock, so `scripts/gate.py` refuses `shared-build/target` (2.1-M201).
- **Scratch**: gate logs in `.rq-scratch/gate-logs/`, screenshots in `.rq-scratch/screenshots/<step>/` (kept), review profiles in `.rq-scratch/reference/<step>/` (removed at the step's close). Run `df -h /` before launching agents; below about 50 GB free remove merged worktrees and caches (`/tmp/canopi-*`, headless browser profiles), keep screenshots.

## Gates

- **Gate table**: `scripts/gate.py` holds each area's checks per lane (`commit` in the hook, `affected`, `full`; `areas` lists a diff's areas); AGENTS.md's rows quote it.
- **Affected**, after a build or fix agent's last commit: `BASE=<branch it builds on> .rq-scratch/tools/quiet-gates.sh <worktree> affected`: tsc, `check:ui`, `vitest related` on the changed files and the policy tests; from a step's commit 0 always every source-text policy test (a related-files selection once skipped a failing one), the locale tests and the stream's own Playwright specs in Chromium and WebKit. **Quick** (the whole suite) is for a worktree with no base.
- **Dev tools** (cargo-deny, cargo-shear, actionlint): `.rq-scratch/tools/bin/bin`, on quiet-gates' PATH; the gate's pinned actionlint (version, URL, sha256 in `scripts/gate.py`) goes there or in `CANOPI_ACTIONLINT`.
- **Lockfile**: Node 24 everywhere; the merge regenerates `desktop/web/package-lock.json` with `npx -y npm@11.21.1 install`, never by hand (2.1-M220).
- **Gate lines** count only from a run started after the last commit; the shell is zsh with noclobber, so overwrite a log with `>|`.
- **Slots**: build agents per `free -g` available, one per 6 GiB above a 4 GiB reserve, at most 4 (8 CPUs), re-checked per slot; under 8 GiB, `VITEST_WORKERS=2`.
- **Ownership** (commit 0): `.rq-scratch/tools/<step>-owners.tsv`, tab-separated: path, stream (`*` shared), then `new` for a file the step creates or the chunk (`c0`, `chunk1`, …) when the path changes hands, and a note naming the stream's keys or symbols. `STEP=<step> quiet-gates.sh <wt> plan` fails a path owned twice in one chunk or missing without `new`; with `STREAM=<s>` a stream's gate fails a diff outside its rows. No script finds a needed file nobody owns: commit 0's user-path tests name every file their pass needs (Layers: 16 merge failures and stream holds from unowned files).
- **Known reds** are marked in the code (`test.fail()`, `it.fails`, owner and bead in the title), so the state travels with each branch (a shared list was rewritten twice mid-step); `quiet-gates.sh <wt> markers` lists them and `PREPUSH=1` fails on any.
- **Full**, at each merge and (with `PREPUSH=1`) before a push: `.rq-scratch/tools/quiet-gates.sh <worktree> full`, the Frontend row of `AGENTS.md` (tsc, coverage as the suite, the policy tests, check:ui, both builds, docs). Add the Rust and shared-contract rows of `AGENTS.md` when those areas change.
- **Web check** on any merge touching the renderer, camera, input or map: the whole browser suite in CI's sharded lane, about a third of the local time and beside the local gates. `.rq-scratch/tools/ci-watch.sh scratch-up <branch> <title>` opens a draft PR of the merge tip, `ci-watch.sh <sha> <branch>` waits for green, `scratch-down` closes it. Locally: `npm run build:web`, then the pinned image (`playwright.config.ts` header) runs `npx playwright test e2e/canvas --project=chromium --project=webkit`.
- **CI**: `Commit gate` checks each PR commit and push to `main`; `Build & Test` on each PR into and push to `main` or `release/2.0`; `Web Edition browsers` only when `desktop/web/` or the version changed. A PR runs the lanes its diff from the base touches and packages Linux and Apple silicon unless a packaging input changed; a push runs everything. Watch: `gh run list --branch <branch>`, then poll `gh run view <id> --json status,conclusion`.
- **CI jobs and packaging targets** per run: the comments on `changes` and its `packaging` step in `.github/workflows/build.yml`.
- **PRs**: branch pushes run no workflow; a PR into `main` runs both. A scratch run before the step's push uses the Web check's `ci-watch.sh` commands.

## Design check

A planned cut or behaviour whose design-check entry says users notice nothing names the screen surfaces it touches (ghosts and previews, Esc layers, field sizes, menus, focus) and gets a live-check scenario; a planned interaction is checked against what that screen draws; an entry that says "no code" names, per pointer kind or input it covers, the existing path delivering it.

An element added to a chrome row gets, in commit 0, a Playwright matrix of its row's neighbours per layout width and locale, both engines (the location button pushed the zoom group over the notice's Retry on tablets: three fix rounds).

Each stream's first commit probes its riskiest platform assumption in WebKitGTK and Chromium (phase R's untested font assumption cost four fix rounds).

A colour offered in a question carries its contrast on every surface it is drawn on (light and dark map, PDF paper, grayscale print) beside its colour-vision distance (the polish batch's grey, chosen on distance alone, printed at 2.25:1; U48).

## Review lenses

Seams the tests fake (the skill's second round and live check): the renderer, camera, map and input, plus file dialogs for the live check. Native-only paths: file dialogs, LiDAR import, PDF save, WebKitGTK fit (Layers' native check, 3 % of input, found 3 failures nothing else did). Engines: WebKitGTK natively, Chromium and WebKit in the Web check.

A seam streams share (a source path the owners file gives to two streams, commit 0 and expected-fail markers aside, or a contract the plan names between two streams' modules) is reviewed once after both sides merge. The scene render target (`scene-runtime/render-scheduler.ts`, `maplibre/shared-scene-{layer,renderer}.ts`, `app/canvas-map-surface/workspace-activation.ts`) is always one: its create, dispose and Design-switch orders reached phase R's pre-push review twice.

Each stream's lens names the resources its code spends (disk space, memory, the executor lane, worker time) and the numerical assumptions it rests on (scale factors, tolerances, units), besides its inputs and states (U-crs stream B passed two rounds with a too-small free-space check and a scale-blind zoom).

## Stored data within a step

A stored-format version (the LiDAR catalogue, the user DB, `.canopi`) bumps once per push: later unpushed changes reuse that bump and add no test for a version that never shipped (U-crs once bumped the catalogue three times in one step).

## Live check

- Run once a merge changing a seam the tests fake (map, renderer, input, file dialogs) passes its gates, and before the pre-push review.
- No Windows, Mac or phone hand check gates a step or the release; one not run is recorded as untested with its risk (U20, U41).
- `.rq-scratch/tools/live-instance.sh up <commit> <step>` makes the detached worktree nobody edits (Vite hot-reloads edits), the catalog copy, the profile `.rq-scratch/reference/<step>` (relative XDG paths fall back to the user's), identifier `com.canopi.review` and Vite 1431; it refuses when 1431 is taken and reports the bridge PID whose environment is that profile (the user's app usually holds 1420 and 9223: never drive it). `down <step>` stops it by PID and removes the worktree and profile.
- The bridge works only in debug-profile builds (`desktop/build.rs`). Before driving, check (`ss -ltnp`, `/proc/<pid>/exe`) that its port (9223 or the next free) is that process's.
- Drive with the Tauri MCP tools, asserting with `webview_execute_js` values; wheels and drags are DOM events on the map host (`.rq-scratch/screenshots/phase-0/drag-helper.js`), not WebKitGTK's native order; Space is `"Space"`; count IPC by wrapping `fetch` for `ipc://localhost`; native file dialogs `x11-dialog.py`. The only "Close" button quits the app (canopi-pj62). Record which host drove each step; stop processes by PID, never `pkill -f`.
- Frame times count only from a production build in a focused window or the Web build traced in Playwright (the DEV build freezes on each Scene write; an unfocused window's `requestAnimationFrame` runs near 9 Hz).

## Tracker

Beads ([commands](../workflow.md)); read with `bd dep tree <id>` and `bd list --parent <id>` too. The main agent alone writes (`bd update <id> --claim --acceptance "…"`, `bd note`, `bd create … --deps discovered-from:<id>`, `bd close`), then `bd export -o .beads/issues.jsonl` in the integration worktree and commits it. A bug found after its step was pushed gets the label `escaped` (`bd create … -l escaped`); each retrospective counts them against the step that pushed it (`.rq-scratch/tools/retro-tokens.py steps`).

Wrong work or a bug traced to a stale or wrong doc gets the label `stale-doc` (with `escaped` if found after the push); each retrospective counts them, per doc.

## Models

Opus at medium effort for every stage (2026-10-13); Sonnet only for trivial checks; no other model. Auto-compaction at 300K tokens. Weekly usage limits are not a reason to slow work; keep the efficiency habits.

## Tools

In `.rq-scratch/tools/` (a local git repo; commit tool edits there): `mkwt.sh`, `quiet-gates.sh` with `gate-classify.py`, `live-instance.sh`, `ci-watch.sh`, `journal.py <run> [--full LABEL]`, `wf-usage.py <run>...` (cost per stage), `imgdiff.py`, `x11-dialog.py`, `near-zero-coverage.py <worktree>` (at each release close, after the coverage run that sets the floors: every production file under 20 % lines kept with its reason, or tested).

## Workflows and measured cost

Deterministic stages (merges, gates, the live instance, CI) are the main agent's commands, an agent only when one fails.

When a usage limit stops agents, schedule no check-in to resume them: the user types "Resume". Never stop a running workflow on your own initiative; the user decides.

Live bugs, guards and location: 682M input over 22 stage runs and 220 agents; build 42 %, reviews 39 %, fixes 10 %, usefulness 4 %; the notice detour about 15 %.
