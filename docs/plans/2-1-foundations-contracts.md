# Canopi 2.1 foundations: contracts

Status: Agreed 2026-10-16, amended 2026-10-17 (the answers to 2.1-Q133, Q78d, E1 to E7 and M1 to M19 in the [decision ledger](../decisions/2-1.md); the Session-core, canvas-map, settings, job-runner and true-metres prototypes; the order review, 2.1-Q137, 2.1-Q138, 2.1-M20 to 2.1-M22; the blocker review, 2.1-M28 to 2.1-M34), amended 2026-10-19 (the capability audit and scope additions, 2.1-Q147 to 2.1-Q160, 2.1-M86 to 2.1-M94) (canopi-f47t.52); to be deleted when built. Each contract then lives in its code, module comment and test.
Contracts only: shapes, states, rules and the tests that hold them. Order of work is in [2-1-foundations.md](2-1-foundations.md); the reasons are in ADRs [0022](../adr/0022-module-map-and-dependency-direction.md) to [0030](../adr/0030-edition-parity.md).

## 1. Typed command map

One row per `#[tauri::command]`, declared in `canopi-types` and emitted to TS by `bindings-gen`. IPC is not versioned (ADR 0026).

```rust
pub struct CommandRow {
    pub name: &'static str,             // the IPC name
    pub args: TypeRef,                  // argument struct, camelCase on the wire
    pub reply: TypeRef,
    pub failures: &'static [CodeKind],  // codes it may return
    pub sync: SyncKind,                 // Async | BoundedSync { reason: &'static str }
}
// canopi-desktop: one `commands!` table; each entry expands into the one-line
// #[tauri::command] wrapper over its facade method, its CommandRow and the
// generate_handler! list, from the same Args and Reply idents.
// canopi-support, beside the executor; Lane is in canopi-types because busy{lane} carries it
pub struct OpSpec { pub lane: Lane, pub priority: Priority, pub deadline: Deadline }
// Deadline::Unbounded only for system work: runner transitions, the janitor, recovery, the reserved settings boot read
```

- The row faces TS only; TS never needs `OpSpec`. Phase 2a builds the map with the generated `invoke<K>` typing. `bindings-gen` takes its TS roots from the rows' args and reply types plus the failure catalogue and `CanopiFile`; the hand `.register` list in `contracts.rs` is deleted, and the name test stays as a backstop.
- "Reviewed" means the row's non-empty `reason`. `SYNC_COMMAND_ALLOWLIST` is deleted; `ESCAPE_ENTRY_POINTS` (the floor that stops `clippy.toml` shrinking) and the reason pin in `BLOCKING_ESCAPE_ALLOWLIST` stay.
- Every invoke carries the action's `OperationId` (ADR 0025). The generated TS command map is written under `src/ipc/`, so the CI change filter's invoke paths are one entry, held to the ast-grep rule by a `ci_lane_policy.rs` test.
- No command takes a raw path: a native dialog returns an opaque grant (ADR 0027), and stored entries carry an id.
- A facade operation declares its `OpSpec` once, as a constant beside the method in its service crate (ADR 0023); nothing restates it. From Phase 3 N1, `canopi-desktop`'s command-map contract test checks that each registered command's facade method declares one and that a job facade returns a `JobId` (it writes its Queued row through an ordinary Library-lane `OpSpec`). There is no retry column (ADR 0025).
- TS gets `CommandMap` (name to args, reply and failures) and one `invoke<K>(name, args): Promise<Result<Reply<K>, Failure>>` in `ipc/`. No other module calls the Tauri `invoke`.
- Checks: `command_map_matches_registered_commands` (both directions); `native_command_policy` (every synchronous command has a `BoundedSync` row with a reason and the reverse, no executor call in a command body); ast-grep `invoke-only-in-ipc` (with a planted invoke outside `ipc/`) and `no-path-string-command-arg`.

## 2. Failures: catalogue, codes and wire shape

One catalogue in `canopi-types`, generated to TS. A row holds the code, its source, `user_may_retry`, its locale key (or `silent`) and its log level.

```json
{ "code": { "kind": "busy", "lane": "library" },
  "user_may_retry": true,
  "op": "library.delete_item",
  "operation": "op_01J…",
  "detail": "redacted English, logs and reports only" }
```

| Source | Codes |
|---|---|
| executor | `busy{lane}`, `cancelled` (silent), `unavailable`, `panicked`, `join_failed` |
| native services | `plant_db_unavailable{cause}`, `user_data_unavailable`, `library_read_only{reason}`, `not_found{what}`, `conflict{what}` (`conflict{what: name, suggestion}` for a Data library name clash), `import_refused{refusal}`, `design_load{kind}`, `param_invalid{key, code}` (code: required, number, integer, range{min,max}, step{step}, no_outputs; the same codes as TS `ParamError`), `io{kind}`, `network{kind}`, `invalid`, `internal` |
| Draft store | `draft_absent`, `draft_unreadable`, `draft_quota_refused`, `draft_conflict`, `storage_unavailable`, `draft_store_newer` (the one "New version: Reload" notice, 2.1-Q83), `draft_store_blocked` ("Close other Canopi tabs to continue") |
| catalog reader (Web) | `catalog_unavailable{cause}`, `catalog_query_failed` |
| Data library (Web adapter, N5) | `library_quota_refused`, `over_web_limit{limit}` ("Needs Canopi Desktop" with the limit) |
| map | `map_unavailable`, `style_failed`, `tile_source_failed{layer}` |
| format core (Web adapter) | `internal` with `detail` `load_failed`, the panic message or `trapped` (ADR 0025) |

- `io.kind`: not_found, permission_denied, read_only, no_space, too_large, other. `network.kind`: timeout, offline, status, host_not_allowed. `plant_db_unavailable.cause`: missing, open_failed, schema_mismatch, fingerprint_mismatch. `design_load.kind` includes `migration_failed{from}`, for files, Drafts and stamp files (§10) and saved-stamp payloads (§11).
- The list above is the starting set. Adding a code is the L14 change: one catalogue row, one locale key in all 11 locales or `silent`.
- `detail` passes the redactor (the shared credential parameter names, ADR 0025) and is never shown. `SubsystemHealth.plant_db` carries `plant_db_unavailable`'s cause, and a library not ready carries `library_read_only{reason}`; one presentation module maps each status to its tone and message (`every_health_status_has_one_message`). `user_may_retry` only lets the screen offer Retry.
- Checks: `every_code_has_a_message_or_is_silent`; `every_code_reaches_the_report`; fixtures `canopi-types/fixtures/failures/<code>.json` read by Rust and TS; ast-grep `no-string-error-command`, `no-cancelled-literal`, `console-only-in-sink`.

## 3. Native scheduling

The executor in `canopi-support` owns the request lanes and a heavy-work slot primitive (capacity, priority, cancel, blocking pool); the job runner in `canopi-library` builds the Job lane on that primitive (ADR 0025). Blocking work runs only through the private `blocking::run`. A request is `run(op: OpSpec, token: CancelToken, work) -> Result<T, Failure>`.

| Lane | Protects | Workers | Queue bound | Interactive deadline |
|---|---|---|---|---|
| Catalog | the plant DB | data | data | data |
| UserData | `user.db` | data | data | data |
| Library | catalogue row transactions | data | data | data |
| Local | user files, raster reads, header probes | data | data | data |
| Network | HTTP | data | data | data |
| Job | heavy LiDAR work and display preparation, through the job runner | 1 heavy job, plus 1 display slot | the jobs table, unbounded because each queued job is visible; display requests coalesce per key | none |

Every request lane is a bounded queue; the Job lane's queue is the runner's jobs table, not the executor's. The values are data in one lane table. Starting deadlines are the 2.0 slow budgets (Catalog and UserData 2 s, Local 10 s, Network the HTTP timeouts).

- **Priority.** Interactive before background within a lane; FIFO within a priority.
- **Deadline.** Measured from enqueue to start. A request not started by its deadline settles `busy{lane}` and its work never runs. Started work runs to completion or cancel; running past its slow budget logs `warn` with `running_ms`.
- **Queue bound.** A back-pressure guard: an enqueue onto a full queue waits until a slot frees or its deadline passes. At the deadline it settles `busy{lane}` (logged `warn` with `queue_full`), so Busy still comes only on deadline expiry. The bound is sized so expected load never reaches it.
- **Cancel.** A `CancelToken` with a drop guard on the command future, carrying its reason (User or Shutdown). Cancelled before start: the work never runs, result `cancelled`. Cancelled while running: the work sees it at its next check; the slot stays held until the blocking work ends.
- **Jobs.** A job facade writes the Queued row through a Library-lane request and returns the `JobId` at once; the runner, not `run()`, starts the work.
- **Display preparation.** On the job lane at background priority in its own display slot, so it never waits behind the heavy job. It is not a visible job and has no deadline: a request while preparing reads `preparing`, never `busy`. Deleting the item or closing the Design cancels it; the status read then shows nothing for that key.
- **Settlement.** Every request settles exactly once: ok, a failure code, `busy`, `cancelled`, `panicked`, `join_failed`, or `unavailable` after shutdown. Each settlement logs `op, operation, lane, settlement, code, queued_ms, running_ms, call_id`, and `job_id, item_id` for a job (ADR 0025 Logs).
- **Frontend.** One request per action. No client retry. Busy is shown once; Continuous Save reads it as "not saved yet".

Fixtures and tests (`native_call_contract`, created by Phase 3 N1 with the fixtures, paused tokio time, where a running blocking task stops auto-advance so tests call `advance`; from then on `ipc/transport.test.ts` reads the same fixtures; its one-invoke, no-retry case exists from Phase 1):
1. Interactive work queued behind background work starts first.
2. A request queued past its deadline settles `busy` and its work never runs.
3. An enqueue onto a full queue waits; it starts if a slot frees before its deadline, else it settles `busy` at the deadline with `queue_full` and its work never runs.
4. A token cancelled before start: the work never runs, `cancelled`.
5. A dropped future cancels its token; the work sees it within one check.
6. A panic settles `panicked` and logs `error`; a closed executor settles `unavailable`.
7. A job op returns its id and shows Queued until the runner starts it.
8. Every request settles exactly once (a property test over random interleavings).
9. TS: one invoke per action; `busy` reaches the caller unchanged, with no second call.

## 4. Design Session ports and their scenario suite

