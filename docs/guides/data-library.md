# Data Library

Covers: `desktop/src/services/lidar/`, `desktop/web/src/app/lidar/`, `desktop/web/src/app/analyses/`

## Purpose

Boundaries for Canopi Desktop's store of LiDAR terrain rasters (imported and derived), their display and the analysis registry. Why: [ADR 0002](../adr/0002-geolibre-module-reuse.md), [ADR 0021](../adr/0021-canopi-2-breaks-stored-data.md), [ADR 0011](../adr/0011-analyses-provenance-and-stories.md), [ADR 0012](../adr/0012-vegetation-analysis.md), [ADR 0014](../adr/0014-pure-rust-raster-engine.md). Paths are under `desktop/src/services/lidar/` or `desktop/web/src/`; each rule ends with its test, or "(advice)".

## Authorities and boundaries

- **The library** (catalogue `$APPDATA/lidar/lidar-library.sqlite`) owns originals, generations, derived items, quality masks, jobs, processing history and display derivatives. Closing a panel or switching Designs never stops library work; only Cancel does.
- **A Design** owns only a `visible` flag and ordered references `{ kind, id, name, visible, opacity, order, ramp, reversed, range }` (`common-types/src/lidar.rs`), edited through `app/design-edit/lidar.ts` with no undo (`__tests__/design-edit-lidar`). It never holds paths, pixels or library state; a missing item stays listed by name until removed.
- **Numeric reads, analysis and display are separate.** Display colour and resampling never feed analysis; a displayed colour is never a measurement; row values and profiles read the native cell.
- **The registry** (`common-types/analysis-registry.json`) says what an analysis is; executors in `analyses/` say how it runs. The native side validates every request; the frontend only mirrors the rules for inline errors.
- **Camera and map style** never change raster geography, library data or results, and never start an analysis.
- **Web** has no library, import, display or analysis and round-trips the Design's `lidar` section unchanged. (`desktop/web/scripts/check-web-build-boundaries.mjs`, `browser-workspace-reaches-no-desktop`)

## Rules

