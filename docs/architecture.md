# Canopi v2 architecture

Canopi is a desktop (Tauri) and Web app for designing agroecological sites on a map. This page states the architecture as rules, each with its ADR. Area boundaries live in the guides linked from [`AGENTS.md`](../AGENTS.md); rationale lives in [ADRs](adr/).

## Principles

1. **The map is the canvas.** Basemap, satellite, LiDAR and terrain are the background of the design surface. There is no separate local canvas and no Design location ([ADR 0001](adr/0001-geolocated-map-canvas.md)).
2. **Every design object is geolocated.** Files store WGS84 longitude/latitude; metres exist only in the runtime's session plane ([ADR 0001](adr/0001-geolocated-map-canvas.md)).
3. **Reuse GeoLibre before writing code.** Generic GIS pieces are copied with attribution or depended on as light packages; Canopi never forks the GeoLibre app or imports its React code ([ADR 0002](adr/0002-geolibre-module-reuse.md)).
4. **Stored data moves forward from 2.0**; newer and pre-2.0 data are refused or left unread ([ADR 0026](adr/0026-stored-data-after-2-0.md), [Persistence of app data](#persistence-of-app-data)).
5. **Delete, don't deprecate.** Dead code, docs, tests, scripts and dependencies go in the change that makes them dead.

## Stack

- Backend: Rust workspace (Tauri v2, rusqlite, specta). `desktop/src/` holds IPC commands, services and DB access; `common-types/` the cross-language contracts; `bindings-gen/` the TypeScript transport generator.
- Frontend: Preact, `@preact/signals`, TypeScript, Vite, CSS Modules, i18next core with 11 UI languages, in `desktop/web/src/`.
- Map and scene: MapLibre GL JS owns the WebGL2 context and holds the camera state, which only one camera driver changes ([ADR 0016](adr/0016-one-view-transform.md)); PixiJS draws the scene inside one MapLibre custom layer, the only scene renderer; LiDAR COG display draws through `maplibre-gl-raster` ([ADR 0004](adr/0004-one-renderer.md)). If WebGL2 or MapLibre fails, the workspace shows an explicit "map unavailable" state and the Design stays loaded; a user Retry rebuilds the map, nothing restarts on its own, and there is no fallback.

## Authorities

| Owner | Owns | Mutation path |
|---|---|---|
| Scene runtime (`SceneStore` via `SceneCanvasRuntime`) | Design objects: plants, zones, annotations, measurement guides, groups, locks, species colours, symbols and codes, scene layers | Runtime transactions |
| Design Edit (`app/design-edit/`) | Budget, currency, timeline, consortiums, description, saved views, stories, site data references (order, eyes, display), extra | Design Edit commands |
| Map layer store (`app/map-layers/`) | Basemap, satellite, contours, hillshade: order, visibility, opacity, provider | Layer-store actions |
| Settings | Last view (centre and zoom), basemap style, Google key (device-local credential), locale, theme, pointing device, single-key shortcuts, New Design defaults | Settings actions |

- Scene history covers scene runtime edits. A Design Edit is outside scene history unless it offers its own Undo toast (deleting a view or story); map layers and settings are never undoable.
- Neither document authority duplicates the other's data; save composition goes through the document-session seam, which asks each authority for its part ([design document](guides/design-document.md)).
- Panels read canvas entities through read-only runtime queries, never mirrors.
- Every resource-owning surface (runtime, renderer, MapLibre instance, timer, listener, token, DOM overlay) has one lifecycle owner for setup, update and teardown ([frontend](guides/frontend.md)).

## Geolocation model

Decided by [ADR 0001](adr/0001-geolocated-map-canvas.md); constants live in `desktop/web/src/canvas/session-plane.ts`.

- **Files store lon/lat.** `.canopi` format v9 (`CURRENT_CANOPI_FILE_VERSION`) stores every persisted position, including saved-view cameras, as `GeoPoint { lon, lat }`; zone and note rotation is degrees clockwise from true north. There is no Design-level anchor, bearing, placement status or altitude; plant and guide ids are required; a bearing belongs only to view cameras.
- **Session plane.** On load the codec builds a local Mercator-anchored plane (`canvas/projection.ts`) at the centre of the objects' bounds, or the view centre for an empty Design. All runtime geometry, tools, snapping, measurement, hit testing, LiDAR sampling and PDF layout work in metres there, on north-aligned axes; one view transform (centre, zoom, bearing) maps them to screen pixels ([ADR 0016](adr/0016-one-view-transform.md)).
- **Re-origin.** When the view centre moves over 10 km from the origin, the runtime rebuilds the plane and re-projects every object from stored lon/lat, losslessly.
- **Canonical write-back.** Positions are written rounded to 1e-9 degree, latitude clamped to ±85.051128779, longitude clamped to ±180 on save only (re-origin keeps it unclamped). Rounding is idempotent, so an unedited position never drifts (`geolocated-design-codec.test.ts`).
- **View, not placement.** Pan, zoom, turning the view, fit and place search move the camera only; objects move only when the user edits them. Saved object stamps stay relative arrangements in metres; templates are current-format `.canopi` files placed relative to the view.
- **New Design view.** A new Design opens north-up on the last view's centre, zoomed out to at most zoom 5 (lon 13.0, lat 23.0, zoom 4 without one), and asks "Where is your site?" first.

## Map stack

- Layers are ordered into bands, back to front: background (basemap or satellite), LiDAR items, terrain references (contours, hillshade), the shared scene layer, interaction overlays (`app/map-layers/bands.ts`).
- **Basemap:** OpenFreeMap vector styles (Liberty default; Positron, Bright, Dark) installed without `setStyle()`, so map, camera and edits survive a style change; attribution comes from the provider's TileJSON; labels follow the app locale.
- **Satellite:** Google only (Esri was rejected on licence terms). Without a key the public `mt1.google.com` tiles; with the user's device key the Map Tiles API session in `maplibre/basemap-tile-auth.ts`, the credential boundary. The key never enters a Design, export, snapshot, diagnostic bundle or log ([ADR 0001](adr/0001-geolocated-map-canvas.md)).
- **Place search:** the title-bar place field (Ctrl K) parses coordinates locally and sends place names through the geocoding registry copied from GeoLibre (Nominatim, Enter only, at least 1.1 s apart, OSM attribution). Confirm moves the view only.

## GeoLibre reuse boundary

GeoLibre (MIT, https://github.com/opengeos/GeoLibre) is a React and Zustand app; Canopi never imports its components or stores ([ADR 0002](adr/0002-geolibre-module-reuse.md)). Reference commit for copied TypeScript modules: `e9df9e2`.

| Piece | Source | How |
|---|---|---|
| COG display | `maplibre-gl-raster`, `cog-tiler-wasm`, `whitebox-wasm`, `geotiff` (pinned in `desktop/web/package.json`) | Dependency |
| Raster engine | `wbgeotiff` (`opengeos/whitebox-wasm` rev in `desktop/Cargo.toml`); CRS on `proj4rs` ([ADR 0014](adr/0014-pure-rust-raster-engine.md)) | Dependency |
| Analyses | GeoLibre CLI from `opengeos/geolibre-rust` (revision in `scripts/build-geolibre-cli.sh` and `desktop/src/services/lidar/geolibre.rs`) | Sidecar binary |
| Geocoding registry | `packages/core/src/geocoding.ts` | Copied into `app/geocoding/` |
| Basemap presets | `OPENFREEMAP_BASEMAPS` | Copied into `maplibre/openfreemap-basemap.ts` |
| Layer sync | `packages/map/src/layer-sync.ts` | Pattern only (store-driven, idempotent sync) |

Every copied file keeps an MIT header naming its source and commit and an entry in the root [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md); that generated file also names the pinned dependencies and the AGPL sidecar (`third-party-notices.test.ts`). `@geolibre/map` is never a dependency (it pulls Cesium, React).

## Editions

- **Desktop** (Tauri) and **Web** (static bundle) share the codec, scene runtime, workbenches and workspace composition; adapters are chosen at compile time through five Vite aliases, and the Web build rejects Tauri markers ([editions](guides/editions.md)).
- **Web scope:** browser-local data, geocoding through the shared registry, no problem reports, `.canopi`, PDF and GeoJSON as file outputs ([ADR 0005](adr/0005-web-edition-scope.md)).
- **Species catalog:** Desktop reads SQLite through Rust; Web reads generated Parquet through DuckDB-WASM ([ADR 0006](adr/0006-species-catalog-storage.md)).
- **Personal libraries:** saved object stamps and the Design Notebook live in the Desktop user DB; Web keeps stamps browser-local ([ADR 0007](adr/0007-design-objects-and-personal-libraries.md)).
- **PDF:** one browser-compatible layout and encoder for every edition, with no map background in 2.1 ([ADR 0008](adr/0008-canvas-pdf-export.md), 2.1-Q157).
- **Saving:** always-on continuous save to each Design's home (a file or a Draft), with conflict detection and no unsaved-changes prompts ([ADR 0009](adr/0009-continuous-save.md)).
- **Interface:** map-first Field Atlas chrome floating over the map, menus for every command, one plant finder and one species row everywhere ([ADR 0010](adr/0010-map-first-interface.md)).
- **Canvas:** the map turns, editing stays top-down, left selects or draws and right-drag pans ([ADR 0015](adr/0015-rotating-map-and-canvas-controls.md)); one input pipeline ([ADR 0017](adr/0017-input-pipeline-and-gestures.md)), world-space tools ([ADR 0018](adr/0018-narrow-tool-interface.md)), retained rendering ([ADR 0019](adr/0019-rendering-and-the-view-transform.md)) and one key and focus owner ([ADR 0020](adr/0020-focus-and-keyboard-ownership.md)).
- **Analyses and stories:** analyses are entries in the authored registry `common-types/analysis-registry.json`, generated into Rust and TypeScript, each run by a handwritten executor with recorded provenance; Designs hold saved views and stories presented inside Canopi ([ADR 0011](adr/0011-analyses-provenance-and-stories.md), [data library](guides/data-library.md)).
- **Vegetation analysis** from ONF Computree methods in an LGPL crate is decided but not built ([ADR 0012](adr/0012-vegetation-analysis.md)).
- **GeoJSON:** RFC 7946 import and export in both editions through one pure codec (`app/geojson/`); import rejects malformed files before mutation and adds objects in one undoable step.

## Native execution

Every `#[tauri::command]` is registered once and is executor-backed async or one of the reviewed bounded synchronous commands in `desktop/src/native_command_policy.rs`. Filesystem, SQLite, network, rendering, encoding, compression, process, sleep and unbounded CPU work never run synchronously on a command thread; direct blocking-pool calls belong only in `desktop/src/native_operation.rs` (`clippy.toml` `disallowed-methods`, `native_command_policy::tests`; [native and release](guides/native-and-release.md)).

## Persistence of app data

Pre-2.0 data is refused or left unread, the user told once ([ADR 0021](adr/0021-canopi-2-breaks-stored-data.md)); until 2.1 builds each store's forward steps ([ADR 0026](adr/0026-stored-data-after-2-0.md)), a store reads only its current version:

- Designs: only the current format opens; an older or newer file is refused unchanged with a typed `DesignLoadFailure` that says which.
- Desktop user DB and Drafts: a database from before 2.0 is renamed `….before-2.0-<unix-seconds>` and Canopi starts fresh; older Drafts stay, unread; a newer database is refused untouched; a damaged one is renamed `<file>.corrupt-<unix-seconds>`.
- LiDAR library: an older or corrupt catalogue is set aside and rebuilt from the originals and their `meta.json`; a newer one is refused and the library runs empty and read-only. Originals are never deleted by recovery.
- Web: independent browser-local records (drafts, settings, species activity, stamps); the 1.x record and older Drafts stay under their keys, unread.
