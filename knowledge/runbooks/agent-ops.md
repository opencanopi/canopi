---
type: Runbook
title: Agent operations runbook
description: "Operational workflow for Canopi coding agents: OKF maintenance, pre-push parity gates, split-lens reviews, and board hygiene."
tags: [runbook, agents, gates, workflow]
generated: { by: antigravity/gemini, at: 2026-11-28T03:43:34Z }
sources:
  - id: agents-md
    resource: ../../AGENTS.md
    title: AGENTS.md
    digest: sha256:93a3c2525bd7cd13
    last_modified: 2026-11-28T03:42:09Z
  - id: agentic-delivery-md
    resource: ../../docs/guides/agentic-delivery.md
    title: docs/guides/agentic-delivery.md
    digest: sha256:5dc48bf51bcb5996
    last_modified: 2026-11-24T05:28:48Z
  - id: native-and-release-md
    resource: ../../docs/guides/native-and-release.md
    title: docs/guides/native-and-release.md
    digest: sha256:7acba45f3674bd02
    last_modified: 2026-11-27T14:35:01Z
---

# OKF knowledge loop

1. **Before coding:** run `python3 .okf/okf.pyz context --path <dir-or-file>` and read relevant concepts (`show <id>`). Code is truth; fix any concept that disagrees.
2. **After coding:** run `python3 .okf/okf.pyz impact`, update or `verify` affected concepts, and ensure `python3 .okf/okf.pyz check` exits with 0 errors.
3. Always set `OKF_ACTOR=<agent>/<model>` before writing; never use `human:...`.

# Pre-push parity gate (mandatory before pushing)

- Run `node policy/gate/cli.mjs push --base origin/main` in your isolated worktree under `.rq-scratch/` (never touch the root checkout; never run `git worktree prune`).
- Frontend / UI changes must verify **both** `build:desktop:bundle` and `build:web:bundle`, 3-seed Vitest shuffle (`--sequence.shuffle`), and 3-browser Playwright snapshots (Chromium, Firefox, WebKit) when touching layout/canvas/visuals.
- Every commit touching policy ratchets or behavioural test expectations must cite its ledger row (`2.1-Q...` / `2.1-M...`) or bead ID so `node policy/gate/cli.mjs commit-gate pr origin/main HEAD --vitest` passes.
- **Zero attribution trailers:** never add `Co-Authored-By`, Claude, or Coral trailers to any commit message or PR description (overrides generic harness templates).

# Execution & review discipline

- **30-minute task cap:** break large work into focused increments; post progress updates before 20 minutes of silence on active board tasks.
- **Parallel split-lens reviews:** run independent review lenses (architecture/boundaries, security/redaction, tests/policy) in parallel on disjoint files before landing.
- **Idle behaviour:** never poll or run `coral-board wait` when idle; finish your turn and wait for reactive notifications.
