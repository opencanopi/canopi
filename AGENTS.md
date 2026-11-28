# Agent operating contract

Rules for Canopi agents. A rule that matters has a test; one without is marked (advice).

## Read first

1. [`docs/README.md`](docs/README.md): which document answers which question.
2. [`docs/architecture/`](docs/architecture/README.md): owner and example per change; your area's guide in `docs/guides/`; your surface's pattern in [`.interface-design/`](.interface-design/system.md).
3. The ADR behind any rule you change. Code shows current behaviour, ADRs and guides intended boundaries; when they disagree, file a bead. A rule, ADR or doc blocking a better design is rewritten or deleted in the change that needs it, proposed to the user with its reason, never bypassed silently; catalog data, secrets and user work change only on the user's word.

## Rules

- **Preserve user work.** Run `git status --short --branch` before editing; pre-existing dirty or untracked files are the user's: never stage, revert or stash them, nor run `reset --hard` or `checkout -- <file>` unless asked. The stash stack is shared; set work aside with a WIP commit. Enforced by `agent-hooks.ts`.
- **Behavioural test first, then the fix.** Bug fixes carry a regression test whose title names the bead; a change to what it asserts names the user's decision id in the commit. A test is deleted only in a commit adding its replacement (title quoted) or retiring it (`Retires-test: <title> — <why no user sees it>`) with the code it covered (none if it tested only a doc). A seam change (renderer, camera, map, input) also gets a test through the real implementation or browser (advice). Tests sit beside their module; `desktop/web/src/__tests__/` holds only cross-module suites.
- **Gates run on the changed area** ([Quality gates](docs/quality-gates.md)). Build and fix agents stop at the commit hook plus the tests they touch; the main agent runs the full gate before each CI probe and the push lane before each push. A gate you cannot run goes in the bead and handoff with command, reason and residual risk. Coverage floors rise at milestones and never fall for the same file set (ADR 0028); on a merge conflict keep the higher.
- **Size limits** are met by splitting along a seam that stands alone, never by removing a test, assertion or rule; those go only when redundant, dead or wrong (2.1-Q338; advice).
- **Authorities are exclusive.** Session core (`app/document-session/core/`) owns session, home, save, `DesignScope`, dirty (`rev > ackRev`) and Undo (ADR 0024). `DESIGN_FILE_FIELDS` (`canopi-types/src/design.rs`) assigns each: `Document` (`app/design-edit/`), `Scene` (`core.recordSceneEdit()`), or `Format` (`2.1-M121`). Settings (`app/settings/`) own device state and map layers (`app/map-layers/`: actions/reads). Only the canvas draws highlights. Enforced by `document-format-contract.test.ts`, `session-suite.test.ts`, `plant-highlight-only-in-canvas` and `scene-writes-only-in-authority`.
- **Coordinates.** Files store WGS84 lon/lat; runtime geometry is metres in the session plane; camera moves never move objects (ADR 0001).
- **Native execution.** Every `#[tauri::command]` is executor-backed async or a reviewed bounded synchronous command; no blocking filesystem, SQLite, network, process or unbounded CPU work in one. Enforced by `native_command_policy::tests` and `clippy.toml`.
- **Secrets.** The Google Maps key never reaches Designs, exports, snapshots, logs, diagnostics or the page markup while masked; map errors go through `failures/redact.ts`. The location reading (dot, accuracy, time) never reaches a Design, Draft, export, snapshot, saved view, log or diagnostics; a camera saved while following is a view. Enforced by `settings-sections.test.tsx`, `map-background.test.ts`, `map-error-redaction.test.ts`, `workspace-map-controls.test.ts`, `problem-report-diagnostics.test.ts`, `my-location-trust.test.ts` and `my-location.spec.ts`.
- **Layering and chrome.** Popups use the stacking scale in `global.css`, and every tooltip draws in its one window-level layer; floating chrome registers with the visible-map-area seam so framing and chips avoid it; status chrome shown by load state registers with `frames: false`: only chips avoid it. On phones the tool strip is a rail the map frame starts beside; only the zoom column floats in the map; the rest docks in the context bar, which the sheet registers. Enforced by `stacking-order.test.ts`, `canvas-chrome-layering.test.ts`, `visible-map-area.test.tsx` and `phone-chrome.spec.ts`.
- **Localisation.** Every user-facing string exists in all 11 locales; `t` takes a generated `LocaleKey`. English is sentence case and placeholders fit their field. Enforced by `locale-key-typing`, `i18n-completeness.test.ts` and `i18n-copy.test.ts`. The glossary's terms and `Intl` for numbers, dates and units (advice).
- **Data.** Never change catalog data (`canopi-core.db`). `.canopi` and local data may change unasked to improve Canopi; name each in the handoff. Pre-2.0 data follows ADR 0021. From 2.0 every user-work store shape change, additions included, ships one frozen step once its runner exists (ADR 0026); from `.canopi` v10 only an optional field valid alone or a new open-set literal needs none. Derived stores rebuild; newer data is refused unchanged, or read-only where the reader release froze its form (ADR 0021); a LiDAR catalogue bump keeps `source_meta.rs` complete.
- **Reuse before writing** (ADR 0002): a geo feature's design check studies GeoLibre's design and crates first, follows them or says why not. Depend on light GeoLibre packages or copy its framework-free modules with attribution, never its React code. A new runtime dependency needs a bead with the reason.
- **Delete, don't deprecate.** Dead code, tests, docs and dependencies go in the change that kills them.
- **Banned** (advice): React, Tailwind, Zustand/Redux/MobX, react-i18next (use preact, CSS Modules, `@preact/signals`, `t`); rusqlite pools, typeshare, string-formatted SQL. CSS Modules: colour tokens, weights 400/600 (`css-module-policies.test.ts`).