- One catalogue schema, `CATALOGUE_VERSION` (`catalogue.rs`), no migration ladder. Every original carries a complete `sources/<sha256>/meta.json` (`source_meta.rs`); an older or corrupt catalogue is set aside and rebuilt from them, ids kept, items re-prepared on Retry; a newer one is refused and an unopenable one is `Unavailable`, both empty and read-only. Recovery never deletes an original. (`mod.rs` recovery tests, `recovery.rs`, `source_meta.rs` tests)
- How the library opened is health: `SubsystemHealth.lidar_library` carries the state and counts, never paths or reasons; the degraded banner shows the read-only states, the Data library every non-ready one. (`health.rs` and `recovery.rs` tests, `__tests__/lidar-library-health.test.tsx`)
- An import publishes one fixed item from one batch; listed order is source priority (first valid sample wins, NoData reveals the next). A published item never changes its sources. (`import.rs` tests)
- Files first, then references: originals to `sources/<sha256>/original`, COGs to `assets/<sha256>/cog.tif` by idempotent rename, then one `BEGIN IMMEDIATE` transaction writes the rows; a crash leaves no item or a whole one. Cancel withdraws a running import: a first import's item goes, a Retry's is Failed again, its originals kept until Dismiss. Leased, a settling job, Dismiss and Delete free unclaimed files (Import, Retry and Dismiss wait); startup sweeps the rest. (`fixed_library_tests.rs`)
- A run publishes all outputs or none, only while every input is still at its pinned generation; superseded generations stay for history. Restart marks unfinished jobs failed (`analyses/mod.rs`, `recover_interrupted_jobs`) and recalculates nothing. (`analyses/tests.rs`; restart only in the `e2e_*` lanes)
- Refresh and Retry are one operation (`lidar_rerun_analysis`): same item ids, new generation, so every Design sees the new result. Refresh is explicit; staleness (`InputUpdated`, `InputStale`, `RecipeUpdated`, `ToolUpdated`) is only shown. (`analyses/tests.rs`)
- Quantities and units are declared at import, never inferred from a filename, band description or value range; identical bytes meaning different things are distinct items; derived quantities are not importable. (`import.rs` tests, `RasterQuantity::is_importable`)
- Admitted input: single-band numeric GeoTIFF in a supported CRS, north-up, identity scale and offset, no dataset mask, at least one valid sample; a batch shares CRS and pixel size and is lattice-aligned. Zero and negative samples are data. A refusal (`LidarImportRefusal`, localised in `lidar-failures.ts`) names only the file and adds nothing; a failed job's reason goes to the log, not the page (user, 2026-10-15). (`admission.rs`, `import.rs` tests, `fixed_library_tests.rs`)
- Safety bounds: 2 GiB per file, 24 files and 2 GiB per import, 400 M cells per collection charged per source before it converts (`admission.rs`); 25 M cells for any whole-raster read (`MAX_RAW_EXTRACTION_CELLS`, `import.rs`); windows of at most 1024² plus `MAX_RECIPE_HALO` (2); a 4 MiB metadata ceiling and 256 MiB free-space floor (`prepared_raster.rs`). (unit tests in each module)
- Offers read catalogue facts (`crs_class` recorded at import), so the 1.5 s poll reads no raster. Unavailable reasons are named (`AnalysisUnavailable`), never chosen silently. (`analyses/tests.rs`, `__tests__/analysis-model.test.ts`)
- Every registry entry has exactly one executor; a job runs only the recipe version it was pinned to. (`analyses/tests.rs`, `cargo test -p bindings-gen analysis_registry`)
- The GeoLibre windowed lane stages with the exact `-2^127` sentinel (`STAGING_NODATA`, `analyses/windowed.rs`); non-finite outputs, the tool marker and the sentinel never reach a published raster. (`geolibre_slope_matches_the_analytic_surface_across_a_chunk_seam` in the `lidar-native` lane)
- Display derivatives (`DISPLAY_PROFILE`, `display_cog.rs`) are regenerable, written in EPSG:3857 on one global lattice, nearest neighbour (`rust_engine/warp.rs`), staged outside the asset scope, renamed into `display-cog/` when complete; keys hold profile, generation and variant (`-relief`); startup prunes other profiles. (`display_cog.rs`, `warp.rs`, `rust-display-cog.test.ts`)
- The WebView reaches only `$APPDATA/lidar/display-cog/*.tif` (asset scope in `desktop/tauri.conf.json`); originals, staging, scratch and numeric rasters stay out. (`__tests__/tauri-csp.test.ts` for CSP; scope is advice)
- Styles and `displayVariant` dispatch on the quantity in `app/lidar/item-types.ts`, the only module knowing item types, in stored units (percent slope never draws as degrees). MNT, MNS and MNH open on Relief; Cut outliers is Colours-only. Blue is for water. (`__tests__/item-types.test.ts`, `app/lidar/display-legend.test.ts`)
- Delete everywhere is separate from Remove from Design; an item results depend on is refused with the count (`lidar_delete_impact`), rechecked in the transaction. It frees files no other item uses, now or, while a job runs, at next start (user, 2026-10-15). No Design references are tracked; the confirmation says so. (`mod.rs` tests, `__tests__/lidar-actions.test.ts`)
- An import joins the Design session that asked; an analysis joins it when that Design shows the input (`pendingAttachments`, `app/lidar/actions.ts`); a switch, failure or cancel drops the attachment. (`__tests__/lidar-actions.test.ts`)
- Add to Design is idempotent and keeps the camera; Fit uses the viewport command, 48 px padding, capped at zoom 18 (`app/lidar/camera-request.ts`). (`__tests__/lidar-camera-navigation.test.ts`)
- LiDAR commands are executor-backed except the bounded cancels: raster jobs on `Raster`; sampling (one at a time, ≤ 8 targets, ≤ 4,096 points) and disk scans on `Local`; catalogue work and Import's and Retry's header check (capped TIFF directories and tile index; hung mounts stall it) on `UserData`. (`native_command_policy::tests`)
- Raster work runs in process on `rust_engine/`, the only production `RasterEngine`, checked by the test-only GDAL oracle `gdal_engine.rs` (comparison lane); probes read only headers. (`rust_engine` tests)
- One CRS authority (ADR 0014): `rust_engine/crs.rs` on the `crs_table.rs` rows (`proj4rs`), every transform via WGS84, serves placement, extents, coverage, sampling and the display warp. References are `EPSG:n` in `crs_ref`; `crs_class` comes from the row; written keys are codes only; analysis stays native. A new code is a row, its reference points and its `ROW_DIGESTS` line. (`crs.rs` tests, `a_pixel_centre_shows_the_value_hover_reads_there`)
- A GeoTIFF converts in row windows of at most `MAX_RAW_EXTRACTION_CELLS`, byte-identical to a whole conversion; a compressed chunk decoding above 64 MiB loads whole. (`geotiff_sources_stream_under_the_limit_into_the_whole_raster_bytes`)
- The GeoLibre child runs with fixed argv, no shell, bounded output and duration, logging under `engine-logs/`; a cancelled child is killed and publishes nothing. (`process.rs`, `geolibre.rs` tests)
- `desktop/THIRD_PARTY_NOTICES.md` names the raster crates and the GeoLibre CLI revision (`__tests__/third-party-notices.test.ts`); `geolibre.rs`'s `GEOLIBRE_REVISION` matches `scripts/build-geolibre-cli.sh` (its tests).

