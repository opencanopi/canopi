# Documentation map

Every document answers one of four questions. Start with the narrowest one for your task. Code shows current behaviour; these documents state the intended boundaries.

| Question | Where |
| --- | --- |
| What must never change, and why? | [`AGENTS.md`](../AGENTS.md), [`architecture.md`](architecture.md), [`adr/`](adr/) |
| Which diagram, owner and example for my change? | [`architecture/`](architecture/README.md) |
| What did the user decide, and in whose words? | the release's decision ledger in [`decisions/`](decisions/2-1.md) |
| What does the finished thing look like? | [`.interface-design/system.md`](../.interface-design/system.md), its pattern files and [boards](../.interface-design/boards/README.md), the UI gallery (`cd desktop/web && npm run dev:ui`) |
| Where is this area's boundary? | one guide per area in [`guides/`](guides/) (see below) |
| What changed for users? | [`release-notes/`](release-notes/), the in-app Getting started |

Also: [`workflow.md`](workflow.md) for bead commands and triage labels; [`review-checklist.md`](review-checklist.md) for what to try before a release; [`plans/`](plans/) for agreed but unbuilt work (the canvas v2 plan, spec, inventory and implementation prompt behind ADRs [0015](adr/0015-rotating-map-and-canvas-controls.md) to [0020](adr/0020-focus-and-keyboard-ownership.md) were deleted at the 2.0 release close; `git log -1 --diff-filter=D -- docs/plans/canvas-v2-plan.md` names the deleting commit, whose parent holds them); [`CONTEXT.md`](../CONTEXT.md) for product vocabulary.

The 2.1 foundation work behind ADRs [0022](adr/0022-module-map-and-dependency-direction.md) to [0030](adr/0030-edition-parity.md) starts at [`plans/2-1-foundations.md`](plans/2-1-foundations.md), with its [contracts](plans/2-1-foundations-contracts.md).

## Guides

| Area | Guide |
| --- | --- |
| Map canvas, scene runtime, renderer, camera, input, tools, snapshots | [map-workspace.md](guides/map-workspace.md) |
| `.canopi` format, Design Edit, settings, views and stories | [design-document.md](guides/design-document.md) |
| LiDAR library, Site data, analyses | [data-library.md](guides/data-library.md) |
| Frontend structure, commands, keys and focus, localisation, tests | [frontend.md](guides/frontend.md) |
| Terms per locale and copy rules | [ui-glossary.md](guides/ui-glossary.md) |
| Desktop, Web, phones, the gallery | [editions.md](guides/editions.md) |
| Plant catalog and search | [species-catalog.md](guides/species-catalog.md) |
| Planting-plan PDF | [pdf-export.md](guides/pdf-export.md) |
| Native rules, build, release, problem reports | [native-and-release.md](guides/native-and-release.md) |
| How agents run multi-agent steps: places, commands, live check, tracker | [agentic-delivery.md](guides/agentic-delivery.md) |

## Rules for these documents

- A guide states authorities, boundaries, rules with the test that enforces each, mistakes to avoid and where to look. It never narrates how code is wired; that lives in module comments and policy tests.
- A guide is rewritten when a rule or boundary changes. Nothing is appended. `python3 scripts/check_docs.py` enforces the size budgets (12 KB per guide, 600 characters per paragraph) and the links.
- ADRs are at most 60 lines with a `Status:` header. A replaced ADR is marked `Superseded` with `superseded_by:`.
- Plans carry a `Status:` line and are deleted once built. Receipts, evidence and task state live in bd, not here.
- A decision ledger (`decisions/<release>.md`) holds one row per user decision: id, date, the decision, the user's words, what it supersedes and what implements it. Docs, tests and commits cite the id; a later answer adds a row and marks the old one, never edits it. `check_docs.py` checks each row's id, date, implementation and cited ADRs.
- Release notes are written once per release, for users.
- Once per release, each guide is read against the code and stale text deleted.
