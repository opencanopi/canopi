---
type: Project
title: Canopi
description: Geolocated permaculture and landscape design studio shipping Desktop (Tauri + Rust + Preact) and Web editions from one codebase.
tags: [project]
generated: { by: antigravity/gemini, at: 2026-11-28T03:43:33Z }
sources:
  - id: readme
    resource: ../../README.md
    title: README.md
    digest: sha256:4ea9db75e1abe61e
    last_modified: 2026-11-13T07:58:22Z
  - id: cargo-toml
    resource: ../../Cargo.toml
    title: Cargo.toml
    digest: sha256:08aca1a4adb130c3
    last_modified: 2026-11-28T02:09:52Z
  - id: readme-md
    resource: ../../docs/architecture/README.md
    title: docs/architecture/README.md
    digest: sha256:eb912ea2b50c549c
    last_modified: 2026-11-27T10:04:21Z
---

# Purpose

Canopi combines a species catalog with a geolocated design canvas that is the map itself: every Design is drawn over a basemap, satellite imagery, LiDAR and terrain. It serves permaculture designers, agroforesters and landscape planners who work on real sites across Desktop (Windows, Linux, macOS) and Web.

# Stack and editions

- **Frontend (`desktop/web/`):** Preact, `@preact/signals`, CSS Modules, MapLibre GL, PixiJS canvas renderer, Vite + TypeScript.
- **Native host & core (`Cargo.toml`):** Rust 2024 workspace (`desktop`, `canopi-types`, `canopi-redact`, `canopi-support`, `canopi-format`, `canopi-format-wasm`, `bindings-gen`) with Tauri 2 on Desktop and WebAssembly (`canopi-format-wasm`) on Web.
- **Edition parity (ADR 0030):** Feature code imports `EditionPorts` (`desktop/web/src/platform/edition-ports.ts`), never edition checks; Desktop and Web wire concrete adapters in their edition roots (`desktop/web/src/editions/`).

# Key authorities

- **Version authority:** `Cargo.toml [workspace.package]` is the sole version owner (`desktop/tauri.conf.json` and `desktop/web/package.json` carry no version copy).
- **Stored formats:** `.canopi` files store WGS84 lon/lat; runtime geometry is metres in the session plane.
- **Knowledge & rules:** See [Boundaries and authorities](/architecture/boundaries-and-authorities.md), [Agent operations](/runbooks/agent-ops.md), and [Post-2.1 roadmap](/decisions/roadmap-post-2-1.md).
