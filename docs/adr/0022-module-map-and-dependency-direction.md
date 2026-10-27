# Module map and dependency direction

Status: Accepted (2026-10-16, Canopi 2.1 target; built by the 2.1 foundation phases); amended 2026-10-17 (Q34 format core; Q45 pass; the module-map run, the clean sheet and the prototypes: ledger 2.1-Q47, 2.1-M4 to 2.1-M6, 2.1-M11, 2.1-M12, 2.1-M19, 2.1-Q122); amended 2026-10-17 (the reader release: 2.1-Q138, 2.1-M21); amended 2026-10-17 (the layer table's landing change rewrites the path lists: 2.1-M20); amended 2026-10-22 (the layer table's packages and editions, rule ids: 2.1-M185, 2.1-M189, 2.1-M191); amended 2026-10-27 (the layer table built: 2.1-M243 to 2.1-M250, 2.1-M255)

## Context

In 2.0 the frontend has 37 of 40 areas in one cycle. The edition is picked three ways: vite aliases, `src/web` composition and `edition` props. `platform/` mixes adapters with an edition bootstrap, and `web/` mixes adapters with session and panel code. The shell command catalog, the modal check and the key-router install exist twice. The user chose target B, layered domains with edition roots (2.1-Q1), and confirmed the likely-change list (2.1-Q2). The module-map run on today's code found 137 violations of this table.

## Decision

