# Abstraction register

Answers which abstractions Canopi 2.1 keeps, what each owns and which file an agent copies. Rules: ADRs 0022 to 0030; the ADR wins on conflict.

Two tests decide every row. One owner per concept: a second copy is a defect. One way per seam: a seam has one mechanism, and its canonical example is the shape to copy. An abstraction earns its place by a second implementation (Desktop and Web, or a fake with behaviour), a trust boundary, an inversion the layer order needs, or a roadmap consumer.

Verdicts are keep, merge, split, cut, add or change, each with the [ledger](../decisions/2-1.md) row that decided it, or the ADR when this review kept the row as it was. Frontend paths are under `desktop/web/src/`; `(2.1)` marks a part not built at HEAD; an unmarked example is today's file. `scripts/check_docs.py` fails a mark on a built path and an unmarked missing path.

An agent adding to a seam copies its canonical example; a new kind of seam adds its row here in the same change.

## IPC and failures

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| `CommandRow` table | IPC contract: name, args, reply, failures, sync kind; private wrappers | `canopi-types` (2.1) rows; handler set in `canopi-desktop` | Trust boundary; TS consumer | `ipc/design.ts` | change: `commands!` const assertions (M153) |
| `invoke<K>` | the only Tauri `invoke` in the page | `ipc/` | Trust boundary; one transport | `ipc/design.ts` | keep (ADR 0022); import rules (M143) |
| Byte transport | Design bytes across Desktop IPC: raw body in, `ipc::Response` out, 64 MiB guard | `ipc/bytes.ts` (2.1); `RawBytesRequest` in `canopi-desktop` | Trust boundary; size cap before allocation | `ipc/design.ts` | add (M154) |
| Failure catalogue | code, `user_may_retry`, op, operation, detail; locale key per code | `canopi-types` (2.1) | Rust and TS producers; detail is redacted | `canopi-types/fixtures/failures/` (2.1) | change (M112, M96, M141) |
| `reportFailure` and the notice row | the one failure sink, ring and in-app notice | `failures/` (2.1) | One sink, both editions | the owner | keep (ADR 0025, M105) |
| `OperationId` | correlation per user action | `canopi-types` (2.1) | Report from a failure; jobs | `failures/` (2.1) | change (M105) |
| `Sensitive<T>`, `UserPath`, `RedactedText` | user content typed, not formatted | `canopi-types` (2.1) | Trust boundary (logs, reports) | `canopi-types/fixtures/redaction/` (2.1) | keep (ADR 0025, M113) |
| Redaction | each language redacts the text it produces, once | `canopi-redact` (2.1); `failures/redact.ts` (2.1) | Trust boundary | `maplibre/redact-credentials.ts` | change (M113) |
| `REPORT_SECTIONS` and builder | report contents, consent, editions column | one TS builder in `failures/` (2.1) | Consent; both editions (Q60) | `app/problem-report/diagnostics.ts` | change (M112) |
| `SubsystemHealth` | closed `StoreId` map to status and notice | `common-types/src/health.rs` | Desktop runners and Web adapters | the owner | change (M112) |

## Native scheduling

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Lane and lane table | bounded queues, priority, deadlines, Busy; the Job lane | `canopi-support` (2.1) executor | Every service; roadmap jobs | `desktop/src/native_operation.rs` | change (M108) |
| `OpSpec` | lane, priority, deadline, `supersede_key` per facade op | beside each facade method (2.1) | Moves scheduling out of commands | `desktop/src/commands/species.rs` | change (M107) |
| Job runner slots | `Slot{Heavy, Display}` on the Job lane | job runner in `canopi-library` (2.1) | Heavy and display work | `desktop/src/services/lidar/display_cog.rs` | change (M108) |
| `blocking::run` | the only blocking escape | `canopi-support` (2.1) | Runtime starvation | `desktop/src/native_operation.rs` | keep (ADR 0025, M108) |
| `CancelToken` | User, Superseded, Shutdown; `on_cancel`; one `cancel` command | `canopi-support` (2.1) | Jobs; species supersede; page cancel | `desktop/src/services/plant_browser.rs` | change (M107) |
| Composition facade | builds each service facade with its executor `Handle` | `canopi-desktop::compose` (2.1) | One composition, no attach step | `desktop/src/lib.rs` | add (M109) |
| Infrastructure homes | HTTP, tool runner, image cache, geocoder fetch, recent previews, report builder, app folders | named crates, composition | Named homes | `desktop/src/http.rs` | change (M109) |

