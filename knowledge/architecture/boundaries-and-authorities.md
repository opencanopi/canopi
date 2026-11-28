---
type: Architecture
title: Boundaries and authorities
description: Exclusive ownership of Design fields, Phase 2 frontend layers, Phase 3 Rust crate split targets, and the 5-question Boundary Gate.
tags: [architecture, boundaries, authorities]
generated: { by: antigravity/gemini, at: 2026-11-28T03:43:34Z }
sources:
  - id: agents-md
    resource: ../../AGENTS.md
    title: AGENTS.md
    digest: sha256:93a3c2525bd7cd13
    last_modified: 2026-11-28T03:42:09Z
  - id: design-rs
    resource: ../../canopi-types/src/design.rs
    title: canopi-types/src/design.rs
    digest: sha256:0792269ffe6fa9d8
    last_modified: 2026-11-26T19:23:10Z
  - id: readme-md
    resource: ../../docs/architecture/README.md
    title: docs/architecture/README.md
    digest: sha256:eb912ea2b50c549c
    last_modified: 2026-11-27T10:04:21Z
  - id: 2-1-foundations-md
    resource: ../../docs/plans/2-1-foundations.md
    title: docs/plans/2-1-foundations.md
    digest: sha256:6f0f956f81acecc6
    last_modified: 2026-11-27T13:50:08Z
---

# Exclusive Design authorities

`DESIGN_FILE_FIELDS` in `canopi-types/src/design.rs` assigns every `.canopi` field to exactly one owner:

- **Scene (`canvas/runtime/scene-runtime/`):** spatial geometry, plants, zones, and canvas objects edited via runtime transactions; only the canvas draws highlights.
- **Document (`app/design-edit/`):** document metadata, views, budget, story, and print setup edited via Design Edit commands.
- **Map layers & settings:** the map layer store owns map layers; `app/settings/` owns device state. Panels read canvas state through read-only queries.

# Phase 2 frontend boundaries (landed)

- **Edition ports (`platform/edition-ports.ts`):** all Desktop vs. Web differences live behind typed ports (`FileDelivery`, `DataLibrary`, `Settings`, `DesignCore`, `Geocoding`); feature code has zero edition checks.
- **Unified command table (`app/command-table/`):** keyboard shortcuts, menu bar, and context menus share one declarative command table.
- **Units & formatting (`src/utils/format.ts`, quantity owner):** metric and US customary units route through one quantity owner across canvas, scale bar, species, LiDAR elevation, and PDF export.
- **Single-instance & native scheduling:** every `#[tauri::command]` is executor-backed async or a reviewed bounded synchronous command.

# Phase 3 Rust crate split targets (ADR 0023)

- `canopi-types` (shared wire types, `DESIGN_FILE_FIELDS`, failure catalogue, edition capabilities)
- `canopi-format` + `canopi-format-wasm` (`.canopi` v9/v10 codec & frozen migration steps)
- `canopi-support` (durable file I/O, atomic writes, shared primitives)
- `canopi-redact` (credential & path redaction)
- Phase 3 targets: extract domain services (`canopi-library` for Data library / LiDAR catalogue, `canopi-species` for species search & ranking, `canopi-terrain` for in-process wasm-compatible terrain engines) so `desktop` remains a thin Tauri shell.

# 5-question Boundary Gate for new features

Before designing or coding a new feature, answer all five questions:

1. **Owner:** Which single module/authority owns the state and mutations (`DESIGN_FILE_FIELDS`, `app/settings/`, or derived view state)?
2. **Stored format:** Does it touch `.canopi` v10 or any user store (requiring a frozen migration step / reader-release check), or can it stay device/view-level?
3. **Edition parity:** Does it work on both Desktop and Web through `EditionPorts` without edition conditionals in feature code?
4. **Failure & redaction:** Do errors flow through the typed failure catalogue and `Sensitive<T>`/`UserPath` redaction?
5. **Verification:** What behavioural test (and policy ratchet / real-app or browser check) proves the boundary holds?