## Quality gates

See [Quality gates](docs/quality-gates.md) (generated from `policy/gate/table.ts` via `node policy/gate/cli.mjs agents-rows --write`). Docs-only changes skip code gates; say so in the handoff.

## Working method

- **Work queue** (advice). Work is a queue of todos; a tweak or correction the user sends mid-task joins its end. Only an explicit stop or cancel takes effect at once; an item blocked on a user decision waits while the next runs. Stop only when the queue is empty.
- **Beads** track user-visible work, bugs and decisions, not sub-steps. Close with a receipt (what shipped, commits, gates); commit `.beads/issues.jsonl` when bead metadata changed.
- **Branch and worktrees.** Work branches from `main` (intent-named) and lands by PR. Implement in a worktree under `.rq-scratch/`, never in the user's `cargo tauri dev` checkout. From the reader release to 2.1.0, stable fixes land on `release/2.0` (native and release guide). A step is pushed once, after its pre-push review.
- **Scope** (advice). Name the user path or roadmap item behind each planned behaviour; drop what has none. Before cutting code, a seam or a behaviour as useless, check the roadmap (`docs/plans/`: hydrology, crown detection, LiDAR reading) and name what was checked. A refactor keeps what users see, not mechanisms. Never build what a later step of the release replaces. Specs hold contracts; briefs hold line numbers.
- **YAGNI** (advice). Every piece of work is justified; no overengineering. Engineering fits the work, from throwaway prototypes to production grade (the app, user data). Edge cases go by stake, not guessed frequency: losing, corrupting or blocking user work is handled however rare; a rare state's convenience gets the simplest safe behaviour, and later findings on it are filed (2.1-Q337). Widening scope needs the user's word: propose it with the reason. Small fixes inside the step's area and release promise are done and reported.
- **Subagents** run in parallel only on disjoint files (coupled work is one sequential stream; advice), each with explicit file ownership; none reverts another's work. A stream owns its feature's locale key namespace in all 11 locales (add, reword, delete). The main agent integrates, runs gates, closes beads and pushes.
- **Multi-agent steps** follow the `phased-agentic-delivery` skill and [agentic delivery](docs/guides/agentic-delivery.md). Live checks drive an isolated review instance, never the user's app.
- **Fresh-eyes review** (advice). Before handoff, a fresh subagent (Opus, medium effort) gets only the diff, its intent and the rules and ADRs it touches, and hunts for problems; verify each finding before fixing. Multi-agent steps keep the skill's review rounds too.
- **Mistakes** (advice). No apologies. A mistake means a gap in this file, a guide, the skill or memory: name the gap that caused it and propose the smallest fix (rule, check or test), rewriting an existing rule rather than adding one.
- **Commits** follow `fix(frontend): …`, `docs: …`; stage only your files; generated files go with the commit that produced them; no attribution trailer or mention of Claude in a commit or PR.

## Documentation

A guide changes only when a rule or boundary changes, and is rewritten, never appended; past budget, cut wiring, never rules. Built plans are deleted once their decisions are ledger rows or ADRs. Wiring lives in module comments and policy tests, not prose.

## Handoff

