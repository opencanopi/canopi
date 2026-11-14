# Agentic delivery

Covers: none

How agents run Canopi work with the user-level `phased-agentic-delivery` skill, whose loop and procedure apply as written. This page holds only Canopi's places, commands, triggers and measured costs; the rules and their reasons are in [`AGENTS.md`](../../AGENTS.md).

## Places

Paths are relative to `/media/daylon/main_hdd/projects/canopi`; commands use them absolute.

- **User's checkout** (that root): read-only for agents. The user runs `cargo tauri dev` there; never pull, commit, stage, stash or push in it, and never touch its `target/` without asking.
- **Integration worktree** `.rq-scratch/<step>` on an intent-named branch from `origin/main`. Before each merge or push: `git fetch`, then `git rebase --rebase-merges origin/main` if behind. Push to GitHub by URL once per step, after its pre-push review; Codeberg waits until the user says. Stable fixes: [release/2.0](native-and-release.md#stable-fixes). One agent at a time works there.
- **Stream worktrees**: `.rq-scratch/tools/mkwt.sh <stream> [base]` makes `.rq-scratch/wt-<stream>` on `wt/<stream>` (base: the step's branch) with `npm ci`, the tracked hooks, the PDF fonts and a copy of the pinned plant DB, `.rq-scratch/shared-build/canopi-core.db` (refresh it when the pin changes).
- **Build folders**: `CARGO_TARGET_DIR=.rq-scratch/targets/<stream>/target`, one per stream (the gate refuses `shared-build/target`, 2.1-M201); the last component must be `target`, or Tauri reads the installed app's resources.
- **Scratch**: gate logs in `.rq-scratch/gate-logs/`, screenshots in `.rq-scratch/screenshots/<step>/` (kept), review profiles in `.rq-scratch/reference/<step>/` (removed at the step's close).
- **Disk**: `.rq-scratch/tools/slot-check.sh [rust-streams]` before each slot and at each step's start and close. Its floor is 20 GB plus 10 GB per Rust stream building at once, and it reports the stray state agents leave (`--clean` removes stream targets with no worktree, the merge target's incremental cache and trial clones).

## Gates

One gate, `node policy/gate/cli.mjs <lane>`: `policy/gate/table.ts` holds each area's checks per lane, and AGENTS.md's rows are rendered from it. Stream agents run every build or test as one `.rq-scratch/tools/in-wt.sh <chunk>[/web] <command>` (Node 24, the stream's target, nice 10 and idle I/O so the main agent's gates and merges come first, 2.1-Q330).

- **Lanes**: `commit` (the hooks; the shared-contracts check when its inputs change, 2.1-Q330), `affected --base <rev>`, `push --base <rev>` (CI's Linux mirror: full rows of the selected areas, every Commit gate check, `--vitest` included, then the expected-fail marker check), `full` (every area, e2e included).
- **Who runs what** (2.1-Q272): build and fix agents stop at the commit hook plus the tests they touch and the source-text policy tests. The main agent runs the full gate before each CI probe and the push lane before each push. A command past an agent's foreground limit goes to the main agent.
- **quiet-gates**: `BASE=<rev> .rq-scratch/tools/quiet-gates.sh <worktree> affected|push|full` runs `node policy/gate/cli.mjs <lane>` with its lock, disk floor, PATH, the stream's target and log capture; `ONLY=id,id` and `AREAS=a,b` pass `--only` and `--area`. Every lane ends `GATES GREEN|RED`. Exit 3: another run holds the worktree's lock, so wait on the pid it names, never on its log. A run whose HEAD or tracked files moved is red.
- **Pre-push stamp**: `quiet-gates.sh <wt> push` writes HEAD's stamp only when the whole lane is green on a tree exactly HEAD, no untracked file (never with `--only`); the tracked pre-push hook refuses a pushed commit without one. Deletions, tags on `origin/main` and docs- or beads-only ranges pass, the last after their cheap lane. A ref under `scratch/` needs no stamp: CI on the step's draft PR decides (2.1-Q329). A change to CI or the Playwright setup needs no CI run before its push: the merge's required checks run it on the PR's head.
- **Known reds** are marked in the code (`test.fail()`, `it.fails`, owner and bead in the title), so the state travels with each branch; one added since the base fails the push lane unless the upstream register exempts it (2.1-M237).
- **Net change** (2.1-Q272): the Commit gate judges test deletions, loosened tests and families, guarded files and demotions once per PR, on its net change, so a rule added in a branch never fails an earlier commit. A merge-base M row authorises an engineering loosening; capability grants and test deletions take a Q row (2.1-M387).
- **Routes** (2.1-Q274): a route is tied to its file: the bead and row cited in a commit of the range that touched it (a merge: only what differs from every parent), or a PR body line naming it by whole path or by a base name no other changed file shares and that ends no other path; a partial path names nothing (2.1-M392). Quoted replacement titles and `Rewords-test` or `Retires-test` lines route from any message or the body (2.1-M393). A `Retires-test` line routes only a deletion; twins are judged against every choice of base twins (2.1-M391).
- **Dev tools** (cargo-deny, cargo-shear, the pinned actionlint): `.rq-scratch/tools/bin/bin`, on quiet-gates' PATH.
- **Lockfile**: Node 24 everywhere; the merge regenerates `desktop/web/package-lock.json` with `npx -y npm@11.21.1 install`, never by hand (2.1-M220).
- **Slots**: build agents per `free -g` available, one per 6 GiB above a 4 GiB reserve, at most 4 (8 CPUs), re-checked per slot, and at most one Rust and one frontend stream at once (2.1-Q330); under 8 GiB, `VITEST_WORKERS=2`.
- **Ownership** (commit 0, 2.1-Q330): `.rq-scratch/tools/<step>-owners.tsv` grants files per stream; a stream also owns its expected-fail markers, snapshots and the generated files its change regenerates, and `own-check.sh` refuses only another stream's files. `STEP=<step> quiet-gates.sh <wt> plan` fails a path owned twice in one chunk or missing without `new`. Commit 0's user-path tests name every file their pass needs; from Phase 2, commit 0 adds a contract test for each module two streams change, run by both.

## CI and merging

- `Commit gate` checks each PR's range and each push to `main`; `Build & Test` runs the lanes the diff's areas select and packages Linux, Apple silicon and, for a packaging input, Windows; a push to `main` runs everything. The ruleset requires those two.
- **Merge** with `gh pr merge --auto`, never `--admin`: the required checks decide. Then watch the non-required lanes the diff touches.
- **Non-required lanes**, each its own workflow, report and never gate (2.1-M240, 2.1-M331, 2.1-M344): `Performance` and the seed lane run on a PR only when it changes their own files, and on each push to `main` (seed also nightly); `Mutation` mutates a PR's diff when review starts and on each push while it carries the repository label `mutation` (adding it reruns). OSV advisories run in Build & Test's supply-chain job on a PR changing a lockfile, the table or the scanner, and weekly and on each push to `main` in `advisories.yml`.
- **Scratch runs**: `ci-watch.sh scratch-up <branch> <title>` opens a draft PR of a tip, `ci-watch.sh <sha> <branch>` waits for green, `scratch-down` closes it. A merge touching the renderer, camera, input or map runs the whole browser suite this way.
- **Snapshots**: screenshots and aria snapshots regenerate in the pinned Playwright image, `docker run --rm --init --ipc=host --user 1000:1000 -e HOME=/tmp`; Chromium and WebKit run `npx playwright test ... --update-snapshots`, Firefox the same under `xvfb-run -a -s '-screen 0 1920x1200x24'`. Without `--init`, xvfb-run hangs.

## Design check

A planned cut or behaviour whose design-check entry says users notice nothing names the screen surfaces it touches (ghosts and previews, Esc layers, field sizes, menus, focus) and gets a live-check scenario; a planned interaction is checked against what that screen draws; an entry that says "no code" names, per pointer kind or input it covers, the existing path delivering it.

An element added to a chrome row gets, in commit 0, a Playwright matrix of its row's neighbours per layout width and locale, both engines.

Each stream's first commit probes its riskiest platform assumption in WebKitGTK and Chromium.

A colour offered in a question carries its contrast on every surface it is drawn on (light and dark map, PDF paper, grayscale print) beside its colour-vision distance.

## Review lenses

Seams the tests fake (the skill's second round and live check): the renderer, camera, map, input and, live, file dialogs. Native-only paths: file dialogs, LiDAR import, PDF save, WebKitGTK fit. Engines: WebKitGTK natively, Chromium, WebKit and Firefox in CI.

A seam streams share (a source path the owners file gives to two streams, commit 0 and expected-fail markers aside, or a contract the plan names between two streams' modules) is reviewed once after both sides merge. The scene render target (`scene-runtime/render-scheduler.ts`, `maplibre/shared-scene-{layer,renderer}.ts`, `app/canvas-map-surface/workspace-activation.ts`) is always one.

Each stream's lens names the resources its code spends (disk space, memory, the executor lane, worker time) and the numerical assumptions it rests on (scale factors, tolerances, units), besides its inputs and states.

## Stored data within a step

A stored-format version (the LiDAR catalogue, the user DB, `.canopi`) bumps once per push: later unpushed changes reuse that bump and add no test for a version that never shipped.

## Live check

- Run once a merge changing a seam the tests fake passes its gates, before the pre-push review.
- No Windows, Mac or phone hand check gates a step or the release; one not run is recorded as untested with its risk (U20, U41).
- `live-instance.sh up <commit> <step>` starts a detached worktree with a catalog copy, the profile `.rq-scratch/reference/<step>`, identifier `com.canopi.review` and Vite 1431, and reports the bridge PID (the user's app holds 1420 and 9223: never drive it); `down <step>` removes it.
- The bridge runs only in debug builds; before driving, check (`ss -ltnp`, `/proc/<pid>/exe`) that its port is that process's.
- Drive with the Tauri MCP tools, asserting with `webview_execute_js` values; wheels and drags are DOM events on the map host (`.rq-scratch/screenshots/phase-0/drag-helper.js`); native file dialogs `x11-dialog.py`. The only "Close" button quits the app. Stop processes by PID, never `pkill -f`.
- Frame times count only from a production build in a focused window or the Web build traced in Playwright.

## Tracker

Beads ([commands](../workflow.md)). The main agent alone writes (`bd update --claim`, `bd note`, `bd create --deps discovered-from:<id>`, `bd close`), then commits `bd export -o .beads/issues.jsonl` from the integration worktree. A bug found after its step was pushed gets the label `escaped`; wrong work traced to a stale or wrong doc gets `stale-doc`. Each retrospective counts both, per step and per doc (`.rq-scratch/tools/retro-tokens.py steps`).

## Models

Opus at medium effort for every stage; Sonnet only for trivial checks; no other model. Auto-compaction at 300K tokens.

## Tools

In `.rq-scratch/tools/` (a local git repo; commit tool edits there), besides those above: `journal.py <run>`, `wf-usage.py <run>...` (cost per stage), `imgdiff.py`, `near-zero-coverage.py <worktree>` (at each release close: every production file under 20 % lines kept with its reason, or tested).

## Workflows and measured cost

Deterministic stages (merges, gates, the live instance, CI) are the main agent's commands; an agent only when one fails. When a usage limit stops agents, schedule no check-in to resume them: the user types "Resume". Never stop a running workflow on your own initiative; the user decides.

Live bugs, guards and location: 682M input over 22 stage runs and 220 agents; build 42 %, reviews 39 %, fixes 10 %, usefulness 4 %.
