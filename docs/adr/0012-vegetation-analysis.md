# Vegetation analysis: ONF methods and Canopi-authored science in Rust

Status: Accepted (2026-09-26, Canopi v2); amended 2026-10-17 (point clouds are seen and profiled, ledger 2.1-Q79; Web Site data, 2.1-Q114, 2.1-Q122; terrain engines, 2.1-Q37, 2.1-Q58, 2.1-Q65; the job runner, ADR 0024)

## Context

Designers need to know where the existing trees are and how tall they are, where the canopy opens, how much of the site is covered and how the vertical strata are occupied. [ADR 0011](0011-analyses-provenance-and-stories.md) planned canopy analysis on the GeoLibre CLI lane, with Computree as an optional engine.

The better source is the ONF plugin for Computree (`ct_pluginonf`, https://gitlab.com/computree/ct_pluginonf). It has forestry-grade methods built for airborne LiDAR such as IGN LiDAR HD: canopy gaps (JMM/lidaRtRee), tree tops (sigma-optimised Gaussian maxima with a valley-depth neighbour filter), and DTM, DSM and CHM from points.

- **Upstream state.** The repository is no longer maintained. Most files carry an LGPL-3.0-or-later header; 92, including the tree-top chain, carry none, and there is no LICENSE file. An ONF contact confirmed that Canopi may use the code as it wants.
- **Why not C++.** Every step is bound to Qt, OpenCV and Computree's item model. Extracting it would be a rewrite that still ships Qt and OpenCV on every target. A user-installed Computree is about 500 MB, has no macOS arm64 build and has an unverifiable batch mode.
- **What ONF lacks.** Some needed methods have no public ONF implementation, such as crown segmentation from a CHM.

## Decision

- **Port, don't embed.** Canopi translates a chosen set of ONF methods to Rust in a workspace crate, `vegetation/` (package `canopi-vegetation`).
  - The crate is licensed LGPL-3.0-or-later, keeps ONF's notices and records the permission in `vegetation/NOTICE`.
  - Ported code lives in `src/onf/` and names its upstream file at the pinned commit `229ae44d`. That commit is final; Canopi owns the port.
  - The crate depends on nothing Canopi-specific. It reuses `wblidar` and `wbtopology` from the already pinned `opengeos/whitebox-wasm` revision. It uses no OpenCV or Qt.
  - It works in the input's native coordinates only. Every longitude/latitude step (bounds, vector output for the map) goes through the raster engine's one CRS authority, `rust_engine/crs.rs`; the whitebox crates' own `wbprojection` never places data ([ADR 0014](0014-pure-rust-raster-engine.md), A12).
- **Canopi-authored methods.** Where neither ONF nor GeoLibre offers a public method, Canopi implements a published one in `src/methods/`. Crown segmentation (a seeded watershed) is the first case. Each such method:
  - cites its reference in the module, the recipe and the result details;
  - is specified by its module documentation;
  - is tested against synthetic stands with known answers;
  - is cross-checked against an independent open implementation (lidR or lidaRtRee) in a local lane, with the results checked in as goldens;
  - states its limits to users.
- **Correctness over fidelity.** Upstream defects are fixed in the port, each with its own test and a line in the guide:
  - no-data values entering blurs and filters;
  - tree tops taken from the wrong sigma;
  - heights over DTM holes;
  - self-touching polygons;
  - DSM holes filled with the minimum.

  Fidelity tests compare with Computree only on inputs where the two agree.
- **Native lane.** The analysis registry gains a `native` lane. Analyses run in process as jobs of the job runner ([ADR 0024](0024-ownership-and-lifecycle.md), [ADR 0025](0025-failure-model-and-native-scheduling.md)), within its heavy-job capacity and outside the request lanes, so saves and sampling never queue behind them. They cancel through their `CancelToken` at bounded intervals, and are admitted under a 25-million-cell cap (and point-list caps for point metrics). No new sidecar, child process or CI engine is needed: goldens make fidelity a plain `cargo test`.
- **Terrain engines.** The terrain and hydrology engines are decided by ADR 0023's N0 check (2.1-Q37, 2.1-Q65); the Hillshade result is dropped (2.1-Q58). ADR 0011's optional Computree integration is dropped.
- **Scope.** The work is ordered as follows:
  1. Raster canopy from above-ground height: gaps, tree tops, and cover facts.
  2. Point-cloud library items that are seen and profiled (map display coloured by class, height or intensity; a profile through the points; 2.1-Q79, replacing the library-only scope of 2026-09-26) and terrain models from points.
  3. Crowns, gap depth, vegetation structure grids for the syntropic strata, and point cleaning.

  Terrestrial scans, stems, voxels and inventory tools are out of scope. ONF defaults ship with "Forest" and "Orchard / agroforestry" presets over the same analysis parameters.

## Consequences

- The crate is the only LGPL code in Canopi. The combined work is conveyed under AGPL-3.0-or-later. `THIRD_PARTY_NOTICES.md` names the ONF plugin, its commit and the permission, and the notices test checks the pinned revision.
- New library item kinds: point cloud, and vector tree tops, gaps and crowns. Provenance records the engine (`onf` or `canopi`), the method reference and resolved parameters, such as the sigma a recipe chose.
- Detected trees are library data. Turning them into "existing tree" design objects is a later product step through a runtime transaction.
- Validation fixtures include a small IGN LiDAR HD crop (Licence Ouverte Etalab 2.0) with goldens. Reference runs come from Canopi-written `CompuTreeBatch` scripts, with a dev-only harness as a fallback, and from lidR/lidaRtRee; none of them runs in CI or ships.
- Web gets Site data up to a size limit and the terrain analyses in 2.1 (2.1-Q122, ADR 0030). The edition scope of canopy analysis and crown detection is asked at that release's design check, aligned by default (2.1-Q111).
