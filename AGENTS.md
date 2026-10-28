# Agent operating contract

Rules for agents in Canopi: preserve user work, keep changes reviewable, hand off reliably. A rule that matters has a test; one without is marked (advice). Architecture: [`docs/architecture.md`](docs/architecture.md). Decisions: [`docs/adr/`](docs/adr/).

## Read first

1. [`docs/README.md`](docs/README.md): which document answers which question.
2. [`docs/architecture/`](docs/architecture/README.md): diagram, owner, example per change; your area's guide in `docs/guides/`; your surface's pattern in [`.interface-design/`](.interface-design/system.md).
3. The ADR behind any rule you are about to change. Code shows current behaviour, ADRs and guides intended boundaries; when they disagree, file a bead. A rule, ADR or doc that blocks a better design is rewritten or deleted in the change that needs it, proposed to the user with its reason, never bypassed silently; catalog data, secrets and user work change only on the user's word.

## Rules

- **Preserve user work.** Run `git status --short --branch` before editing; pre-existing dirty or untracked files are the user's. Never stage, revert or stash them, and never run `reset --hard` or `checkout -- <file>` unless asked. The stash stack is shared; set work aside with a WIP commit. Enforced by `agent_hooks.py`.
- **Behavioural test first, then the fix.** Bug fixes carry a regression test whose title names the bead; a change to what it asserts names the user's decision id (`docs/decisions/`) in the commit. A test is deleted only in the commit that adds its replacement (title quoted), or that retires it (`Retires-test: <title> — <why no user sees it>`) and deletes the code it covered. A seam change (renderer, camera, map, input) also gets a test through the real implementation or browser (advice). Tests sit beside their module; `desktop/web/src/__tests__/` holds only cross-module suites.
- **Gates run on the changed area** (table below). A gate you cannot run goes in the bead and handoff with command, reason and residual risk. Coverage floors (`policy/ratchets/coverage.json`) are raised at milestones and never lowered for the same file set (ADR 0028); on a merge conflict keep the higher one.
- **Authorities are exclusive.** `DESIGN_FILE_FIELDS` (`common-types/src/design.rs`) gives each Design field one owner: `Scene`, the scene runtime (runtime transactions), or `Document`, Design Edit (`app/design-edit/`). The map layer store owns map layers; settings own device state. Panels read the canvas by read-only runtime queries; only the canvas draws highlights. Enforced by `document-format-contract.test.ts` and the policy rules `plant-highlight-only-in-canvas` and `design-edit-authority-only-in-core` (`policy/rules.json`).
- **Coordinates.** Files store WGS84 lon/lat; runtime geometry is metres in the session plane; camera moves never move objects (ADR 0001).
- **Native execution.** Every `#[tauri::command]` is executor-backed async or a reviewed bounded synchronous command; no blocking filesystem, SQLite, network, process or unbounded CPU work in one. Enforced by `native_command_policy::tests` and `clippy.toml`.
- **Secrets.** The Google Maps key never reaches Designs, exports, snapshots, logs, diagnostics or the page markup while masked; map errors go through `maplibre/redact-credentials.ts`. The location reading (dot, accuracy, time) never reaches a Design, Draft, export, snapshot, saved view, log or diagnostics; a camera saved while following is a view. Enforced by `settings-sections.test.tsx`, `map-background.test.ts`, `map-error-redaction.test.ts`, `workspace-map-controls.test.ts`, `problem-report-diagnostics.test.ts`, `my-location-trust.test.ts` and `e2e/canvas/my-location.spec.ts`.
- **Layering and chrome.** Popups use the stacking scale in `global.css`, and every tooltip draws in its one window-level layer; floating chrome registers with the visible-map-area seam so framing and chips avoid it; status chrome shown by load state registers with `frames: false`: only chips avoid it. On phones the tool strip is a rail the map frame starts beside; only the zoom column floats in the map; the rest docks in the context bar, which the sheet registers. Enforced by `stacking-order.test.ts`, `canvas-chrome-layering.test.ts`, `visible-map-area.test.tsx` and `phone-chrome.spec.ts`.
- **Localisation.** Every user-facing string exists in all 11 locales; English is sentence case and placeholders fit their field. Enforced by `i18n-completeness.test.ts` and `i18n-copy.test.ts`. The glossary's terms and `Intl` for numbers, dates and units (advice).
- **Data.** Never change catalog data (`canopi-core.db`). `.canopi` and local data may change unasked to improve Canopi; name each in the handoff. Pre-2.0 data follows ADR 0021. From 2.0 every user-work store shape change, additions included, ships one frozen step once its runner exists (ADR 0026); from `.canopi` v10 only an optional field valid alone or a new open-set literal needs none. Derived stores rebuild; newer data is refused; a LiDAR catalogue bump keeps `source_meta.rs` complete.
- **Reuse before writing** (ADR 0002): a geo feature's design check studies GeoLibre's design and crates first, follows them or says why not. Depend on light GeoLibre packages or copy its framework-free modules with attribution, never its React code. A new runtime dependency needs a bead with the reason.
- **Delete, don't deprecate.** Dead code, tests, docs and dependencies go in the change that kills them.
- **Banned** (advice): React, Tailwind, Zustand/Redux/MobX, react-i18next (use preact, CSS Modules, `@preact/signals`, `t` from `../i18n`); rusqlite pools, typeshare, string-formatted SQL. CSS Modules: colour tokens, weights 400/600 (`css-module-policies.test.ts`).