- **Layers.** Every top-level path under `desktop/web/src/`, directory or root file, belongs to exactly one layer, or the layer table names its destination and the phase that moves it; the fail-closed checker refuses a path with no layer. A layer imports only from layers below it; inside L1 and L2 a directory imports only those before it in the listed order (`<`; names sharing a rank import none of each other), and L3 features import each other with no cycle. Test files sit outside the order and no product module imports one. A path marked "new" does not exist at the v2.0.0 tag.
  - The layer table's one owner is `policy/layers.json` (Phase 0 F1a: path, layer, rank, destination, phase, edition; and a `packages` section: pattern, lowest layer or owner, chunk, editions), which generates the dependency-cruiser and ast-grep configs, the chunk groups, knip's entries, the module-map run and the Web build boundary facts; it generates no vite alias or tsconfig path, which 2a deletes. The lists below keep what each layer owns; on a path's placement the table is right (2.1-M185, 2.1-M255).
  - L0 pure (may import `@preact/signals`; `i18n/` alone imports `i18next`, rule `i18next-only-in-i18n`, 2.1-M243): `generated/`, `types/`, `i18n/` (it owns the active-locale signal; `app/settings/` sets it only through `i18n`'s `setActiveLocale()`), `utils/`, the ambient `*.d.ts`, `styles/`, `assets/`.
    - Also L0: `geo/` (new, 2a: session plane, projection, camera policy and the view module); `planning/` (new, 2a: civil date, time model, succession phases); `types/design-scope.ts` (the Design scope type and its registration API) and `types/design-fields.ts` (`SceneFields` and `DocumentFields`, generated from `DESIGN_FILE_FIELDS`); `types/map-overlay-visuals.ts` (fixed overlay tokens; colours that follow the theme are arguments).
  - L1 adapters: `failures/` (new, Phase 1: `reportFailure`, the diagnostics ring, the notice signal, the per-store open status and `redact.ts`; imported directly, no port) < `ipc/` < `maplibre/`, `platform/` (each port file with its `.desktop.ts` and `.browser.ts` adapter beside it, listed in contracts §22, plus the one-implementation adapters `clipboard.ts` and `page-rules.ts`). `maplibre/` imports nothing from `canvas/` and hosts a scene through the `ScenePainter` port it declares in `maplibre/scene-host-layer.ts`.
  - L2 runtimes: `app/settings/` (every settings-backed signal but the locale; `utils/theme.ts` moves in, 2a) < `app/command-table/` (new, 2a: one command and tool table with placement, edition requirements and the availability and modal queries; imports no feature; roots bind handlers) < `canvas/` (with renderer snapshot types) < `app/design-edit/document/` (new, 2b: Document-field state, the Document half's apply and inverse for each write, and `admission.ts`; the Design history order is the Session core's, ADR 0024) < `app/document-session/core/` (new, 2b: the scope and the Session core).
  - L3 features: the other `app/*`, with `app/record-workbench/` (stamp and Notebook stores) and `target/` (2.1-M244); Document writer commands stay in `app/design-edit/` and edit through `core.document()`; `app/lidar/` becomes `app/data-library/` in 2a (2.1-M4, 2.1-M43); `commands/`, `app/canvas-commands/` and `app/shell-commands/` merge into `app/command-table/` and are deleted, the Desktop window and keymap bindings going to `editions/desktop/` (2a). Panels never import each other. L4 surfaces: `components/*`, an error boundary per surface; `app.tsx` moves to `components/shell/` (2a).
  - L5 edition roots: `editions/desktop/`, `editions/web/` and `editions/gallery/` (new, 2a). A root builds one `EditionPorts` record (every port binding plus the edition-capabilities set, ADR 0030), installs it once before mounting, calls `installAppLifetime(ports)` and installs the key router. No root binds a callback upward: a question that blocks a close or replacement is Session state answered by `core.answer` (2.1-M162).
    - The gallery root (`editions/gallery/`, from `ui-gallery/` in 2a) binds every port as contracts §13 says: storage ports run their real browser adapter over an in-memory backend, the Data library replays transcripts the real commands write, other ports are recording fakes; no Tauri import, imported by no other bundle.
- **One edition mechanism.** A root imports its adapters. Vite aliases and `edition` props are deleted; `web/` is dissolved into adapters beside their ports, `editions/web/` and the Session core. The `.browser.ts` and `.desktop.ts` suffixes mean only "this edition's adapter of the port beside it". Feature code never checks the edition (ADR 0030). The Web bundle never contains Tauri (ADR 0005). Menus, the modal check and key routing read the one command table; shortcut text comes only from the keymap.
- **Ports only where** two implementations exist or a lower layer is inverted; each is one `platform/` file listed in contracts §22: DesignHome store (L10, L17, L21: the Draft records are its browser adapter's internal seam), the design core (L5), FileDelivery (L12), file access (L9), the app lifecycle, the geocoding transport (L23), the species reader (L20, under 2.1-E1 outcome B only). Inversion: `ScenePainter` (L8), declared by `maplibre/`, one implementation. One implementation gets an adapter: MapPorts (L7), the Pixi kit, the geocoder provider, Desktop window control.
  - Also ports: the settings store (`platform/settings.ts`, L16), the Data library with display resolution (`platform/library.ts`, L21, 2.1-M132), saved stamps, the Design notebook and species user lists (`saved-stamps.ts`, `design-notebook.ts`, `species-lists.ts`; L21, 2.1-Q173). Small capped records may be `localStorage`, only through `platform/browser-record.ts`; records that grow use IndexedDB. Each port names the L-row it protects against.
- **Earlier ADRs read as claims.** ADRs 0015 to 0020 stay as written except ADR 0016 (true ground metres, 2.1-Q78d) and ADR 0018, edited where this target contradicts them; ADR 0021's after-2.0 rule is replaced by ADR 0026; ADRs 0005, 0006, 0007 and 0012 follow ADR 0030.
- **Canopi Rust on Web.** One wasm adapter per `-wasm` crate, each the only importer of its glue (ADR 0002): `platform/design-core.worker.ts` runs `canopi-format-wasm` in a worker on both editions (decode from Step 2.0.4, the whole core from 2b; 2.1-M154); `platform/page-rules.ts` loads `canopi-page-rules-wasm` in the page (2.1-M104; Phase 3 N4). Phase 3 N5 adds `canopi-library-wasm`, the catalogue in a library worker over OPFS (2.1-Q122, 2.1-M151). Web has no cross-origin isolation (COEP `require-corp` would block Google tiles and Commons photos), so wasm on Web runs single-threaded.

| # | Likely change | One owner |
|---|---|---|
| L1 | New analysis | `analyses/<x>.rs` + registry row (output quantity, sentinels) + its quantity row when the quantity is new (the descriptor's scale and quantity columns are generated from it and the recipe) + golden fixture |
| L2 | Whole-grid and vector results | `LibraryItemKind` in `canopi-types`, matched in `kinds.rs` (a variant per output kind, 2.1-Q10, 2.1-M46) + `maplibre/library-layers.ts`; never a Design object |
| L3 | Point clouds (see and profile, 2.1-Q79), crowns | `import/formats/*` with its generated accepted-format list + the `PointCloud` kind + `canopi-vegetation`; CRS from the `crs` leaf |
| L4 | Bring-your-own result | `lineage` (one field, ADR 0023) + the descriptor's lineage table; panels never read `role` or `provenance` |
| L5 | New `.canopi` field | `DESIGN_FILE_FIELDS` + `canopi-format`; generated `types/design-fields.ts`, factory and admission constants |
| L6 | New locale | locale registry in `canopi-types`; glossary as data; the catalog side crosses L20 |
| L7 | MapLibre major | `maplibre/` (`scene-host-layer.ts` included): per-consumer `Pick<>` ports, DOM class constants, CSS import, `createFakeMap()` |
| L8 | Pixi major | `canvas/runtime/renderers/` and the Pixi kit only (the `ScenePainter` implementation); `maplibre/scene-host-layer.ts` belongs to L7 |
| L9 | Tauri, WebKitGTK, WebView2, WKWebView | the `platform/*.desktop.ts` adapters + Rust `host/` |
| L10 | Open from URL on Web | the Session core's `openFrom(source)` |
| L11 | Snapping, press point | one ToolHost reducer section (ADR 0024) |
| L12 | Export format | one FileDelivery row per format |
| L13 | Map layer source | a workspace map contribution with `ownsResource` |
| L14 | Failure kind, report line | the failure catalogue + `reportFailure` |
| L15 | Long native job | the `jobs.rs` runner |
| L16 | Settings field | the settings field table in `canopi-types` |
| L17 | Session behaviour | `app/document-session/core/*` |
| L18 | Canvas tool | tool row in `app/command-table/tools.ts` + tool module and its factory entry in `canvas/runtime/tools/`; `_tool` the owner |
| L19 | Dependency bumps | the L7-L9 adapters, `deny.toml`, Renovate |
| L20 | Catalog schema | `scripts/schema-contract.json` |
| L21 | Web browser storage backend (Drafts, Data library, saved stamps, Notebook, species lists; 2.1-M19) | each store's browser adapter in `platform/`; the Draft records in `platform/draft-records.browser.ts`, behind DesignHomeStore |
| L22 | Whole-grid engine | a `canopi-library` engine module, chosen at N0 among wasm-capable in-process crates (ADR 0023) |
| L23 | Geocoder provider | `app/geocoding/` provider adapter; the transport is `platform/geocoding.ts` |
| L24 | Unit system or quantity | the quantity table in `canopi-types` + `utils/format.ts` |

## Alternatives rejected

- **A, owners in place**, keeps kinds raster-shaped and editions mixed, so hydrology and crowns touch every area; **C, ports for every service**, adds abstractions with one implementation; **splitting `app/settings/` into a record (L2) and a projection (L3)** removes no edge once settings owns every settings-backed signal (the prototype).

## Checks

- dependency-cruiser `layer-order`, `edition-roots`, `no-product-imports-a-test` and the package owner rules `tauri-only-in-native-host`, `ipc-only-in-desktop-adapters`, `pixi-only-in-renderers`, `maplibre-gl-only-in-maplibre` and `i18next-only-in-i18n` (Phase 0 ratchets generated from the layer table); `command-table-imports-no-feature`, `one-command-catalog` and `edition-ports-installed-only-by-roots` (Phase 2a, planned rows, 2.1-M223); `wasm-glue-only-in-adapter` per adapter, with its crate (Step 2.0.4, Phases N4, N5). Each id here is in `policy-tables-check --list-rules` (2.1-M189).
- The Web build boundary check (exists), its facts from the layer table (F1a). The import, symbol and call boundaries the retired frontend architecture policy suite held are rules in `policy/rules.json` and `policy/primitives.json` (2.1-M250).