## Files and stores

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| `DurableFs`, `publish_durably`, `remove_durably` | durable publish and remove with a `Precondition` | `canopi-support` (2.1) | Fault implementation; crash and disk full | `desktop/src/design/mod.rs` | change (M111) |
| Write vocabulary | admission, write lane, target lock (`TargetLocks`), Busy | Session core write lane; target locks in `canopi-support` (2.1) | Two homes today | `app/document-session/write-admission.ts` | change (M111) |
| Store migration chain | `FLOOR`, `STEPS`, `CURRENT` per store | pure chain in `canopi-types` (2.1); TS runner in `platform/` | Every store change | `platform/settings.browser.ts` | change: synchronous steps, staged moves (M157) |
| Fault seams | `DurableFs`, Draft `IDBFactory`, the library worker's OPFS pool | each store adapter | Model suites inject faults | `desktop/src/design/mod.rs` | add a third seam (M110, M151) |
| `DesignHomeStore` and `DesignHome` | where a Design lives; `HomeVersion` SHA-256; write results | `platform/design-home.ts` (2.1) | Desktop and Web; merge | `app/document-session/continuous-save.ts` | change (M117, Q165) |
| Draft records | Drafts on Web | `platform/draft-records.browser.ts` (2.1); `desktop/src/design/drafts.rs` | Untrusted record | `web/browser-app-data.ts` | change: internal seam, not a port (M117) |
| File access and grants | pick any file kind; opaque handle for a user file | `platform/file-access.ts` (2.1); grant table and dialog registry in `canopi-desktop` | No paths cross IPC | `app/geojson/workflow.ts` | change: pickers, dialog registry, home identity (M155) |
| FileDelivery | exports: `deliver(row, signal)` over a content union | `platform/file-delivery.ts` (2.1) | Desktop and Web; PDF, CSV, GeoTIFF | `app/canvas-pdf/platform.desktop.ts` | change (M140) |
| Personal-records ports | saved stamps, Design notebook, species lists | `platform/saved-stamps.ts` (2.1), `platform/design-notebook.ts` (2.1), `platform/species-lists.ts` (2.1) | Desktop and Web; Web parity | `ipc/saved-object-stamps.ts` | change (M141, Q173) |
| Browser record | the only `localStorage` access | `platform/browser-record.ts` (2.1) | One quota and decode rule | `web/browser-app-data.ts` | add (M141) |

## Format

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Format core | read checks, chain, writer, admission, builder, stamp chain | `canopi-format` (2.1) | Native and wasm; hostile files | `desktop/src/design/format.rs` | keep (ADR 0026) |
| Design-core port | decode, encode, new, Draft envelope | `platform/design-core.ts` (2.1) | One worker adapter; fake | `ipc/design.ts` | change: worker on both editions, raw bytes (M154, M156) |
| Design-core worker | worker union loading, ready, load-failed, poisoned | `platform/design-core.worker.ts` (2.1) | Isolates untrusted bytes; one core on both editions | `platform/browser.ts` | change (M148) |
| Canonical encode | byte-identical encode of one Design | `canopi-format` (2.1) | `HomeVersion`, Draft move verify, lost-ack adoption | `desktop/src/design/format.rs` | add (M156) |
| Spec emitter | frozen generated format spec | `canopi-format/spec/` (2.1) | Every format change; rollback lane | `scripts/schema-contract.json` | keep (ADR 0026) |
| `DESIGN_FILE_FIELDS` | one owner per Design field: Scene, Document or Format | `common-types/src/design.rs` | Exclusive authorities | the owner | change (M121) |
| `GeoPoint` | lon/lat in files and TS | `canopi-format` (2.1) | ADR 0001 | `common-types/src/design.rs` | change (M123) |
| Print setup | pages as box, whole design or split sheet; splits by pivot | Document | PDF editor | `app/canvas-pdf/layout.ts` | change (M122, M161) |
| Stamp file | v3 payload mapped field by field; codes reallocated when taken | Document; Session core places it | Stamps, merge | `canvas/saved-object-stamp-payload.ts` | change (M122, Q168) |
| Object kind rows | `ObjectOwner`, `Backing`, `ObjectKindRow`, `ownerOf` | `app/command-table/object-capabilities.ts` (2.1) | Print, planning, merge | `common-types/src/design.rs` | change (M126) |