## Quality gates

| Change | Run |
|---|---|
| Rust | `cargo fmt --all -- --check`; `CANOPI_SKIP_BUNDLED_DB=1 cargo clippy --workspace --all-targets -- -D warnings`; `CANOPI_SKIP_BUNDLED_DB=1 cargo test --workspace`; `cargo cov` above its floor; `cd desktop/web && CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push` |
| A `#[tauri::command]` | `CANOPI_SKIP_BUNDLED_DB=1 cargo test -p canopi-desktop native_command_policy::tests` |
| Shared contracts (`common-types/`) | `cd desktop/web && npm run gen:types && npm run check:types` |
| Frontend | `cd desktop/web && npm run typecheck && npm run test:coverage -- --maxWorkers=4 && npm run test:policies && npm run check:ui && npm run build && npm run build:web && npm run test:policies:bundle && npm run check:notices` |
| Species catalog queries | `python3 scripts/species_catalog_contract.py check` and its Python tests |
| LiDAR services | the engine lane (CI job `lidar-native`) and the comparison lane ([data library](docs/guides/data-library.md)) |
| Docs | `python3 scripts/check_docs.py` and its `--drift origin/main` (validator changes: `python3 -m unittest scripts.test_check_docs`) |

Docs-only changes skip code gates; say so in the handoff.

## Working method

- **Work queue** (advice). Work is a queue of todos (not beads unless user-visible). A tweak or correction the user sends mid-task joins the end of the queue; it does not pre-empt the current item. Only an explicit stop or cancel takes effect at once; an item blocked on a user decision waits while the next one runs. Stop only when the queue is empty.
- **Beads** (`bd prime` for commands) track user-visible work, bugs and decisions, not sub-steps. Close with a receipt: what shipped, commits, gates. Commit `.beads/issues.jsonl` when bead metadata changed.
- **Branch and worktrees.** Work branches from `main` (intent-named) and lands by PR. Implement in a worktree under `.rq-scratch/`, never in the user's `cargo tauri dev` checkout ([agentic delivery](docs/guides/agentic-delivery.md#places)). Until 2.1.0, stable fixes land on `release/2.0` ([rules](docs/guides/native-and-release.md#stable-fixes)). A step is pushed once, after its pre-push review.
- **Scope** (advice). Name the user path or roadmap item behind each planned behaviour; drop what has none. Before cutting code, a seam or a behaviour as useless, check the roadmap (hydrology: `docs/plans/hydrology.md`; crown detection: `onf-plugin-adaptation.md`, ADR 0012; LiDAR reading: `data-library.md`) and name what was checked. A refactor keeps what users see, not mechanisms. Never build what a later step of the release replaces. Specs hold contracts; briefs hold line numbers.
- **YAGNI** (advice). Every piece of work must be justified; no overengineering. Engineering fits where the work sits from quick and dirty (throwaway scripts, prototypes) to production grade (the app, user data). Widening scope needs the user's word: propose sensible scope improvements with their reason. Small fixes inside the step's area and release promise are done and reported.
- **Subagents** run in parallel only on disjoint files (coupled work is one sequential stream; advice), each with explicit file ownership; none reverts another's work. A stream owns its feature's locale key namespace in all 11 locales (add, reword, delete). The main agent integrates, runs gates, closes beads and pushes.
- **Multi-agent steps** follow the `phased-agentic-delivery` skill; Canopi's places, commands, live checks and tools: [agentic delivery](docs/guides/agentic-delivery.md). Live checks drive an isolated review instance, never the user's app.
- **Fresh-eyes review** (advice). Before handoff, a fresh subagent (Opus, medium effort) gets only the diff, its intent and the rules and ADRs it touches, and hunts for problems; verify each finding before fixing. Multi-agent steps keep the skill's review rounds too.
- **Mistakes** (advice). No apologies. A mistake means a gap in the instruction files (this file, a guide, the skill, memory): name the gap that caused it and propose the smallest fix (rule, check or test), rewriting an existing rule rather than adding one.
- **Commits** follow `fix(frontend): …`, `docs: …`; stage only your files; generated files go with the commit that produced them; no attribution trailer or mention of Claude in a commit or PR.

## Documentation

Which document answers which question: [`docs/README.md`](docs/README.md). A guide changes only when a rule or boundary changes, and is rewritten, never appended; past budget, cut wiring, never rules. Built plans are deleted once their decisions are ledger rows or ADRs. Wiring lives in module comments and policy tests, not prose.

## Handoff

1. Gates for the changed area passed, or are recorded as skipped with the reason.
2. Bead closed with a receipt; follow-up beads filed.
3. Affected guide (`--drift` names them), pattern, ADR or release notes updated, or the handoff says none needed it.
4. Committed, rebased, pushed (once per step); `git status --short --branch` clean and up to date.
5. Final message: each queue item's outcome, bead id, commit hash, branch, gates run or skipped, user-owned files left untouched, and what to try in `cargo tauri dev`.