```ts
type DesignHome =
  | { kind: 'file'; grant: FileGrantId; displayName: string; fingerprint: Fingerprint }
  | { kind: 'draft'; id: DraftId; revision: number };

interface DesignHomeStore {
  read(home: DesignHome): Promise<HomeRead>;      // present | absent | unreadable
  write(home: DesignHome, bytes: Uint8Array): Promise<HomeWrite>;
  // HomeWrite: written{home} | conflict | quota_refused | failed{failure}
  deleteDraft(id: DraftId): Promise<Result<void, Failure>>;
  listDrafts(): Promise<DraftSummary[]>;          // records only; canopi-format's draft_summary derives each summary
}
interface DesignPicker {
  pickOpen(): Promise<DesignSource | 'cancelled'>;
  pickSaveTarget(name: string): Promise<SaveTarget | 'cancelled'>;
}
type DesignSource =
  | { kind: 'file'; grant: FileGrantId }
  | { kind: 'bytes'; name: string; bytes: Uint8Array }
  | { kind: 'draft'; id: DraftId };                 // read through DesignHomeStore.read and DesignCore.draftEnvelope
// Session core: openFrom(source: DesignSource): Promise<OpenResult>, the one open path.
// Session core: launchIntent(): the source boot opens, or none: on both editions the last
// open Design (its file grant or Draft id), else none and the start screen (2.1-Q127, §19 ED-03).
// A url source (L10) comes with open from URL, if that feature is built.
```

- `DesignHome`, its store and `DesignSource` are declared in `platform/design-home.ts`. The Session core is the only writer of the session state, the home, the save state and the Design scope (the union is in ADR 0024). Dirty: ADR 0024 (`rev > ackRev`, 2.1-Q68). `designDirty`, `committedDesignRevision`, `canvasChangeRevision`, `resetDirtyBaselines`, `setCanvasClean`, the Scene history checkpoints and the persistence epoch are deleted.
- **File grants.** A file home is a grant, never a path (ADR 0027): the native dialogs return a `FileGrantId` held in `canopi-desktop`, and Recent Designs and the Notebook hand grant ids to the frontend, their paths kept native-side in the user DB. Grants land with this port in 2b.
- **Drafts.** Only the core mints a `DraftId` (`mintDraftId()`, a brand over `utils/ids`, its pattern and length emitted from the Rust constant and checked by both stores). Each summary comes from `canopi-format`'s `draft_summary(bytes, updated_at)`: name fallback and admission status, unreadable Drafts listed with their reason. The core sorts `listDrafts()` by `updated_at` descending, then id, and its `deleteDraft` refuses the open Design's Draft on both editions.
  - The Start screen's one Drafts list reads this port (`app/design-drafts/controller.ts` and the Web snapshot logic are deleted) and refreshes on window focus.
- **Names.** `app/design-edit/document/design-name.ts` owns `displayName`, `fileStem` and `nameFromSource`; title bar, Start screen, Drafts, the save dialog, every export's suggested name (GeoJSON included) and the open path use it. An unnamed Design stores an empty name. One `normaliseObjectName` serves the Design, view, story and stamp renames; zones keep "empty clears" as a named variant.
- Desktop binds the native files and dialogs. Web binds the IndexedDB Draft store, a file input and FileDelivery downloads. Desktop declares Draft revision conflict unreachable; file fingerprint conflict stays.
- A Design scope per open Design: an `AbortSignal` and a dispose list. Its type is `types/design-scope.ts` (L0, its methods the registration API) and its one implementation is in `app/document-session/core/`; only the core opens and disposes a scope. Modules register through `core.onDesignOpened` (a late registration gets the open scope); none watches `sessionIdentity`. The canvas host calls `core.attachScene` and `core.detachScene`; a detached Scene half is data, its unsaved edits kept and its Scene undo dropped.
- Boot calls `launchIntent()` and then `openFrom`; a last Design that is gone or unreadable shows the start screen, never a refusal on launch; the welcome list opens a Draft through `openFrom` too; nothing else opens a Design. A Web open from bytes makes a new Draft.
- The core reads the in-memory Design through the async design-core port (contracts §10): Desktop's encoder is an executor-backed native command off the main thread, so save, the Problem Report attachments and Stamps await it.
- **One Undo order**: ADR 0024 (2.1-Q80). Document writes (views, stories, saved views, budget, timeline, consortium, Site data entries, the print setup) go through `core.document()`: one receipt and one notice each; the Session suite has a case per Document edit family (T7, 2.1-M87).
  - A compound entry (2.1-M89) joins one scene runtime transaction and one `core.document()` write under both owner tokens: `core.compound(sceneTx, documentWrite)` records one entry, undo and redo replay both halves, and a refused half refuses the entry with neither applied. Users: a stamp placement with its care actions and species data (2.1-Q155); deleting a species' last plant with its consortium entry (2.1-Q158). Test: one Undo restores both halves, one Redo reapplies both.
- The Scene serializer is typed `Pick<CanopiFile, SceneKey>`, so it cannot write a Document field, and no second composer re-lists fields. Tests build whole Designs from one generated factory over `DESIGN_FILE_FIELDS` defaults; no whole-file literals.
- The Scene codec exposes `hydrateSceneObjectsInFrame(objects, plane)`, which the whole-file hydrate and the GeoJSON import call; no production code builds a `CanopiFile` except the serializer and the generated defaults factory (ast-grep `no-canopifile-literal`).