## Session and history

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Session core | Design lifecycle, home, save state, last-open home, read-only view | `app/document-session/core/` (2.1) | Merges two hand-written machines | `app/document-session/state-machine.ts` | change (M116) |
| Pending question | close or replace question held by the core; answer in | Session core | One state-out, command-in way | `app/document-session/save-problem.ts` | change: Session state, `core.answer` (M162) |
| Design scope, `latest()` | per-Design lifetime | `types/design-scope.ts` (2.1) | About 30 hand resets today | `app/document-session/lifecycle.ts` | keep (ADR 0024, M118) |
| One history | `core.document`, staged `core.compound`, tool history first | Session core | One Undo order; PDF editor, merge | `canvas/runtime/scene-runtime/transactions.ts` | change (M114, M115, M158) |
| Print workspace entry | one amendable entry per PDF workspace session | Session core | PDF editor | `app/canvas-pdf/workflow.ts` | change: coalesce key sealed by any other entry (M160) |
| Undo toast | a view of the one history | Session core | No second Undo path | `app/saved-views/` | change: view of `newestUndoable` (M159, Q172) |
| `core.place` | stamp or arrangement as one compound entry | Session core | Stamps, merge, detected trees | `app/saved-object-stamps/` | add (M119) |
| Document references | kept and marked when the object goes | `app/design-edit/` | Print, planning, merge | `app/design-edit/views.ts` | add (M120) |
| Serial lanes | serialisation only in named owners | core write lane, settings, `app/record-workbench/` (2.1), sampler lanes, display admission | Four queues today | `app/mutation-queue.ts` | change (M118) |
| App lifecycle port | close, hide, focus lost, show, `release-waiting` | `platform/app-lifecycle.ts` (2.1) | Desktop and Web page events | `app/shell/close-guard.ts` | add (M98, M116) |
| App scope | `installAppLifetime(ports)`, reverse disposal | edition roots | One app scope for two bootstraps | `platform/desktop.ts` | keep (ADR 0024) |

## Canvas and map

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Map lifetime | `MapLifetimeState`, layer slots, `LayerStatus` | `maplibre/map-lifetime.ts` (2.1) | Three constructors today | `maplibre/workspace-map.ts` | change (M144) |
| Canvas host | lease and `CanvasSurfaceState`; `mountCanvasHost` | `app/canvas-map-surface/canvas-host.ts` (2.1) | Three hosts today | `components/panels/CanvasPanel.tsx` | change (M144) |
| `ScenePainter` | the scene the map hosts; `presentFor` | `maplibre/` | Inversion: `maplibre/` sits below `canvas/` | `maplibre/shared-scene-layer.ts` | change (M145) |
| MapPorts and fake map | the MapLibre surface each consumer uses | `maplibre/` | Fake with behaviour | `maplibre/loader.ts` | change (M145) |
| Workspace map contribution | a map layer source, gated by capability | `app/canvas-map-surface/workspace-map-contributions.ts` | Hydrology, crowns, LiDAR layers | the owner | keep (ADR 0027) |
| `CanvasRuntimeAppAdapter` | what the canvas asks of the app | `canvas/runtime/` | Inversion | `canvas/runtime/interaction-ports.ts` | keep (ADR 0022) |
| `CameraDriver` | camera, headless or MapLibre | `canvas/runtime/view/camera-driver.ts` | Runs while the map is unavailable | the owner | keep (ADR 0001) |
| Raster pool lanes | worker tasks; in-process lane | `maplibre/raster-display/pool.ts` | Real worker and test lane | the owner | keep (ADR 0024) |
| ToolHost and map input | active tool, armed source, `tools.arm(id, source, request?)` handle | `canvas/runtime/tools/tool-host.ts` | Map pick for forms | the owner | change (M147) |
| Session plane | plane maths; `trueNorthAt` for plane consumers | `geo/session-plane.ts` (2.1) | Earth model, one owner | `canvas/session-plane.ts` | change (M124) |
| Web Mercator | Web Mercator maths per language | `geo/web-mercator.ts` (2.1) | Hot path in Rust and TS | `maplibre/` | keep (ADR 0001) |