## Environment and commands

- GeoLibre CLI: `CANOPI_GEOLIBRE_BIN`, beside the executable, then `PATH` (`geolibre.rs` tests); built by `scripts/build-geolibre-cli.sh` and bundled as a Tauri sidecar ([native and release](native-and-release.md)).
- Engine lane: the CI job `lidar-native` (`.github/workflows/build.yml`) runs the ignored `services::lidar` tests and skips by name those whose `#[ignore]` reason starts with `local fixture: ` (`ci_lane_policy::tests`).
- Comparison lane (local; GDAL tools via `CANOPI_LIDAR_GDAL_BIN` or `PATH`; skips without them): `cargo test -p canopi-desktop --lib rust_engine::comparison -- --ignored --nocapture`.
- Fixture lanes (local; no fixtures is not a pass): `CANOPI_LIDAR_E2E_FIXTURE=<IGN MNT GeoTIFF>`, `CANOPI_LIDAR_MNH_DIR=<IGN MNH tiles>`, then `cargo test -p canopi-desktop --lib -- --ignored --test-threads=1 --nocapture` (`e2e.rs`).
- Raster diagnostics: `localStorage['canopi.rasterDiagnostics']='1'`.

## Do not

- Add a catalogue migration or compatibility reader; bump `CATALOGUE_VERSION` and let the rebuild carry the data.
- Transform coordinates outside `crs.rs`, through `wbprojection`, or from the GeoLibre CLI's WGS84 output.
- Store a library path, pixel or runtime URL in a `.canopi`, log or Problem Report.
- Materialise a merged raster, union grid or absent-coordinate walk.
- Read raster pixels in the poll, in offers or on `UserData`.
- Add an analysis by code alone: registry entry, one executor, locale keys ([AGENTS.md](../../AGENTS.md)).

## Where to look

| Area | Module | Tests |
|---|---|---|
| Admission, import, publication | `admission.rs`, `import.rs`, `collection.rs`, `generation.rs` | inline tests, `fixed_library_tests.rs`, `e2e.rs` |
| Catalogue, paths, sweep, recovery | `catalogue.rs`, `paths.rs`, `mod.rs`, `recovery.rs`, `source_meta.rs` | inline tests |
| Registry, executors | `common-types/analysis-registry.json`, `common-types/src/analysis_registry.rs`, `analyses/` | `analyses/tests.rs`, `bindings-gen analysis_registry` |
| Engines, readers, CRS | `engine.rs`, `rust_engine/` (`crs.rs`, `crs_table.rs`), `geolibre.rs`, `prepared_raster.rs` | inline tests, comparison lane, `lidar-native` lane |
| Display | `display_cog.rs`, `rust_engine/warp.rs`, `maplibre/raster-display/`, `app/lidar/display.ts`, `item-types.ts` | `__tests__/raster-display-*`, `lidar-display`, `item-types` |
| Commands, policy | `desktop/src/commands/lidar.rs`, `native_command_policy.rs` | `native_command_policy::tests` |
| Frontend state, actions | `app/lidar/`, `app/analyses/model.ts` | `__tests__/lidar-*`, `analysis-model`, `analyze-dialog` |
| Site data, library, dialogs | `components/panels/lidar/`, `components/panels/analyze/` | `__tests__/lidar-site-data`, `lidar-data-dialogs`, `layer-panel` |

## Open decisions

None tracked.