1. Gates for the changed area passed, or are recorded as skipped with the reason.
2. Bead closed with a receipt; follow-up beads filed.
3. Affected guide, pattern, ADR or release notes updated, or the handoff says none needed it.
4. Committed, rebased, pushed (once per step); `git status --short --branch` clean and up to date.
5. Final message: each queue item's outcome, bead id, commit, branch, gates run or skipped, user-owned files left untouched, and what to try in `cargo tauri dev`.

<!-- okf:begin -->
<!-- Managed by `okf agents install` (okfkit 0.1.0). Edits inside this block are overwritten. -->
## Project knowledge (OKF)

This repository keeps its durable knowledge (architecture, modules, decisions,
conventions, runbooks) as an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
v0.2 bundle in `knowledge/`. It is shared memory for every agent and human
working here: read it before you work, and keep it true after you change code.

Use the `okf` tool, either as a CLI (`python3 .okf/okf.pyz <command>`, from any shell) or as
MCP tools named `okf_*`. Both expose the same operations. Add `--json` to any
CLI command for machine-readable output.

**Identify yourself** before writing: `export OKF_ACTOR=<agent>/<model>` (for
example `codex/gpt-5` or `claude-code/claude-opus-4`). Never write as `human:...`.
That prefix marks content as human-reviewed, and only a person may use it.

### Before changing code
1. Run `python3 .okf/okf.pyz context --path <file-or-dir-you-will-touch>` (or `--query "<topic>"`)
   to get the map, the relevant concepts, and the maintenance queue.
2. Run `python3 .okf/okf.pyz show <id>` to read a concept, then weigh its signals.
   `human-reviewed` beats `machine-confirmed`, which beats `unverified`.
   `DRIFT` or `STALE` means the concept may be out of date, so check it against
   the code first. Do not follow `deprecated` concepts; read their `superseded_by` instead.
3. The code is the source of truth. If a concept disagrees with the code, trust
   the code and fix the concept.

### After changing code
4. Run `python3 .okf/okf.pyz impact`. It lists the concepts grounded in the files you changed. For
   each one, either update it (`python3 .okf/okf.pyz update <id> ...`) or, if you re-read it and it
   is still accurate, run `python3 .okf/okf.pyz verify <id>`.
5. Record any new durable knowledge: a module, a decision and its reasons, a
   convention, a non-obvious fix, a runbook:
   `python3 .okf/okf.pyz new <dir>/<slug> --type <Type> --title "..." --description "<one sentence>" --source <path> --body-file -`
   Pass `--source` for every file or URL the content comes from. The tool records a
   digest, which is how drift is detected later.
6. If you edit concept files directly instead of using the tool, run `python3 .okf/okf.pyz sync`
   afterwards. It stamps provenance, refreshes digests, and regenerates `index.md`.
7. `python3 .okf/okf.pyz check` must report 0 errors before you finish.

### Rules
- Keep one topic per concept, one file per concept. Link related concepts with
  bundle-absolute links, for example `[Auth](/modules/auth.md)`.
- `description` is one sentence. In bodies, prefer headings, lists, tables, and code fences.
- Never hand-edit `index.md` (it is generated). This bundle keeps no change
  log (git history records changes), so do not add entries to `log.md`.
- Do not delete concepts. Deprecate them: `python3 .okf/okf.pyz deprecate <id> --replaced-by <id> --reason "..."`.
- Never store secrets, credentials, or personal data. Say where they live instead.
- Do not invent sources. Cite only files and URLs you actually read.
- Bootstrapped drafts carry `<!-- okf:todo -->` markers. `python3 .okf/okf.pyz todo` lists the work queue.
- When a test, policy script, or lint config enforces a rule a concept states
  (typically a Convention), list it: `--enforced-by <repo-path>[::<test-name>]`
  (repeatable). `python3 .okf/okf.pyz check` reports an error if a listed path disappears.
- Suggested types: Project (`project/`), Architecture (`architecture/`), Module (`modules/`), API (`apis/`), Data Model (`data/`), Architecture Decision (`decisions/`), Convention (`conventions/`), Runbook (`runbooks/`), Dependency (`dependencies/`), Integration (`integrations/`), Glossary Term (`glossary/`), Reference (`references/`). Any other `type` is also valid.

### Without the tool
If `okf` cannot run, edit the markdown directly following OKF v0.2 (`.okf/SPEC.md`):
- Every `.md` file except `index.md` and `log.md` needs YAML frontmatter with a
  non-empty `type`.
- Set `generated: { by: <agent>/<model>, at: <UTC ISO 8601, e.g. 2026-01-31T12:00:00Z> }`.
- List what you read under `sources` (each entry has `id`, `resource`, and `title`).
- Mention in your final message that `okf sync` should be run.
<!-- okf:end -->