## Settings and editions

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Settings field table and chain | shape, steps, privacy, `DefaultSpec`, `DeviceSignals` | `canopi-types` (2.1); `bindings-gen/src/settings_chain.rs` (2.1) | Two runners from one table | `platform/settings.browser.ts` | change (M138, Q169) |
| `patchSettings` and slices | settings writes; the map-layer slice | `app/settings/` | One writer path | `app/settings/state.ts` | change: settings own map layers (M137) |
| Settings store port | settings persistence | `platform/settings.ts` (2.1) | Desktop and Web | `platform/settings.desktop.ts` | keep (ADR 0022) |
| Window state | Desktop window geometry | Desktop host in `canopi-desktop` | Outside settings and reports | `desktop/src/lib.rs` | change (M135) |
| Quantity table | units and display per quantity; scale | `canopi-types` (2.1) | Metric and US customary; analyses | `app/lidar/item-types.ts` | change (M125, Q167) |
| Number display | number, unit, byte, money text | `utils/format.ts` (2.1) | 36 files format by hand | `utils/format-count.ts` | keep (ADR 0027) |
| `EditionPorts` | every port binding of one root | `platform/edition-ports.ts` (2.1) | Desktop, Web and gallery roots | `platform/desktop.ts` | change (M139) |
| Edition-capability table | the only allowed edition differences | `canopi-types/edition-capabilities.json` (2.1) | Web parity | `web/browser-shell-commands.ts` | change: gate and adapter rows, set by edition plus OS (M136, M164) |
| Gallery root | Desktop adapters over a fake transport; library transcripts | `editions/gallery/` (2.1) | Fake transport | `ui-gallery/memory-backend.ts` | change (M143, M139) |
| Species reader | catalog query, supersede by `AbortSignal` | `platform/species-reader.ts` (2.1) or `catalog/` (2.1) | Two E1 outcomes | `ipc/species.ts` | change (M133) |
| Geocoding transport | page fetch on Web, `geocoder_fetch` on Desktop | `platform/geocoding.ts` (2.1) | Two transports, host allowlist | `app/geocoding/transport.desktop.ts` | change (M142) |
| Page rules | search folding and analysis parameter rules in the page | `platform/page-rules.ts` (2.1) over `canopi-page-rules-wasm` (2.1) | Six folds today | `utils/normalize-search.ts` | change (M104) |
| Phone layout | phone chrome on both editions | `app/shell/phone-layout.ts` | One responsive composition | the owner | keep (ADR 0030) |

## Commands and keys

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Command table | commands, tool rows, keys, placement, availability | `app/command-table/tools.ts` (2.1) and siblings | Four catalogs today | `app/canvas-commands/index.ts` | change (M146) |
| Context-menu items | menu items as command rows; the owner keeps menu state | `app/canvas-context-menu/state.ts` | Second vocabulary today | `app/canvas-context-menu/entries.ts` | change: projection with lacking (M163, Q170) |
| Object-action matrix | object kind by action, `via` tool ids, kind `requires` | `app/command-table/object-capabilities.ts` (2.1) | Print, planning, merge | `app/command-table/` (2.1) | change (M126) |
| Key router and keymap | shortcuts and chord text from the keys column; Esc order | `app/keyboard/key-router.ts`, `app/keyboard/escape-chain.ts` | One router on both roots | `app/keyboard/key-router.ts` | keep (ADR 0020) |
| Modal layer | what is modal; the one modal query reads it | `app/shell/modal-layer.ts` | Two `isModalOpen` copies today | the owner | keep (M146) |

