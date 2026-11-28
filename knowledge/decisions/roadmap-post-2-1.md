---
type: Architecture Decision
title: Post-2.1 roadmap and pre-Phase-3 polish
description: Sequencing of pre-Phase-3 UX polish, Phase 3 native/Wasm splits (N0-N5 + W1), and flagship 2.2+ capabilities.
tags: [roadmap, phase-3, "2.2", ux]
generated: { by: antigravity/gemini, at: 2026-11-28T03:43:35Z }
sources:
  - id: 2-1-foundations-md
    resource: ../../docs/plans/2-1-foundations.md
    title: docs/plans/2-1-foundations.md
    digest: sha256:6f0f956f81acecc6
    last_modified: 2026-11-27T13:50:08Z
  - id: readme-md
    resource: ../../docs/architecture/README.md
    title: docs/architecture/README.md
    digest: sha256:eb912ea2b50c549c
    last_modified: 2026-11-27T10:04:21Z
---

# Pre-Phase-3 UX polish (no `.canopi` v10 schema changes)

- **Normalized dimensions:** consistent metric / US customary quantity editing and display across object inspectors.
- **Bulk replace plant:** replace species across a multi-plant selection in one compound Undo step (option to keep existing size vs. adopt species spread).
- **Aspect lock on zone dimensions:** direct zone dimension editing with aspect-ratio lock.
- **Canvas-only zone dimensions toggle:** device/view-level display toggle (`app/settings/` + canvas renderer); defer PDF toggle to post-2.1.0 so `print_setup` and `.canopi` v10 remain frozen ahead of D3 rollback checks.

# Phase 3: Native crates and Web worker (`N0`–`N5` + `W1`)

- **N0 (E1):** terrain engine selection (GeoLibre-first, in-process, `wasm32`-compatible for Web worker) before `N2` and `N4`.
- **N1–N5:** extract native domain crates (`canopi-library`, `canopi-species`, `canopi-terrain`), close remaining Rust ratchets, and run workspace-wide `cargo-mutants` at phase close.
- **W1:** wire compiled WebAssembly terrain/analysis engines into the Web worker after `N4`'s artifact lands.

# Flagship 2.2+ roadmap

- **Parametric Zone Planting + RTK-GPS:** generate structured planting layouts (origin, angle, in-row spacing, machine-multiple alley width, headland setback, pattern) with RTK-GPS GeoJSON export.
- **Plant Palette two-way bridge (`canopi-palette` v1):** interchange palettes without duplicating a plant palette editor on the website; handle sparse/unmatched catalog entries gracefully.
- **Machine & Canopy Clearance Overlay:** visualize equipment turning/alley clearances against mature canopy spread.
- **Imagery Offset Check:** quick georeference alignment check between satellite imagery and site survey/LiDAR.
- **Design Preflight:** pre-export/pre-planting validation checklist (overlaps, missing data, scale/CRS checks).
- **Mobile Planting Day Mode + Offline Field Pack:** field-ready offline bundle and mobile-friendly planting checklist.
- **Semantic `.canopi` Diff & Merge:** structured comparison and merge of Design changes by object/field authority.