Scenario suite (run against both editions' ports; the Draft store also against the real IndexedDB in Chromium, WebKit and Firefox):
1. A new Design's first edit creates a Draft; Continuous Save writes its home.
2. Save as moves the home from Draft to file and deletes the Draft; a failed delete is reported and the Draft stays listed.
3. Open reads and decodes first; a refusal touches nothing. Then the current Design flushes (ADR 0009 dialog), the Scene admits the new half, and only then is the old scope disposed. A source that is the open Design's home answers already-open. Two opens: the latest wins, and `current` stays open and saveable until the new one is admitted (2.1-Q66).
4. Close flushes, then closes. (a) A failed Design flush asks Retry / Close without saving / Cancel (ADR 0009). (b) When only the settings store cannot be written, the Design is flushed first, then the dialog asks Retry / Close anyway (Q20).
5. A file changed on disk, or a Draft revision moved, enters conflict; nothing is overwritten.
6. A quota refusal keeps the Design in memory, shows the typed message and arms the Web leave prompt; a pending async Draft flush arms it too, and it disarms when the write settles (Q22, carrying WEB-03's test forward).
7. `busy` leaves the status "not saved yet"; the next tick writes.
8. A canvas handoff (detach, attach) keeps unsaved edits.
9. A reopened empty Design opens at its saved `map_view`, bearing 0; a Design with objects opens at its saved `map_view`, bearing included (U28/U30, ADR 0015).
10. Every known key survives decode, compose and encode through the core; an unknown root key is kept; the Scene serializer leaves every Document field as it was.
11. Write admission refuses a Design it could not reopen and names a non-finite field.
12. A migrated open is clean: blur and close write nothing until an edit, except a Web open from bytes, whose new Draft does not exist until an edit. Before the first new-format write to a Desktop file home, the old file is kept once beside it with the notice; an unwritable folder sets `copy-blocked` and the notice asks before saving (2.1-Q35r).
13. Deleting the open Design's Draft is refused on both editions' ports; a minted id passes the native id check.
14. A new Design starts with Settings › New Designs (plant display) on both editions; an opened one keeps its own.
15. A Drafts list failure shows the typed notice; a failed delete is reported and the Draft stays listed.
16. Every fault the fault seam injects (kill after any step, disk full, read-only, rename failure, IndexedDB quota and abort) leaves the last or previous acknowledged revision on reopen, and no Draft is lost (Q47).
17. An edit made while a write is in flight stays dirty, and the lane writes again.
18. Reopening the open Design's home after an edit flushes first and never shows stale content; Close without saving waits for a write started while its dialog was open.

## 5. Canvas host attach port

```ts
interface CanvasHostEdition {
  attach(documents: CanvasDocuments): Promise<'attached' | 'no-design' | 'cancelled'>;
  activate?(): void;          // after start: consume a queued load, or frame a fixture
  detach(): void;             // synchronous handoff, before anything is released
  resizeTo: 'area' | 'container';
  onReadyChange?(ready: boolean): void;
  label: string;              // log label
}
mountCanvasHost(elements, edition, deps): CanvasHostHandle;
```

- Lease states: free, held, releasing. Start order: lease, create, start, attach, resize, observe, activate, publish.
- Release order: detach; cancel activation; disconnect observers; flush settings; dispose the composition; unpublish. Cleanup errors are aggregated and reported once through `reportFailure`.
- Policies: lease and publish only in `app/canvas-map-surface/canvas-host.ts` (new, Phase 2b); `data-map-active` only from the map-surface visibility.
- Suite (`canvas-host.test.ts`, new with the host, through the real host): start order for each attach outcome; a cancelled start reads unavailable; the release order; a failed attach aborts; a guarded unpublish that throws; an owner cleanup failure with no unhandled rejection; aggregated errors.

## 6. MapPort and the RasterDisplay sequence suite

- Each consumer in `maplibre/` declares its port as `Pick<maplibregl.Map, ...>`. No hand-written map interface and no `as unknown as` map cast remain. `app/`, `canvas/` and `components/` reach the map only through `maplibre/` modules. `maplibre/` hosts a scene through `SceneHostLayer<Snapshot>` and never builds the Pixi layer.
- `maplibre/` imports nothing from `canvas/` (ADR 0022). It also exports the MapLibre DOM class constants (read by `canvas/runtime/input/dom-input-source.ts`, `map-background.ts` and `view-snapshot-map.ts`; the panel CSS's MapLibre selectors move into a `maplibre/` stylesheet) and owns the `maplibre-gl.css` import, which edition roots take from it. The contour style builders (`canvas/contours.ts`) move into `maplibre/`; the World map is deleted (2.1-E5).
- One `createFakeMap()` in test support implements the union of the picks with behaviour: style load and reload events, sources, layers, `getZoom`, `getBounds`.
- `maplibre/map-lifetime.ts` owns `creating, admitted, ready, failed, released` and one style-readiness signal; a per-layer sub-state lives under ready. It absorbs the admission states of `app/canvas-map-surface/workspace-map-controls.ts` (settled, context loss, a later style); the satellite configuration is passed in, and the band order and the shared scene layer id move into `maplibre/`. A later `style.load` fails the map with Retry (ADR 0004), never a silent empty map.
- One composition owner in `maplibre/` serves the workspace, the story presenter and the snapshot map, which is built through the same factory and lifetime; its caller hands it the scene layer factory, and both scene layers dispose before `map.remove`: a view saved with contours on gives a thumbnail whose style holds the contour layers. One contour style builder (minor, major = interval × 5, labels) serves the terrain contribution and the vector contour descriptors, and contour ink follows the map backdrop (`mapBackdropOf`), never the UI theme.
- Web Mercator has one owner per language: the Rust `crs` leaf's `web_mercator` module and `geo/web-mercator.ts` (metre and unit forms), with `inspection.rs` the one named oracle; the display descriptor carries `lattice_zoom: Option<u32>` from warp, and `overzoom.ts` overzooms only when it is set and the source is 3857.
- Raster pool tests run the real worker handler, a lane-protocol module that `worker.ts` only wires, through `inProcessLane(fixtures)` with timing controls (hold, release, hang); `FakeLane` and `IdleLane` are deleted.
- Browser tests route the basemap through one `e2e/support/basemap.ts` (`serve`, `hold`, `abort`), its pattern built from `OPENFREEMAP_BASEMAPS`.

RasterDisplay sequences, run on the fake and on the real `LayerManager` with the real pool and worker (the P1 harness):
1. `[A] -> [] -> [A]` draws A's tile for a single-asset and a two-asset item.
2. `[A] -> [B] -> [A]` (ramp to another variant and back) draws the mosaic.
3. A ramp or range change keeps the tile drawn.
4. A later `style.load` mid-sequence fails the map with Retry, and the Retry map draws every shown layer.
5. Dispose releases every pool source.
6. A refused source shows as that layer's failed status and a diagnostics entry, never a silent empty tile.
7. A hung lane is released by the task deadline.

## 7. Item kind

`LibraryItemKind` is a closed enum in `canopi-types` with its stored literals (`literal()`, `ALL`), which `bindings-gen` emits, not a trait; `kinds.rs`, a `canopi-library` leaf (ADR 0023), owns its decode and the exhaustive matches over it (2.1-M46).

Two kinds exist in 2.1: `Raster` and `Vector`. Each operation lives in its own layer and matches on `LibraryItemKind` exhaustively, so the compiler's list of non-exhaustive matches is the checklist a new variant fills. The `Vector` variant comes with bring-your-own vectors (2.1-Q100), imported through the one bounded GeoJSON reader and drawn by `maplibre/library-layers.ts`; hydrology's vector outputs reuse it.

The summary and delete shapes carry no raster-only field, so the point-cloud variant (seen and profiled, 2.1-Q79) adds a display and a profile, not a second summary.

```rust
// canopi-types (bindings-gen emits it; kinds.rs matches over it)
pub enum LibraryItemKind { Raster, Vector }      // stored literals 'raster', 'vector' (in the v26 CHECK)
// repository
fn decode(row: &ItemRow) -> Result<Item, LibraryFailure>;   // the only reader of the kind column
fn claims(item: &Item) -> Vec<LibraryPath>;      // what the janitor must keep
// extensions
fn prepare_display(item: &Item, variant: &Variant, recipe: &DisplayRecipe) -> DisplayState;
fn sample(item: &Item, at: SessionPoint) -> Result<Sample, LibraryFailure>;   // native value sampling
```

- An unknown stored literal is refused by `decode` and by recovery; it is never read as a raster.
- `bindings-gen`'s enum is bound to the frontend `LibraryItemType`. Frontend picking stays in `sampler.ts` (R5).
- **Quantity and display table.** One table in `canopi-types` beside `LibraryItemKind`, keyed by quantity and role; 2c lands it with its TS emitter and the unit columns (unit family, and display units and precision per unit system, §14), and N1 adds the display columns: scale (linear, log or circular), importable, declares units, fixed unit, the ramps offered with the default first (no blue outside water), the default range, whether relief draws and the profile role.
  - Rust `draws_relief` and `build_plan` and TS `kindRamps`, `kindDisplayDefaults`, `displayVariant` and `profileRole` read it; `RASTER_QUANTITIES` is deleted and `item-types.ts` keeps only TS-only facts keyed to the generated rows. Check `every_output_quantity_has_a_row`.
- **Display recipe.** An analysis row carries its recipe, the one owner of each field it has: scale (linear or circular, Q31), its output quantity (whose row gives the default ramp) and output sentinels masked as no-data (aspect's flat -1). The windowed tool contract declares those sentinels. `prepare_display` reads only the recipe; the item-type descriptor's scale is generated from it.
- **Descriptor contract.** The legend, the value readout, the range controls and the style controls read only the item-type descriptor; colormap stops come from the renderer's table, not a hand copy. Unit formatting dispatches on the descriptor's quantity, not unit strings. The descriptor also carries the lineage table (L4: label, filter group, can rerun, can refresh, detail facts), so panels never read `role` or `provenance.analysis_id` (ast-grep `no-lineage-field-read`).
- **Lineage.** One field per item, `Source | Analysis{provenance} | External{tool, date, notes, links}`, replacing `LibraryItemRole` and `provenance` in catalogue step v25 to v26, a frozen step with its fixture that rebuilds its tables on a verified copy (ADR 0026); out of date and Refresh exist only for `Analysis`. A derived result's name is written once in the language used at calculation and is editable (2.1-Q98). Unsupported-CRS advice names only supported systems whose area covers the file, or a short list when the extent is unreadable (2.1-Q99).
- **Generated, once.** The quantity rows and each importer's accepted-format list are generated from `canopi-types` to TS; the file dialog filter (`actions.ts`) and suggested-name stripping (`suggestedItemName`) both read the list. `bindings-gen`'s registry schema derives from the `canopi-types` serde and schemars types, so a new group, lane or kind is edited once. The gallery replays transcripts the real commands write (§13).
- Catalogue CHECKs list the enum's literals and change only through a catalogue step.
- **Stored enums.** Every stored enum in `canopi-types` (`LibraryItemKind`, `LidarImportProgressPhase`, `LidarDisplayRangeBasis`, and §8's one job state and outcome, which replace `LidarImportJobState` and `AnalysisJobState`) has one `literal()` and an `ALL` table; decode refuses an unknown literal with a typed failure; the repository binds values as parameters; each catalogue step's CHECK text is generated from `ALL` (the `lidar_jobs` state and outcome CHECKs among them), and a unit test holds each CHECK to its enum.
- **Names and coverage.** The `canopi-library` repository owns item names: one key (trim, NFC, a language-free lowercase fold) under a UNIQUE index over source layers and derived items, one allocator in the write transaction for import, rename, recovery and derived results, a clash settling `conflict{what: name, suggestion}`. Import coverage asks the scene runtime for the Design's outline points (rotated zones, ellipse polygons, plant crowns at canopy spread, guide ends) by a read-only query.
- **Files the WebView reads.** The host grants every WebView-readable directory (display COGs, later display vectors) from one list the LiDAR paths owner exports, and the image cache from its own owner; a mock-app test serves a display COG and refuses a file in `display-cog-staging`. A file the user picks is not on that list: dialogs run in the host, so the dialog plugin adds no picked file to the scope, and a contract test refuses one over `asset://` (2.1-M81).
- **Library changes** reach the frontend through one `tauri::ipc::Channel` subscription per caller, which sends the current state on subscribe and then each change in order, refreshing the snapshot; no broadcast event, and no TS code compares job-state names (2.1-M56).

## 8. Jobs state machine

One `lidar_jobs` table for imports and analyses, written only by the `jobs.rs` runner; catalogue step v25 to v26 merges 2.0's `lidar_import_jobs` and `lidar_analysis_jobs` into it, and this is the shape the reader release freezes in catalogue 26.

| From | Event | To |
|---|---|---|
| (new) | submit | Queued |
| Queued | runner starts it (heavy capacity 1, FIFO) | Running |
| Queued | cancel | Settled(cancelled) |
| Running | cancel before the runner registered its token | recorded, applied at registration |
| Running | work returns or cancel is seen | Settling |
| Settling | publish or discard done | Settled(succeeded, failed{code} or cancelled) |
| Running, Settling | found at open, or drained at quit | Settled(interrupted), offering Run again (2.1-Q61) |
| Queued | found at open | Settled(interrupted), offering Run again (Q38) |
| Settling | cancel | ignored; settles normally |
| Queued, Running | an input item deleted | refused: Delete settles `conflict{what: job}` and names the job; the screen offers to cancel it |
| Settled | Dismiss | row deleted, then the janitor runs |

```sql
state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'settling', 'settled')),
outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'interrupted')),
failure_code TEXT,
operation_id TEXT NOT NULL,                       -- the action's OperationId (ADR 0025)
CHECK ((state = 'settled') = (outcome IS NOT NULL)),
CHECK ((outcome IS 'failed') = (failure_code IS NOT NULL))
```

- Each transition is a guarded `UPDATE ... WHERE id = ? AND state = ?`; 0 rows matched is `conflict{what: job}`.
- Settled is final; Retry submits a new job. State changes are a revision watch plus a re-read, which cancel, Delete, Dismiss and the janitor wait on. No polls, and no lossy broadcast.
- Progress: the watch carries progress for every job kind (phase plus fraction, or indeterminate) on the same channel subscription, so imports keep what `LidarImportProgress` shows today (2.1-M56).
- A settle that fails (`io{no_space}` during publish included) hands its `writing` claims to the janitor at once.
- Open runs in order: recovery settles every found job as above, then turns every `writing` claim into unclaimed (Desktop runs one instance, so none is live at open), then the janitor's open run sweeps.
- Quit, drain and facade gating: ADR 0024 Close and hide, Native executor and Library jobs (2.1-Q61). The drain also cancels display preparation with reason `Shutdown`, waits a bounded time, then kills the sidecar child; a row not settled by then settles Interrupted at the next open.
- Test: a model-based sequence test against the real runner and the SQLite CHECK, covering cancel while Settling, input deletion, progress, a failed settle, quit while Running, and open recovery before the sweep.

## 9. Library file lifecycle rule

- Every library writer (import staging, analysis roots, display derivatives), and Delete and Dismiss (Q39), records a claim in the catalogue before its first write: path prefix, owner (item, generation, job or display entry), state `writing` or `live`.
- The janitor is the only module that deletes a library file. One Library-lane read lists the managed directories, then reads the claims; deletes run on the Local lane at background priority, so long deletes never hold the Library lane. Claim prefixes come from ids that are never reused (AUTOINCREMENT). The read marks the live set: claims of existing items, head and history generations, queued and running jobs, and every `writing` claim. It deletes what no claim covers, rows before files.
- It runs after each settle, Delete and Dismiss and once after open, at background priority, coalesced, with no lease. A run interrupted at any point is safe to repeat.
- Design-write sidecars have a recognisable name and are swept only beside their target on its next save. User folders are never walked.
- Tests: a property test interleaves a sweep with each writer kind and with open recovery after a crash; after settle and sweep the files on disk equal the claimed set. ast-grep `janitor-only-deletes`.

## 10. `.canopi` migration step

```rust
pub struct Step { pub from: u32, pub run: fn(serde_json::Value) -> Result<serde_json::Value, StepFailure> }
pub const FLOOR: u32 = 9;                        // v2.0.0
pub const STEPS: &[Step] = &[ /* v9 -> v10, ... */ ];
pub const CURRENT: u32 = FLOOR + STEPS.len() as u32;
pub enum Admission { BeforeFloor, Migratable { from: u32 }, Current, Newer }
```

- The chain lives in `canopi-format` (ADR 0023). A migrated open is clean, so only a real edit writes. The pre-upgrade copy, `copy-blocked` and which opens show the notice: ADR 0026 `.canopi` admission (2.1-Q35r); the copy is named `<name> (Canopi <old version>).canopi` and never overwrites an existing file.
- A `StepFailure` refuses with `design_load{migration_failed{from}}` and the step's from-version; the file is left unchanged and the refusal is reported. A Draft or stamp file that fails is listed as unreadable, never hidden. The harness covers it with a planted failing step.
- A step is pure: no I/O, clock or randomness. Its input is checked by the frozen vN-1 schema and its output by the vN schema. It never touches the live structs.
- Steps run in order, once, at the one decode choke point, before the schema decode. Open, Drafts, stamp files and write admission all pass through it. Web runs the same code in the core worker.
- Each released version has `canopi-format/spec/v<N>/`: schema, fields, new-Design defaults, `fixture.canopi` cut from its tag (v10's from the first build that writes v10, 2b), its hand-written expected output, and the `additions/` annex for optional fields valid alone (Q36).
- The reader release freezes only v10's read schema, a hand-made read fixture and its expected read output, while `DESIGN_FILE_FIELDS` still describes v9; a release check holds the emitted v10 schema equal to that read schema or its `additions/` (2.1-M31).
- A version fixture covers every `DESIGN_FILE_FIELDS` key with a non-default value, every nested struct filled, and one unknown root key.
- The v10 step (2.1-Q69) makes ramps, raster quantities and locales open strings (an unknown literal is kept and the documented default used) and gives every nested object an extension bag that keeps unknown keys. It moves `extra.plant_display` into the typed Document field `plant_display` and passes any other unknown `extra` key through; if none remain, the extra-key registry is deleted; its symbol-scale range is the settings field table's.
  - The budget shows plant lines only, each reduced to its target and unit cost, with one currency per Design (2.1-Q96); non-plant lines move unshown into the budget's extension bag (2.1-Q162).
- Group members are typed ids of plants, zones, notes and measurement guides (2.1-Q154); the guide member kind is in the v10 read schema Step 2.0.4 freezes (2.1-M94). Admission normalises groups at decode (dangling members removed, groups under two members dropped) and refuses them on write; a corpus case has a one-member group and a dangling member. In TS one `normaliseGroups(groups, existingIds)` in the scene layer serves mutations, notes, stamp files, GeoJSON import and arrangement placement.
- v10 additions after the freeze (2.1-Q36, 2.1-M94), each under `additions/` with no step and ignored by the reader release: the Document field `print_setup` (2.1-Q152, 2.1-M90: pages by stable id, each area a WGS84 centre and a ground size along the page axes, each page's angle in degrees clockwise from true north and its framing, the paper and print options) and the zone stroke colour and opacity (T4).
- A Recent Designs preview that cannot be read carries the core's `DesignLoadFailureKind`, beside its size cap and transient-or-cacheable flag (`NAT-11: Recent and Open give the same refusal for each corpus file`).
- Tests: the chain runs from every fixture to head against its expected output; `migration_steps_frozen` pins released steps by content hash; a release check fails on a schema change without a step and fixture; `canopi_format_fixture_covers_every_field`; the encode-decode round trip and "every accepted Design re-encodes to an admitted file" as property tests.

**The design-core port** (`platform/design-core.ts`; Desktop binds the native commands, Web the worker adapter):

```ts
interface DesignCore {
  decode(bytes: Uint8Array): Promise<Result<OpenedDesign, Refusal>>;   // cap, JSON, version, chain, admission
  encode(design: InMemoryDesign): Promise<Result<Uint8Array, Refusal>>; // admission on write
  newDesign(input: NewDesignInput): Promise<Result<InMemoryDesign, Failure>>;  // input carries the plant_display defaults from settings' NewDesignDefaults slice
  draftEnvelope(record: unknown): Promise<Result<DraftContent, Refusal>>;
}
// Web adapter states: loading | ready | load-failed | poisoned (then respawned)
```

- The one compile, settlement, traps, load-failed and encode traps: ADR 0025 Format core failures on Web (Q34). The worker is recycled after a large open, once idle.

- Only `platform/design-core.browser.ts` imports the `canopi-format-wasm` glue. It reports the core version; a test checks it equals the crate version.
- Edit-time predicates (colour range, opacity, rich-text links, embedded image bytes) stay in TS in `app/design-edit/document/admission.ts`, over constants generated from `design.rs`; a vitest contract test holds them against the core. `app/contracts/design-admission.ts` is deleted.
- The one New Design command in `app/shell-commands/` calls `openFrom` with `NewDesignInput`, then, when Settings › New Designs › Open on satellite is on (the settings' `NewDesignDefaults` slice), `setMapBackground('satellite')` once it settles `applied`; `app/settings/new-design-defaults.ts` and its two call sites are deleted.
- Deleted when the core lands: the TS schema decoder, `design-ingestion.ts`, the TS write-admission mirror and encoder, and the four TS new-Design builders (the stamp file's `composeSavedObjectStampCanopiFile` is the fourth: the stamp file is built from the core's builder and the codec's per-entity serializers, and `STAMP_FILE_LAYERS` is deleted).

## 11. Local-data migrations and the Web Drafts move

| Store | Kind | Floor (v2.0.0) | Chain home | Runs in |
|---|---|---|---|---|
| `.canopi` files, Drafts, stamp files | user work | 9 | `canopi-format` | native, and wasm in the Web worker |
| settings record, Desktop and Web | user work | 1 (a 2.0 record has no version field and reads as 1, inside the chain; the v2.0.0 fixture is that unversioned record) | the settings field table: each step is data (add a field with its default, rename, drop, map a literal), and both editions' runners are generated from it (2.1-E6); a step that cannot be data moves the chain into `canopi-format` | native; Web, both generated |
| user DB (table shape only) | user work | 9 | `canopi-store` | native |
| saved-stamp payloads (`payload_json`, relative metre arrangements, not `.canopi`; type `SavedObjectStampPayload` in `canopi-types`, its TS type, version constant and frozen schemas emitted by `bindings-gen`; `canvas/saved-object-stamp-payload.ts`'s copies deleted) | user work | 2, the payload version each row carries; 2.1 adds the v3 step (guides, pinned names, locks, notes, species appearance, 2.1-Q155's care actions and species data; 2.1-M88), and a reader that meets a newer payload lists it as needing a newer Canopi and never places, writes or deletes it | `canopi-format`, run per row at open by each edition's stamp store (`canopi-store` on Desktop, a browser record on Web, 2.1-Q112); the store owns the library order (new rows take max + 1, reads return the ordered library) | native; wasm |
| library catalogue | user work | 25 | `canopi-library` repository | native |
| source `meta.json` | user work | 1 | `canopi-library` | native |
| Web browser record containers in `localStorage` (the 2.0 Drafts key, unwritten after the IndexedDB step; species lists, saved stamps, the Design Notebook keyed by home id) | user work | 3, the container's own version, separate from each record's | `platform/` browser adapters | TS |
| Web Data library (the item records in IndexedDB and their files in the browser's private file storage, N5) | user work | its first 2.1 version (a new store, no step) | the `platform/` browser library adapter | TS |
| display COG cache, previews, image cache | derived | none | none | wiped and rebuilt on a bump |

- A runner per store: `FLOOR`, ordered `STEPS`, `CURRENT = FLOOR + STEPS.len()`, so a bump without a step does not compile. Below the floor follows ADR 0021; newer is refused unchanged, except that the reader release reads a newer form of each store it froze (Rollback below).
- Open lifecycle: opening, migrating, then ready, recovered{counts}, newer-read-only (a version at or above a form the reader release, or a further reader release, froze: it reads only the fields, tables and literals it knows, is shown and never written; Step 2.0.4, 2.1-M32), refused-newer, set-aside-damaged{file} or unavailable{code} (for settings, a reset field is ready with a notice, not a state): the `StoreOpenStatus` union in `canopi-types`.
- `SubsystemHealth` is one record from store id to it, filled by each runner on Desktop and the browser adapters on Web, read by one model in `failures/`; the plant catalog row is read-only (ready or unavailable). The status feeds the problem report.
- Degraded stores: ADR 0026 (2.1-Q67); reading a store never writes it. Durable files go through `canopi-support`'s `publish_durably` behind the `DurableFs` seam; each writer's sidecar name is unique.
- A migration works on a copy and swaps it in durably once verified; the original is never half-migrated. SQLite steps run in one transaction on the copy and write their store's own version marker: `user_version` for the user DB, the `lidar_catalogue_meta` row `schema_version` for the catalogue.
- Settings (2.1-Q54): a bad value resets only that field; the original record is kept once as `settings.before-reset` (a user-DB row on Desktop; secret, never read by the app, replaced by the next reset) before the reset is written; writes are patches of changed fields; one fixture corpus in `canopi-types` runs through both editions' runners.
- Rollback: ADR 0026 (2.1-E4, 2.1-Q138, 2.1-M21). The reader release (Step 2.0.4) reads every 2.1 form and writes none, so each store migrates in place: no new homes, no unwritten previous forms, no kept copy of a replaced form. Desktop settings stay the user DB's `settings` row (2.1-M17). Kept for their own reasons: the `.canopi` pre-upgrade copy (2.1-Q35r), each migrated Desktop Draft's v9 form in `drafts/before-v10/`, the 2.0 Web Drafts key and a new Web key for settings and each record whose shape 2.1 changes (older tabs, 2.1-Q83).
- Tests: a fixture per store from each release tag; the chain runs from each to head; the rollback lane (Step 2.0.4) runs the readers on each 2.1 store step's output and finds it read and no byte written, built from the release candidate on the frozen fixtures until the reader release is tagged, then from the latest stable 2.0.x tag (2.1-M37); on a `release/2.0` PR or candidate, from that candidate, on the fixtures and on what `main` or a pending store step's branch writes (2.1-M68).
  - The D3 rollback test installs the latest 2.0.x stable release over 2.1.0's stores and finds each shown read-only, then the last 2.0.x before the readers (2.1-M33), which on Desktop refuses each 2.1 store unchanged and prunes no library file, and on Web keeps to its 2.0 keys and leaves every 2.1 record byte-identical.

**Web Drafts move to IndexedDB** (the first Web step):
- Object store `drafts`, key `id`; a record holds `id`, `canopi_version`, `revision`, `name`, `updated_at` and the Design as `.canopi` text, read through the core's chain. Web settings carry the settings record's version (from 1) and species its own record version; the container version counts from 3. Settings and every record whose shape 2.1 changes move to a new key, leaving the v3 key to 2.0 tabs (ADR 0026 Rollback). Saved stamps get their own browser record (2.1-Q112).
- Persistent storage is requested on the first Draft with a one-line reason; if refused, the welcome screen and save status warn and offer Download .canopi (2.1-Q82). Step 2.0.3 builds it on the localStorage store; the grant is per origin, so this store keeps it unchanged.
- A write gets, compares and puts the revision inside one readwrite transaction; a mismatch is `draft_conflict`. Writes are async. The adapter flushes on `visibilitychange` to hidden, and again on `pagehide`; the pending-write marker covers a write the page did not live to commit. A quota failure is `draft_quota_refused`.
- The step copies every Draft from the old localStorage key, refused ones included, each into its own record in one transaction. The comparison form is the canonical encode of each draft object: the old key holds parsed objects and a record holds `.canopi` text, so the copy writes the canonical encode and the read-back compares every id and its canonical encode with the record. The old key then stays unwritten, for tabs older than the reader release and as the lossy v10 step's 2.0 form; 2.2 removes it (2.1-M21). On a mismatch the failure is reported and the step runs again at the next open.
- The step runs whenever the old key exists, at open and on a `storage` event for that key, so a 2.0 tab that writes after the move is caught.
  - Each old-key id maps to at most one "copied from an older tab" Draft, kept in the store's id map with the canonical encode copied at the move. An id whose canonical encode equals that moved encode, or its existing copy, is skipped; the record's current content is never the comparison, because a 2.0 tab rewrites every id, including Drafts edited since in 2.1. Otherwise the first such write creates that id's copy and later writes update the same copy, so the user's original record is never overwritten, a 2.0 tab left open adds at most one Draft per id, and each copy is reported once.
  - A two-tab e2e (the last 2.0.x before the readers writing Drafts, settings, favourites and recently viewed after the 2.1 deploy, and a reader-release build holding the Draft store open) is in the Draft-store suite; the 2.1 records stay unchanged and the upgrade is not blocked.
- An old tab meets a newer database (Q40): on `versionchange` it saves, closes and shows the one "New version: Reload" notice (2.1-Q83). If that save fails, it keeps the Design in memory, offers Download .canopi before the reload message and arms the leave prompt, then closes.
- The reader release lists this store's Drafts read-only through the format worker and hides an old-key Draft with the same id; it reads settings and the species-list record read-only from their 2.1 keys, and writes none of them. It checks the store exists with `indexedDB.databases()` (or aborts the upgrade at `oldVersion` 0), so it creates no database, and its connection follows Q40 below.
- While the upgrade is blocked, the new tab shows `draft_store_blocked` from the `blocked` event. An older build refuses a newer store with `draft_store_newer`.
- The pending-write marker is a localStorage entry per Draft id, written synchronously before each write and cleared when its transaction completes. Found at open, it shows a notice naming the Draft whose last change may be missing, and the event is reported.
- The connection closed on `pagehide` goes back to opening on `pageshow` with `persisted` and on the next write.
- The store is constructed with its `IDBFactory`, so the fault suite injects quota and abort (Q47).
- Browser tests seed storage only through the adapters' exported keys and encoders, and seed a Draft by calling the real Draft-store adapter in the page (`e2e/support/web-storage.ts`; ast-grep `no-raw-web-storage-key-in-e2e`).
- The Draft-store suite covers each case above in Chromium, WebKit and Firefox.

## 12. Ratchet file and planted violations

One directory, `desktop/web/policy/ratchets/`, one JSON file per rule family, read by every fitness check. Phase 0's F3 builds its checker and format; each step's owners file says who edits each family file (2.1-M26, 2.1-M73, 2.1-M95):

```json
{ "version": 1,
  "ratchets": {
    "l3-feature-scc": { "tool": "dependency-cruiser", "baseline": 27, "entries": ["app/lidar <-> app/shell"] },
    "jscpd-clones": { "tool": "jscpd", "baseline": 0 } } }
```

- A named ratchet lists its violations; a count ratchet holds a number, and only jscpd clones and the performance budgets are counts. oxlint is named: the checker turns its JSON into per-file entries; dependency-cruiser's `--baseline` and `--ignore-known` output is normalised into these files, never kept as a second rule home; rustqual's JSON, while its trial runs, gives named entries and never its score (2.1-M58, 2.1-Q142). The primitive ratchets of §18 are named: each entry is `path: count`, and a site in a file not listed fails even when the total falls. Each entry may carry a bead id.
- CI fails when a violation is not listed or the count rises, and when a listed entry no longer occurs or the count falls without the file being lowered. So the file only shrinks and is never stale.
- Raising a baseline or adding an exception needs a commit naming a bead id and a ledger id; the pre-commit gate, and its CI run over the PR's commits (2.1-M14), resolve both: the bead exists in `.beads/issues.jsonl` and is open, and the ledger id is a Q row (a user decision); an E or M row never authorises an exception or a raised baseline (ADR 0028).
- A new ratchet family lands green: its first baseline lists today's sites and its planted violation fails. The gate accepts that first baseline in the commit that creates the family when the commit names the family's ledger row, E and M rows included; the Q-row rule above covers raising an existing family's baseline or adding an entry to it (2.1-M40).
- An entry renamed with its file in the same commit, at the same or a lower count, the rename detected by git or named in the layer table, is a rename, not an added entry, and the gate accepts it without a Q row (2.1-M74).
- Guarded data files hold user-reviewed contracts: the ranking corpus in `canopi-types/species-search-ranking.json` (§15), the quantity table's precision columns (§14) and `policy/edition-capabilities.json`. The gate refuses a change to them without a Q row in the commit; a capability row whose Decided id is not a ledger row fails `policy-tables-check`. The performance budgets are ratchet entries, guarded by the rule above.
- The test-deletion guard (ADR 0028) accepts a deleted test, or a removed or loosened `expect` in a kept test, only with a new test whose title the commit names, a Q row, or a `Retires-test: <title> — <why no user sees it>` trailer in a commit that deletes the code under test.
- The policy inventory (`policy/inventory.json`) has one row per stated rule: `{id, doc, quote, state}`, where `quote` is an exact phrase `check_docs.py` finds in `doc`, and `state` is `exists{check}`, `planned{phase, bead}`, `advice` or `process`. `check_docs.py` fails when a quote is gone, when an `exists` check is not in the checker's registry, and at a phase close when a `planned` row names that phase. A change to `advice` or `process` from `exists` or `planned` needs a Q row, held by the gate.
- A rule's owner path follows the layer table's destination column, so a move in the table renames the owner in the generated rule (§18 F13 moves with `civil-date` in 2a).
- Each rule has a planted violation under the checker's fixtures. The test runs the real tool with the real config on it and asserts that rule's id fails. A rule without a planted violation fails the checker.
- The fail-closed checker also refuses a missing source table, a path that no longer exists, an unused exemption, a missing required rule, and a reporter that exits 0 with errors.
- The layer table (`desktop/web/policy/layers.json`, ADR 0022) is a source table like the others; each upward or cyclic edge it removes is a named ratchet entry, so exits are measured per edge.
- Rules added by the Q45 pass, each with its planted violation:
  - `no-hand-generation-guard` (controllers use the scope's `latest()`), `bare-catch-names-reason` (a bare catch reports or names its reason); search folds are §18 F18's `search-fold-only-in-search-text`;
  - `no-shell-breakpoint-media-query` (640, 480, 960, 760 px only through the shell's `data-layout` attribute), `no-reexport-only-types-module`, `no-inline-dialog-filters`, `no-hard-coded-import-extension`, `no-currency-symbol-table`, `number-format-only-in-utils`, `no-webmercator-literal`.
- Class C07's `no-hard-coded-label` (Phase 1b, with its planted violation): a JSX text node, or a `label`, `title`, `aria-label` or `placeholder` attribute, holding a literal outside `t()`.

## 13. Contract suites (Q16)

Only where a fake carries behaviour or two real sides exist:

| Suite | Sides |
|---|---|
| Runtime surfaces | the test fake and the real scene runtime, commands and queries together (`tools.arm` then the read-only tool, selection and revision bumps); the fake imports `sceneHasObjects` and the layer state from the scene module |
| RasterDisplay | `createFakeMap()` and the real layer manager, pool and worker |
| Session ports | the Desktop and the Web adapters |
| Draft store | Desktop Draft files and IndexedDB (Chromium, WebKit, Firefox) |
| Settings store | the Desktop and Web runners on one fixture corpus in `canopi-types` |
| Stamp store | the user DB and the Web browser record |
| Design Notebook store | the user DB and the Web browser record, keyed by Design home (N2) |
| Web species reader | the real DuckDB reader and the native catalog commands, on one fixture catalog built by the production pipeline (a synthetic seed through `prepare-db.py`, then the Web generator; the Web generator alone once E1's switch deletes `prepare-db.py`, 2.1-M51) and the ranking corpus (§15); filters, options, names, cursor, browse order and photo attribution included. The reduced-catalog fake is deleted |
| Species user lists | the Rust `user_db` store and the Web browser adapter: cap 50, oldest dropped first; re-viewing moves a species to the top without a duplicate; newest first; a favourite toggle is idempotent |
| LiDAR transcripts (replaces the LiDAR facade row) | the real commands through the `fixed_library_tests` mock app write `ui-gallery/fixtures/lidar/*.json` in check mode; the gallery replays them, and the freshness check fails on drift; `engines` and `LidarEngineStatus` are deleted |
| Redaction | the Rust and TS redactors on one JSON corpus, plus a property test |
| Native scheduling | the Rust executor and the TS transport on shared fixtures |
| Failure report | the Rust report builder and the TS diagnostics ring (level typed `FrontendDiagnosticLevel` from `canopi-types`) |
| Format core | the TS edit-time predicates and the core; the core natively and through the real worker on the corpus |
| Data library port (N5) | the Desktop adapter over the library commands and the browser adapter over private file storage and the terrain worker: import, list, delete, display, sample, profile and the terrain analyses on one fixture set, the analysis goldens equal on both |

## 14. Locale registry, numbers and units

One table in `canopi-types`, generated to TS: `code`, `endonym`, `catalog_column` (a `value_*` column), `week_start_fallback`, `plural_categories`.

- Adding a locale is the L6 change: one row, one locale file, the glossary data. Its catalog side is the L20 change: a `value_*` column in `scripts/schema-contract.json` and a catalog data release.
- `translate_value` reads the column through the registry's closed set: one static query per locale, generated, never string-formatted SQL. A missing translation falls back to English and logs once at debug.
- **First-run language.** One matcher, written in Rust from the registry rows and emitted to TS, takes an ordered tag list and returns the first tag whose primary subtag (case-folded) is a registry code. Desktop passes `[sys_locale]`, Web `navigator.languages`; it runs only when no settings were ever saved, through the locale row's first-run default `detected` (ADR 0024). Test: one tag corpus (`fr_FR`, `pt-BR`, `zh-Hant-TW`, `xx`) through both.
- **Week and dates.** `civil-date` (`app/timeline/` until 2a moves it to `planning/`) owns week start, date parsing and date display: instants show relative in lists and as full date and time in detail panes (2.1-Q103); its fallback table is generated from `week_start_fallback`, and the DatePicker reads it (`SUNDAY_START_LOCALES`, `weekStartsOnSunday` and `parseISO` deleted).
- **Numbers, sizes and money.** One `utils/format.ts` owns locale number formatting and parsing: the typed-number parser, percent, `formatLength` and `formatArea` over the unit table below, `formatByteSize(bytes, locale)` (SI 1000 with `Intl` unit labels; limits passed in bytes), the scale-bar step (`niceDistanceAtMost`, shared by the zoom group and the PDF footer) and the CSV's currency decimals from `Intl`. Currency symbols come only from `Intl` for the active locale; `app/budget/` keeps the offered ISO codes.
- **Units** (2.1-Q53, 2.1-Q97, 2.1-Q118 to 2.1-Q121). Storage stays SI everywhere (files, Drafts, catalog, runtime; no format change). Two unit systems, metric and US customary; the device setting defaults from the region (US, Liberia and Myanmar start US customary) and is never stored in a Design.
  - The quantity table (§7) is keyed by unit system: display unit and precision per quantity and magnitude. One parser serves every quantity field: it accepts both systems in any mode (`3 ft`, `5′ 6″`, `90 cm`), a bare number uses the current system, and the value shows back in the current system.
  - Precision follows the source's (catalog 3 m shows as about 10 ft). Grid, snap, scale bar and rulers use per-system nice steps; When the unit system is US customary, PDF offers architectural scales (inch-to-foot, such as 1/8″ = 1′-0″) beside the ratio scales, which stay available in both systems (2.1-Q133); the offered set is a row of the quantity table, reviewed with the example table. Unit maths and conversion constants exist only in the quantity owner (§18 F35). Unchanged: slope %, currency, hardiness zones.
  - Property test: a typed value shows back unchanged (3 ft never 2.99 ft). The example table below is for the user's review before 2c lands it; a later change names the user's dated decision.

| Quantity | Metric | US customary |
|---|---|---|
| Length | cm below 1 m; m with 1 decimal below 10 m; whole m below 1 km; km with 2 decimals | in below 1 ft; ft and in (5′ 6″) below 10 ft; whole ft below 1 mi; mi with 2 decimals |
| Area | cm² below 1 m²; whole m² below 1 ha; ha with 2 decimals | in² below 1 ft²; whole ft² below 1 acre; acres with 2 decimals |
| Temperature | whole °C | whole °F |
| Rainfall | whole mm | in with 1 decimal |
| Volume | L with 1 decimal | US gal with 1 decimal |
| Raster resolution | the length rule | the length rule |
| Catalog sizes | the length rule, at the source's precision | the length rule, at the source's precision (3 m shows as about 10 ft) |

- Checks: one consistency test (registry = `schema-contract.json` `value_*` columns = the Web catalog artifact's `locales` = `src/i18n/*.json`, and every week-start consumer, the DatePicker included, reads `civil-date`); `i18n-completeness` checks every counted string against `Intl.PluralRules` categories for each locale.

## 15. Catalog search ranking contract

Goal: best results first (user, 2026-10-17). The prototype (`proto/search`, 54 queries in 8 locales) showed one contract generating SQLite equal to today's Desktop on 54 of 54 top tens and DuckDB equal to that SQLite on 53 of 54, and that today's order opens about 20 of 54 queries on an unexpected species. The contract below is the user's (2.1-Q48 to 2.1-Q52).

One data file beside the normalisation contract, `canopi-types/species-search-ranking.json` (ADR 0027):

- `name_entries`: one row per searchable name (species, source, normalised name as space-joined tokens, display-name flag, length), built by the catalog build. Sources: the request locale's common names, other locales' names and synonyms, scientific names (canonical, family, genus).
- `match`: ADR 0027 Match (2.1-Q51).
- `tiers`, in order (2.1-Q49): the display name equals the query; a scientific name equals or starts with the query; the display name starts with the query in whole words; every token is a whole word of the display name; every token starts a word of it; any other locale name or synonym; compound parts and in-name CJK matches; last, on both editions, the text tier over uses, family and description, which the Web catalog ships (2.1-Q50).
- `order` after the tier: better-known plants first (the build-derived count of locales naming the species), then token position sum, display-name length, canonical name. No BM25, popularity or static weight column (ADR 0027, 2.1-Q52).
- The 2-letter staging rule is decided in the contract against the corpus: a rule both readers apply, or deleted. It is never a Rust-only behaviour.
- One generator emits the only SQLite query for `canopi-catalog` and the DuckDB query for the Web reader: static text, values bound as parameters, a drift test on each output. `relevance.rs`, the token-index and phrase fallbacks and the `supports_*` schema probes are deleted; catalog admission refuses a catalog without `species_search_name_entries` or `species_search_name_entry_tokens` as `plant_db_unavailable{schema_mismatch}`.
- Each result row returns the entry that matched (its text, locale or synonym kind, and which token matched), not character offsets. The catalog row computes its marks in TS from that entry with the normaliser and the word-start rule, and shows the matched name as a second line when it is not the display name; `findPlants` stops running over catalog results.
- `browse`: the Recommended order, one build-written score column in both outputs (edibility × 36 + other uses × 6 + medicinal, null when unrated), in phases: rated by score descending, then unrated named plants by name, then unrated unnamed plants by name. The Desktop keyset phases and the DuckDB `ORDER BY` are generated from it; `RECOMMENDED_PHASES` and the hand `ORDER BY` are deleted.
- The catalog build writes, for both outputs (the one Parquet once E1's switch lands, 2.1-M51), the name entries and tokens per locale, one display name per species and locale, the browse score, family and genus as species columns, and the photo attribution fields unchanged (source, page URL, credit, licence and its URL). The Web Parquet is written by the Python `duckdb` package running the same generated SQL (pyarrow the fallback), with typed columns checked against `scripts/schema-contract.json` by reading the schema back; the per-locale entries replace `names-*.parquet`.
- **Normalisation** has one implementation, `canopi-search-text` (ADR 0023), built from `species-search-normalization.json`: Desktop links it natively for queries and the SQLite function, the catalog build calls its key CLI, and the frontend calls `canopi-search-text-wasm` through `platform/search-text.ts` in the page wherever search and the in-Design finder run. Hiragana folds to katakana (`りんご` finds リンゴ). The Python and TS algorithms and their 9,228 lines of generated tables are deleted.
  - The shared corpus is the crate's oracle, run natively and through the wasm, and grows to ligatures, other scripts and every locale. A failed wasm load reports once and search says it is unavailable.
- **Filter options.** `plant-filter-fields.json` holds each closed filter's ordered `values` (climate zones added; habit is Desktop's four values on both editions, 2.1-Q59; life cycle and soil tolerances derived from their clauses), each shown with the interface glossary word from the locale files (2.1-Q55). Both readers return that list filtered by one rule (values present in the catalog); `species_catalog_contract.py` refuses a catalog value missing from it.
- **Web catalog.** It carries every field, filter, photo and fact Desktop has, read on demand by range requests (2.1-Q113); photos are one fixed-width Commons rendition on both editions, and a Desktop cache failure shows the failed-photo state (2.1-Q109).
- **Manifest.** One TS module, `admitWebCatalogManifest`, over constants `bindings-gen` emits from the artifact contract JSON; `web_release.py` and the generator tests run it through node, and the Python render step and the generator-to-generator calls are deleted.
- **The corpus** (2.1-Q48): per locale, real queries with the best result first, plus empty-query rows for the Recommended browse, seeded from today's Desktop with wrong-first rows corrected to what the user expects (the prototype's side-by-side tables beside it), reviewed by the user once. A changed row names the user's dated decision. It runs on the one fixture catalog (§13) natively and through DuckDB, and checks that each top result's marks fall on word starts of the entry that matched. Fakes and the gallery return fixed results in the corpus order and never rank.

## 16. FileDelivery rows and file kinds

- A row is `(content, stem, kind)`. One file-kind table (canopi, geojson, pdf, csv: extensions, MIME types, label key) feeds every FileDelivery row, the Desktop dialog filters (TS and Rust `pick_geojson_file`, which takes the extensions from its caller) and the Web `accept` strings.
- The port's shared core owns the one sanitiser, the one replacement character and the one localised fallback stem (`Untitled` through `t()`); the stem comes from `fileStem` (§4). The five local sanitisers are deleted.
- Test: one table per edition over every kind and suffix, the budget CSV's `-budget.csv` included.

## 17. Species lists inside the app

- Every plant list on both editions (Find plants, Web and Desktop favourites, recently viewed) ranks through `findPlants`, which applies the match rule and tiers of `species-search-ranking.json`, emitted to TS, over `platform/search-text.ts` keys (§18 F18), and has no tier logic of its own: best match first, ties in list order. It joins the ranking corpus suite (§15) for in-list rows. Non-plant lists (calendar, Start screen, Drafts) share one text filter over the same normaliser. `utils/normalize-search.ts`, the Start screen fold and `filterFavoriteSpecies` are deleted.
- Favourites and recently viewed: cap 50, oldest dropped first, newest first, one row per species, the cap stated here once (§13 suite). A shared constant only if the cap becomes a setting. A species is recorded as recently viewed once its detail has loaded, once per opening (2.1-Q102).
- Every Design species list and legend without a query is alphabetical by the shown name, collated in the interface language, the Latin name breaking ties (2.1-Q94); one species-legend builder serves the panel, the canvas legend and PDF.

## 18. Primitive owners

Each raw primitive a second copy would use has one owner and one rule (ADR 0028), landed in Phase 0 (but the rules named below) as a shrink-only ratchet whose baseline is the count measured on `main` after the 2.0.3 tag and F0's toolchain upgrade (the counts below are sites / files at 2.0.1, references only, 2.1-M39, 2.1-Q141); the ratchet reaches 0 in the last phase or stream named.

F35, F36 and F29's ToolHost owner test have no Phase 0 count: each lands as a new family of today's sites at its stream's start (2c, 2m, 2c), failing on its planted violation (§12, 2.1-M40); F28's `wasm-glue-only-in-adapter` lands with each `-wasm` crate (ADR 0022), since Phase 0 has no glue to guard (2.1-M77). A rule's failure message names its owner and a canonical example.

| # | Primitive | Owner | Rule | Baseline | Phase |
|---|---|---|---|---|---|
| F1 | Tauri `invoke` | `ipc/` generated `invoke<K>` | `invoke-only-in-ipc` | 2 / 2 | 2a |
| F2 | Tauri window, dialogs, `convertFileSrc` | the `platform/*.desktop.ts` adapters: file access (dialogs, display URLs; 2.1-M12) and window control | `tauri-only-in-ipc-and-platform` | 9 / 8 | 2a, 2b |
| F3 | Notices and toasts (plugin-dialog `message`) | the `failures/` notice signal, its one notice row and one window-level toast slot | `notice-only-in-failures` | 2 / 2 | 1b, 2a, N2 |
| F4 | `new maplibregl.Map`, style readiness | `maplibre/map-lifetime.ts` and its factory | `map-constructor-only-in-factory`, `style-load-only-in-map-lifetime` | 3 / 3; 12 / 5 | 2d |
| F5 | `addSource`, `addLayer` and removals | each workspace map contribution | `layer-order`; the `ownsResource` contract | 1 / 1 outside | 2d |
| F6 | `maplibregl-*` classes, the MapLibre CSS | `maplibre/` constants and import | `maplibre-class-only-in-maplibre` | 7 / 3; 2 / 2 | 2c, 2d |
| F7 | Tile hosts, the Maps key | the `maplibre/` providers, the key from the settings slice | the Secrets tests (exist); CSP origin table | 1 / 1; key readers 2 | 2d, 2e |
| F8 | `pixi.js` | `canvas/runtime/renderers/` and the Pixi kit | `pixi-only-in-renderers` | 3 / 1 | 2a |
| F9 | Renderer module state | the scene runtime snapshot | `no-renderer-module-state` | listed in ADR 0024 | 2c |
| F10 | `localStorage`, `indexedDB` | the Draft-store, settings, stamp, species-list, Notebook and browser library adapters; the first-paint key | `web-storage-only-in-adapters` | 17 / 4 | 2b, 2e |
| F11 | `Intl.NumberFormat`, `toFixed`, currency symbols | `utils/format.ts` | `number-format-only-in-utils`, `no-currency-symbol-table` | 56 / 31 | 2a, 2c |
| F12 | `Intl.PluralRules` | `i18n/` | `i18n-completeness` (exists) | 0 | none |
| F13 | `new Date(str)`, `Date.parse`, date display | `app/timeline/civil-date.ts`, moving to `planning/civil-date.ts` in 2a through the layer table | `date-only-in-civil-date` | display 12 / 5; parse 38 / 12 | 1b |
| F14 | `navigator.clipboard` | `platform/clipboard.ts`, an adapter with no port | `clipboard-only-in-adapter` | 3 / 2 | 2a |
| F15 | `fetch` | the purpose owners (geocoder, map providers, species reader, PDF fonts) | `fetch-only-in-owners`; the CSP origin table | 5 / 5 | 2a, W1 |
| F16 | `new Worker` | the module that starts each worker | `worker-only-in-owner` | 0 outside | 2b |
| F17 | DraftId, OperationId, other ids | the Session core; the dispatcher, ToolHost commit and panel submit; `utils/ids.ts` | `ids-only-in-minters` | 12 / 4 | 1b, 2b |
| F18 | Search folds (`normalize('NFD')`, fold tables) | `platform/search-text.ts`: the one TS normaliser in 2a, over `canopi-search-text-wasm` from N4 | `search-fold-only-in-search-text` (NFC and non-search NFKD uses allow-listed) | 4 / 3, and 3 TS copies | 2a, N4 |
| F19 | Web Mercator formulas and constants | the constants and WGS84 radii in `canopi-types`, emitted by `bindings-gen`; the formulas in `geo/web-mercator.ts` and the Rust `crs` leaf | `no-webmercator-literal` | 2 implementations | 2a, N1 |
| F20 | Module-level `effect(` | `installAppLifetime` and the Design scope | `no-module-effect` | 8 / 7 | 2a, 2b |
| F21 | `sessionIdentity` reads | `core.onDesignOpened` | `no-session-identity-watch` | 88 / 30 | 2b |
| F22 | Hand-written request counters | `latest()` in the scope module | `no-hand-generation-guard` | 10 controllers | 2b |
| F23 | `console.*`, bare `catch`, window hooks | `failures/` `reportFailure` | `console-only-in-sink`, `bare-catch-names-reason` | 46 / 30; 72 | 1b, each moving stream (0 at Phase 3) |
| F24 | Redaction | `failures/redact.ts` | the redaction corpus | 2 redactors | 1b |
| F25 | Layout breakpoints | `app/shell/phone-layout.ts` (`data-layout`) | `no-shell-breakpoint-media-query` | 11 / 11 | 2a |
| F26 | Dialog filters, sanitisers, downloads | the FileDelivery rows and file-kind table | `file-delivery-rows`, `no-inline-dialog-filters` | 7 / 5; 5 sanitisers | 2a, N2 |
| F27 | Import extensions | the generated accepted-format list | `no-hard-coded-import-extension` | 1 / 1 | N3 |
| F28 | `.canopi` decode, encode, `CanopiFile` literals | `canopi-format` through the design-core port | `no-canopifile-literal`, `wasm-glue-only-in-adapter` | 4 TS mirrors | Step 2.0.4, 2b |
| F29 | The active tool and armed source | `_tool`, `tools.arm(id, source)`; one descriptor row per tool | the ToolHost owner test | 20 / 10, counted at 2c's start | 2c |
| F30 | Highlights | the canvas | `frontend-architecture-policies.test.ts` (exists) | 2 MapLibre overlay files | 2c, 2d |
| F31 | Settings-owned values | `app/settings/` signals through `patchSettings` | `settings-no-upward`, the `patchSettings` caller policy | 13 / 6 | 2e |
| F32 | `role`, `provenance` reads | the descriptor's lineage table | `no-lineage-field-read` | 44 / 12 | N3 |
| F33 | Zone shape decoding | the zone kernel | zone-decoder count | 22 | 2c |
| F34 | `keydown` listeners | `app/keyboard/key-router.ts`; focus-owned text entry | ADR 0020 tests (exist) | 2 / 2, both owners | none |
| F35 | Unit conversion constants and maths | the quantity table and `utils/format.ts` | `unit-maths-only-in-quantity-owner` | counted at 2c's start | 2c |
| F36 | Ground scale: Earth radii, latitude-based scale, zoom to pixels per metre, shown lengths and areas | the session plane in `geo/` (§20) | `scale-only-through-plane`; `PlanePoint` and `ConformalPoint` brands | counted at 2m's start | 2m |
| R1 | `tauri::`, `AppHandle` | `canopi-desktop` | `tauri-only-in-shell`; cargo-deny | 5 / 3 | N1 |
| R2 | `thread::spawn`, `spawn_blocking`, `rayon` | `blocking::run` in `canopi-support` | clippy `disallowed-methods`; `BLOCKING_ESCAPE_ALLOWLIST` (exist) | 0 outside | N1 |
| R3 | Executor calls in commands | facade methods with their `OpSpec` | `native_command_policy` | 81 / 10 | N1 |
| R4 | Library SQL, `rusqlite` | the `canopi-library` repository | `sql-only-in-repository` | 97 / 8; rusqlite outside the repository 41 | N1 |
| R5 | `format!` SQL, `value_*` columns | generated queries | `no-formatted-sql` in every crate; the drift test | 24 / 8 | N2, N4 |
| R6 | User DB SQL | `canopi-store` | cargo-deny: no catalog-store edge | 2 / 2 | N2 |
| R7 | `CanopiFile` decode and write | `canopi-format` | `canopi-decode-only-in-format`; cargo-deny | 0 | 2b |
| R8 | `fs::write`, `rename`, `copy` of a published path | `publish_durably` behind `DurableFs` (from 2b, 2.1-M28) | clippy `disallowed-methods` | 25 / 10 | 2b, N1 |
| R9 | `remove_file`, `remove_dir_all` | the janitor | `janitor-only-deletes` | 45 / 10 | N1, N2 |
| R10 | `sha2`, hashers | `canopi-support` hash | cargo-deny `wrappers` | 15 / 7 | N1 |
| R11 | `SystemTime::now` | `canopi-support` time | clippy `disallowed-methods` | 16 / 8 | N1 |
| R12 | `proj4rs`, EPSG codes | the `crs` leaf | `crs-only-in-crs` | 13 / 6 | N1 |
| R13 | `Result<_, String>` | the failure catalogue | `no-string-error-command`, widened to `From<String>` | 69 commands | 1a, 2b, 2e, N1, N2 (0 at Phase 3) |
| R14 | `"cancelled"`, `check_cancel`, flags | `CancelToken` | `no-cancelled-literal` | 13 / 7; 51 / 14 | 1a, N1 |
| R15 | `warn!`, `error!` | the failure logger | `tracing-warn-only-in-failure-logger` | 68 / 20 | 1a, each moving stream (0 at Phase 3) |
| R16 | `reqwest` and other clients | `http.rs`; `geocoder_fetch(url)` | `http-client-only-in-http` | 4 / 1 | N1, N2 |
| R17 | `Command::new` | the tool runner and `FolderRevealer` | clippy `disallowed-methods` | 0 outside | N0, N1 |
| R18 | Search folds | `canopi-search-text` | the shared corpus | 6 implementations | N4 |
| R19 | Locale lists, `sys_locale` | the `canopi-types` registry | the consistency test | 1 | 2a, 2e, N2 |
| R20 | `wasm_bindgen` | the `-wasm` crates, each created in its phase | cargo-deny | 0 | Step 2.0.4, N4, N5 |
| R21 | App data paths, `dirs::` | `app_folders`, the library paths, the Drafts directory | `no-path-string-command-arg` (§1): the generated command map carries no `path: string` except `UserPath` display fields | 36 / 10 | N2 |

## 19. Edition alignments

Every 2.0 difference that is not a row of ADR 0030 (the ED ids of the 2.0 inventory), with its shared behaviour, the ledger row that decided it and the step that builds it. Every row is decided (the last batch, 2.1-Q127 to 2.1-Q133, on 2026-10-17).

| Row | Shared behaviour on both editions | Ledger | Step |
|---|---|---|---|
| ED-02 | one record per Draft holding the core's `.canopi` bytes | 2.1-Q8, 2.1-Q33, 2.1-Q34 | 2b |
| ED-03 | at launch, reopen the last open Design (file or Draft); the start screen when there is none or it is gone | 2.1-Q127 | 2b |
| ED-04 | the start screen shows previews and Report a problem; Show in folder stays Desktop (ADR 0030) | 2.1-Q60, 2.1-Q104 | 2b |
| ED-05 | File › Open recent lists recent Designs, Drafts on Web | 2.1-Q111 | 2a |
| ED-06 | the Design Notebook, keyed by Design home | 2.1-Q111 | N2 |
| ED-07, ED-08 | the command palette on a new browser-safe chord and one keymap of browser-safe chords; Desktop keeps Ctrl+N, Ctrl+W, Ctrl+1-9 and Ctrl+Shift+P as aliases | 2.1-Q117, 2.1-Q132 | 2a |
| ED-11 | the leave prompt while the last write failed or a flush is pending | 2.1-Q22 | 1b |
| ED-12 | settings flush when the page hides, as Desktop flushes at close | 2.1-Q111 | 2e |
| ED-13 | Report a problem with Desktop's contents and redaction | 2.1-Q60 | 1b |
| ED-14 | a root error boundary and one per surface | 2.1-Q111 | 1b |
| ED-15 | one degraded-store notice | 2.1-Q67 | 1b |
| ED-16 | one in-app notice row, no native dialogs | 2.1-Q86 | 1b, 2a, N2 |
| ED-17 | the title bar's "Open a .canopi file" button | 2.1-Q128 | 2a |
| ED-18 | one responsive composition chosen by window size, so a narrow Desktop window gets the phone layout | 2.1-Q129 | 2a |
| ED-19 | Catalog and Favorites open without a Design | 2.1-Q130 | 2a |
| ED-20, ED-21 | the panel "Favorites and stamps" with saved stamps, holding only the user's picks; Recently viewed sits inside the Catalog | 2.1-Q112, 2.1-Q131 | N2 |
| ED-22 | Templates and the World map deleted | 2.1-Q24, 2.1-E5 | 2a |
| ED-24 | one generated settings decoder; a bad value resets only that field | 2.1-Q54 | 2e |
| ED-25 | one favourites and recently-viewed record shape with instants | 2.1-Q102, 2.1-Q103 | N2 (the Web record's shape frozen by Step 2.0.4) |
| ED-27 | Show my location on Desktop Linux and Windows, the host granting geolocation to the app origin only, under the Web trust rules and tests; macOS Desktop stays an ADR 0030 row | 2.1-Q146 | 2d |
| ED-30, ED-31, ED-32 | the full catalog, every filter and sort, one ranking contract | 2.1-Q113, 2.1-Q59, 2.1-Q43 to 2.1-Q51 | N4 |
| ED-33 | one Commons rendition; source links on both, Desktop opening them in the system browser | 2.1-Q109 | N4 |
| ED-34, ED-35 | common names, stratum colour and width on placement; the same stored plant data | 2.1-Q25, 2.1-Q113 | 2c |
| ED-36, ED-37 | Site data and the terrain analyses up to a measured limit; the analyses `web` branch deleted | 2.1-Q114, 2.1-Q65, 2.1-Q122, 2.1-Q24 | N5 (pending row until then); 2a deletes the branch |
| ED-38 | contours and relief | 2.1-Q25 | 2d |
| ED-40 | offline Web | 2.1-Q116 | W1 |
| ED-42 | `data-map-active` from the map-surface visibility | 2.1-Q26 | 2b |
| ED-43 | the same labels; behaviour-bound strings follow their row | 2.1-Q111 | the stream owning each string |
| PDF scales | architectural scales when the unit system is US customary; ratio scales on both systems | 2.1-Q133 | 2c |

## 20. Session plane and ground measure

ADR 0001 and ADR 0016 (2.1-Q78d). `geo/session-plane.ts` is the one owner of the Earth model; the WGS84 radii and the Web Mercator constants live in `canopi-types`, which `bindings-gen` emits to TS; `geo/session-plane.ts`, `geo/web-mercator.ts` and, from N1, the `crs` leaf's `web_mercator` read them (§18 F19, 2.1-M46).

```ts
type PlanePoint = Brand<{ x: number; y: number }, 'PlanePoint'>;          // ground metres, x east, y south
type ConformalPoint = Brand<{ x: number; y: number }, 'ConformalPoint'>;  // the camera's similarity frame
interface SessionPlane {
  readonly anchor: LonLat;                       // the objects' bounds centre, or the view centre
  readonly axisScale: { ax: number; ay: number }; // N0·cosφ0 and M0, per Mercator unit
  toPlane(p: LonLat): PlanePoint; toLonLat(p: PlanePoint): LonLat;
  toView(p: PlanePoint): ConformalPoint; fromView(p: ConformalPoint): PlanePoint;
  pixelsPerMetre(zoom: number): { x: number; y: number; mean: number };
  groundLength(a: PlanePoint, b: PlanePoint): Metres;          // the local factor applied, < 1 ppm on 10 km
  groundArea(ring: readonly PlanePoint[]): SquareMetres;
  trueNorthAt(p: PlanePoint): Radians;                         // plane north to true north, clockwise
}
```

- The plane is an exact affine image of Web Mercator; the view transform is the camera similarity on `ConformalPoint` composed with diag(1/ax, 1/ay). A frame change is a plane method; no other module multiplies by `cos(lat)`, takes a latitude to convert a zoom, or holds an Earth radius.
- Every length and area the user reads (chips, guides, PDF text, the profile length, a row's count from its spacing) is `groundLength` or `groundArea`, then `utils/format.ts`. A shape sized on the ground draws and hits through the affine; a mark sized in pixels uses pixels; `pixelsPerMetre(zoom).mean` serves sizes and tolerances only.
- `trueNorthAt` is the one owner of north on the plane (2.1-M91): 0 for this Mercator-based plane, whose meridians are straight, but every reader asks it, never assuming plane-up: the PDF page north arrows (2.1-Q151) and the sunlight release's solar azimuth. A raster's grid north in its own CRS (Lambert-93 for IGN) is the `crs` leaf's, never the plane's. 2m lands it; `scale-only-through-plane` also fails on a north derived outside it.
- Re-origin builds a new plane with its own factor; objects re-hydrate from lon/lat, and the 1e-9° write-back rounding stays idempotent.
- Fixtures build their view through the real plane or name `conformalFixturePlane` explicitly; none assumes a similarity at latitude 0.
- Tests: a stored lon/lat lands on MapLibre's pixel to 1e-6 px at 0°, 49° and 65°; `groundLength` and `groundArea` against a WGS84 Vincenty reference within 1 ppm over a 10 km site; a rotated 100 m square at 49° keeps its sides to 1 cm and its corners to 5″; re-origin idempotence; `scale-only-through-plane` fails on a planted `cos(lat)` scale.

## 21. Object capability matrix

2.1-Q147, 2.1-M86. `app/command-table/object-capabilities.ts` (L2, beside the command descriptors; it imports no feature, ADR 0022) holds the matrix as data; the audit's 28 kinds by 57 capabilities seed it (gate-logs `capability-matrix.md`).

```ts
type ObjectKind = (typeof OBJECT_KINDS)[number]['id'];      // plant, zone-rect, …, pdf-page-furniture
type Capability = (typeof CAPABILITIES)[number]['id'];      // select, move, edit-by-values, …
type Cell =
  | { state: 'yes'; via: readonly CommandOrToolId[] }
  | { state: 'partial' | 'no'; gap: BeadId }
  | { state: 'partial' | 'no'; decision: LedgerOrAdrId }    // a deliberate exception
  | { state: 'n/a'; reason: string };
// OBJECT_KINDS: id, authority (Scene, Document, library, settings, print setup, personal library),
// backing (a DESIGN_FILE_FIELDS key, a SceneDesignObjectTarget kind, a PDF page kind or a store).
const CAPABILITY_MATRIX = { /* … */ } satisfies Record<ObjectKind, Record<Capability, Cell>>;
```

- Each stream edits its kinds' rows in the change that alters a capability; a fill turns a `gap` cell into `yes` in the same change.
- Tests, one policy family in F1's inventory:
  - Exhaustive: `satisfies` fails `tsc` on a missing cell; a unit test maps every `DESIGN_FILE_FIELDS` entry, `SceneDesignObjectTarget` kind and PDF page kind to a row or a named non-kind list, so a new field or union member fails until it has a row.
  - Backing: each `yes` names a command or tool whose real availability query is enabled for a fixture selection of that kind on each edition root, and each `no` is disabled (this catches 2.1-Q150's Web Save as stamp).
  - Behaviour: table-driven suites (copy and paste round trip, undo restore, stamp round trip, print inclusion) run through the real runtime for every kind marked `yes` (ADR 0028, public surfaces).
  - Reasons: each `gap` is an open bead in `.beads/issues.jsonl`; each `decision` is an id in `docs/decisions/2-1.md` or an ADR.
  - Ratchet: the `gap` cells are a named per-entry ratchet in `policy/ratchets/` (§12), so a new hole fails until it is filled or decided, and a filled one leaves the list.