## Data library and analyses

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Data library port | the library on both editions; `subscribe`; `display(ref)` | `platform/library.ts` (2.1) | Desktop and Web; hydrology, LiDAR reading | `ipc/lidar.ts` | change: Web library worker (M151, Q171); display (M132) |
| Library subscription | all library state, display included, on one Channel | facade in `canopi-desktop`; the library worker's port on Web | No status read, no poll | `ipc/lidar.ts` | change (M103, M151) |
| `DisplayAsset` | display bytes written once per generation | `types/display-asset.ts` (2.1) | One display owner | `maplibre/raster-display/pool.ts` | add (M132) |
| `LibraryItemKind` | kinds and stored literals; `parse_kind` | `kinds.rs` in `canopi-library` (2.1) | Vector and point-cloud kinds | `desktop/src/services/lidar/catalogue.rs` | change (M125) |
| `LibraryItemId` | identity and unique name key | `library_items` table, catalogue v26 | Lineage and kinds drop | `desktop/src/services/lidar/catalogue.rs` | add (M130) |
| Library repository | all library SQL, decode, names, migrations | `canopi-library` (2.1) | One SQL owner | `desktop/src/services/lidar/catalogue.rs` | keep (ADR 0023) |
| Job state and runner | `LibraryJobState`, `LibraryJobOutcome`, transitions | `canopi-types` (2.1); runner in `canopi-library` (2.1) | Hydrology, crowns, sunlight jobs | `desktop/src/services/lidar/recovery.rs` | change (M106, M127) |
| Janitor | the only deleter of library files | `canopi-library` (2.1) | User data loss | `desktop/src/services/lidar/raster_assets.rs` | keep (ADR 0023) |
| Lineage | item provenance | `canopi-library` (2.1) | Refresh, crowns, bring your own | `desktop/src/services/lidar/source_meta.rs` | change (M130) |
| `crs` leaf | CRS authority; `grid_convergence(crs, lonlat)` | `desktop/src/services/lidar/rust_engine/crs.rs` | Hydrology, crowns, LiDAR, sunlight | the owner | change (M124) |
| Raster read and write | `raster_read`, `raster_write` over a reader or bytes; `RasterFailure` | `engines` in `canopi-library` (2.1) | Native and wasm | `desktop/src/services/lidar/rust_engine/tiff.rs` | change (M131) |
| Analysis registry rows | params, output quantity, recipe, presets | `common-types/analysis-registry.json` | Aspect, hydrology, crowns, sunlight | `desktop/src/services/lidar/analyses/terrain.rs` | change (M128, M125) |
| `AnalysisExecutor` | analysis id to code; `EngineId`, `ENGINES` | `executor(id)` in `canopi-library` (2.1) | One dispatch | `common-types/src/analysis_registry.rs` | change (M129) |
| Whole-grid engine | global terrain compute; a const halo or a parameter-derived halo under a named ceiling | chosen at N0 | Runs in the Web worker too; sunlight's shadow reach | `desktop/src/services/lidar/geolibre.rs` | change (M134, M166) |
| Solar position | sun azimuth and altitude from a UTC instant and WGS84 lon/lat | the engines layer (2.1) | One time basis for the timed overlay and every sunlight analysis | none yet | add (M167) |
| Canopy layer cast | crowns as a semi-transparent volume beside the surface model | the sun engine adapter (2.1) | Leafless crowns, crown base, no wall at the trunk | none yet | add (M168) |
| Design crowns resolver | `DesignCrownSet` (2.1) or `not-ready`; the one crown-model function | an L3 module of the sunlight release (2.1) | The only join of Scene, catalog and Document for crowns | `app/lidar/import-coverage.ts` (settled Scene read) | add (M169) |
| Analysis parameter rules | `ParamInput`, `ParamError`, `check_request` | `canopi-types` (2.1) | Two validators today | `common-types/src/analysis_registry.rs` | change (M104, Q167) |
| Importer list | importers and accepted formats | `canopi-library` (2.1) | Point clouds, vectors | `desktop/src/services/lidar/import.rs` | keep (ADR 0027) |

## Web delivery and release

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Web release tool | Web serving rules and deployment limits | `scripts/web_release.py` | Deploy integrity | the owner | keep (M102) |
| Origin table | allowed origins; both CSPs | `policy/origins.json` (2.1) | Trust boundary | `desktop/tauri.conf.json` | add (M102) |
| Service worker | offline, skew caches, kill-switch, `keep_catalog` | service worker (2.1) | Offline Drafts, deploy skew | `scripts/web_release.py` | change (M99, M100) |
| Catalog manifest | content-named, carried by the page bundle | `scripts/web_release.py` | A tab reads its own release's catalog | the owner | change (M101) |
| Release waiting | `release-waiting{source}`, flush, then `applyRelease()` | `platform/app-lifecycle.ts` (2.1) | One Reload owner | `web/browser-release-watch.ts` (manifest source, 2.0.3) | add (M98) |
| Updater | check and download inside the Network lane; `UpdateState` in `app/updates/` (2.1) | `desktop/src/host/updater.rs` (2.1) | Signed artifacts | the owner | add (M96, M97, Q163, Q164) |
| Build-time config patch | Desktop config, CSP generated from the origin table | `desktop/build.rs` | Generator for Desktop | the owner | keep (M102) |

## Policy and process

| Abstraction | Concept owned | Owner | Why it exists | Canonical example | Verdict |
|---|---|---|---|---|---|
| Layer table | layer, rank and destination per path | `policy/layers.json` | Generates every layer check | `layer-order`, `edition-roots` | keep (ADR 0022); placement (M139) |
| Primitive owners | one owner per raw primitive, with example | `policy/primitives.json` | Outlives the plan | `desktop/src/module_layering.rs` | change (M149) |
| Suite registry | contract suites, two sides held equal | `policy/suites.json`, hand-edited | Outlives the plan | `__tests__/canopi-design-conformance.test.ts` | change (M149) |
| Ratchets, inventory, hooks | shrink-only counts; rule to check; commit-time gate | `policy/ratchets/` (2.1), `policy/inventory.json`, `.githooks/` (2.1) | Agent maintenance | `desktop/src/native_command_policy.rs` | keep (ADR 0028) |
| Walks and Session suite | stopping rule; Session suite cases | `scripts/agent-trials/` (2.1) | Agent trials | the owner | change (M150) |
| Architecture model | diagrams and this register held to the code | `scripts/check_docs.py` | Agents read the model first | `docs/architecture/README.md` | keep (ADR 0028) |

## Cut by this review

- `#platform` alias, `bootstrapPlatform()`, the Vite alias tables and `target/`: into `EditionPorts` and the edition roots (M139).
- `NativeOperationExecutor`, `NativeOperationClass`, `HeavyJobLease`, the display preparation lane and detached spawns: into lanes and runner slots (M108).
- `SpeciesSearchCancellation` (M107); `call_id` (M105); `LidarLibrary::attach_executor` (M109).
- `RasterEngine` (M131); `AnalysisLane` (M129); `LibraryItemRole` and the kind fields (M130).
- `SceneHistory` (M114); `SceneHostLayer`, `sceneSyncCount` and the hand MapLibre interfaces (M145).
- `TOOL_REGISTRY`, `app/canvas-commands/` and `app/shell-commands/`: into the command table (M146); `pinAt` and `finishProfile` (M147).
- The shell notice registry, `app/document-session/workflow-runner.ts`, `app/document-session/continuous-save.ts` and the 13 session counters (M118).
- `LonLat` and `GeoPosition` (M123); the per-store quota codes (M141).
