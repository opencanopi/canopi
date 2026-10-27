# Design document

Covers: `common-types/src/design.rs`, `common-types/src/settings.rs`, `desktop/src/design/`, `desktop/src/services/design_files.rs`, `desktop/src/services/settings.rs`, `desktop/web/src/app/design-edit/`, `desktop/web/src/app/document-session/`, `desktop/web/src/app/design-drafts/`, `desktop/web/src/app/settings/`, `desktop/web/src/app/saved-views/`, `desktop/web/src/app/stories/`

## Purpose

The `.canopi` file, the Design session (open, continuous save, replacement, close) and device settings. Why: [ADR 0001](../adr/0001-geolocated-map-canvas.md), [ADR 0021](../adr/0021-canopi-2-breaks-stored-data.md), [ADR 0005](../adr/0005-web-edition-scope.md), [ADR 0007](../adr/0007-design-objects-and-personal-libraries.md), [ADR 0009](../adr/0009-continuous-save.md), [ADR 0011](../adr/0011-analyses-provenance-and-stories.md). Frontend paths are relative to `desktop/web/src/`; each rule names its test.

## Authorities and boundaries

- **Scene runtime** (`SceneStore` behind `SceneCanvasRuntime`) owns plants, zones, annotations, measurement guides, groups, locks, Design layers and the per-species colour, symbol and code maps. It changes only through runtime transactions; panels read it through `CanvasQuerySurface`. Every write carries the live view as `map_view`; Save always writes, a pan never does (U28, U30; `design-map-view.test.ts`).
- **Design Edit** (`app/design-edit/`) owns `name`, `description`, `budget`, `budget_currency`, `timeline`, `consortiums`, `lidar` entries, `views`, `stories`, `created_at`, `extra.plant_display` and unknown root keys under `extra`: all of `extra`. Nothing else writes them; its key names live in `app/design-edit/extra-keys.ts` and go through `readExtra`/`withExtra`.
- **Settings** (`common-types/src/settings.rs`) own device state: locale, theme, map layers, `soften_background`, `scroll_wheel`, the Google key and `satellite_source`, `last_view` (centre and zoom), snapping, tool-rail learning, single-key shortcuts and New Design defaults. A setting never travels with a file; a Design field never depends on the device.
- **Undo** covers Scene edits only. Design Edit commands, map layers and settings are not undoable.
- **Coordinates.** The file stores WGS84 `GeoPoint { lon, lat }` for every position, and zone and note rotation in degrees clockwise from true north. Metres exist only in the session plane (`canvas/session-plane.ts`); camera moves, turning the view included, never move objects or change a stored rotation ([ADR 0015](../adr/0015-rotating-map-and-canvas-controls.md)).
- **Trust boundaries.** Native: `desktop/src/design/format.rs`. Web: `app/contracts/design-ingestion.ts`. Nothing else casts raw JSON to `CanopiFile`; `canopi-design-wire.ts` is the only serializer.
- **Persistence.** Every write goes through `app/document-session/persistence.ts`; only a successful write to the session's home (file or Draft) acknowledges the captured baseline. Downloads, handoffs and Problem Report attachments are exports.

## Rules

- Only version 9 (`CURRENT_CANOPI_FILE_VERSION`) opens. Any other version, or none, fails with `unsupported_version` before the active Design changes, and the file is never written. (conformance corpus)
- The typed `DesignLoadFailure` makes versions 1 to 8 read as made before 2.0 (`start.cantReadOlderVersion`), never as damaged, and every open path tells the user through `document-session/open-failure.ts`. (`canopi-design-decoder.test.ts`, `design-open-failure.test.ts`)
- `DESIGN_FILE_FIELDS` names every root field and its owner (a new one also gets conformance cases); `known-canopi-keys.ts` and `composeDocumentForSave()` (`app/contracts/document.ts`) derive from it. (`bindings-gen` fails on divergence; `npm run check:types`)
- A root `extra` key is refused as `invalid_document`; any other unknown root key (1.x's `location` or `spatial_frame` included) is carried: in memory unknown roots live under `CanopiFile.extra`, and the encoder spreads them first so known fields win. Plant, zone, annotation, guide and group ids are required, unique and non-empty; nothing invents a missing one. (conformance corpus)
- Files over `MAX_CANOPI_FILE_BYTES` (64 MiB) are refused before parsing; GeoJSON shares the limit. (`format.rs` tests)
- Positions write rounded to 1e-9 degree, latitude clamped to ±85.051128779, longitude clamped to ±180 on save only (re-origin keeps it unclamped) (`canvas/runtime/scene/geo-frame.ts`); an unedited one never drifts. (`geolocated-design-codec.test.ts`)
- A zone's `id` (`zone-<uuid>`) is its identity; `name` is display only and nullable. Targets, groups and view highlights reference the id, so renaming is a Scene edit. (`file-format-round-trip.test.ts`, `canvas-context-menu-entries.test.ts`)
- `map_view` passes `validate_map_view` with the saved-view camera rules; views and stories pass `validate_views_and_stories` (`common-types/src/views.rs`; mirror `app/contracts/views-admission.ts`): unique ids, camera in range, a required ground size (`camera.ground_size_m`) finite, above 0 and at most 1e8 m (capture clamps each side; a map with no size saves no view), steps naming an existing view, `https:`/`http:`/`mailto:` links, embedded PNG/JPEG/WebP/GIF images at most 1 MiB each and 10 MiB per Design; rich text is a block list, never HTML. (conformance corpus, `story-rich-text.test.ts`)
- Deleting a view deletes the steps that show it and returns a `SavedViewDeletion` that `restoreSavedView` puts back; a story or step Undo that meets a missing view parks the step until that view's Undo; no step dangles. (`design-edit-views.test.ts`, `design-edit-stories.test.ts`)
- Non-canvas Design writers import Design Edit only through `app/design-edit/index.ts`. (`design-edit-authority-only-in-core`, `lidar-design-edit-only-in-lidar-actions`)
- A Design Edit command computes its update first, installs committed state, then publishes (`design-edit-authority.test.ts`); a no-op compares fields and does not dirty (`design-edit-views.test.ts`, `design-edit-stories.test.ts`, `plant-display.test.ts`).
- `extra.plant_display` is Design data (travels with the file, not undoable); Soften background is a device setting. Readers repair invalid values and report it once (`design-edit:extra` diagnostic), and nothing rewrites a plant or species colour. A saved view stores the labels it showed in `views[].labels` (`none`, `codes`, `names` or null for the Design's), the enum settings and `plant_display` use; `extra.saved_view_display` is no longer read. (`plant-display.test.ts`, `design-edit-extra.test.ts`)
- An open Design shows in the frame its first scene is drawn (`presented`; at once if the map or canvas failed). Until then its chrome, also outside the canvas (`data-design-chrome`), is transparent and inert so autofocus holds; the start screen covers the wait only for one opened from it. Once shown it stays until closed. (`design-reveal.spec.ts`)
- Placed in that render inside its chrome, it opens at its saved view (`map_view`, saved-view rule), else on the fit at the live bearing (north up on the runtime's first open); new and empty Designs open north up. (`design-map-view.test.ts`, `scene-runtime.test.ts`)
- Every replacement first flushes the current Design to its home (`dirtyGuard: "flush"`); the only dialog is Retry / Discard / Cancel after a failed write; no unsaved-changes prompt. (`document-session-transition.test.ts`)
- Only `attach()` and `replace()` (`app/document-session/replacement.ts`) load the runtime document; a transition captures a replacement guard and cancels if anything changed underneath. (`design-session-replacement.test.ts`)
- Continuous save restarts a 1500 ms timer per committed change, coalesces writes and flushes on blur, hide, `pagehide`, replacement and close. (`continuous-save.test.ts`, `web-design-session.test.ts`)
- Dirty means "not yet written to the home": the canvas compares `SceneHistory` state identities, never depth; `persistenceDiverged` keeps a Design dirty when a write captured an older snapshot; nobody writes `designDirty` directly. (`dirty-state.test.ts`, `scene-history-checkpoint.test.ts`)
- A file write carries the SHA-256 fingerprint it expects (`desktop/src/services/design_files.rs`); a mismatch returns `Conflict` and pauses continuous save until the user chooses Keep mine, Use the file's version or Save a copy. `null` overwrites (Save As). (`design_files.rs` tests, `continuous-save.test.ts`)
- Native writes are durable: `write_file_durably()` (`desktop/src/design/mod.rs`) for Designs, Drafts and derived output. (`design/mod.rs` tests)
- A dialog answer applies only to the session that asked: capture `continuousSave.sessionToken()` first. (`continuous-save.test.ts`)
- Desktop Drafts live in `{app_data}/drafts/<id>.canopi`, ids `[a-z0-9-]{1,64}`; Web homes are browser Drafts (`web/browser-app-data.ts`), decoded one by one so a corrupt Draft discards nothing else. Older Drafts, like the 1.x autosave store and Web document, stay where they are, unread and unlisted (ADR 0021); only the 1.x data is told, once. (`drafts.rs` tests, `browser-app-data.test.ts`)
- An unparseable settings record is set aside under `settings.set-aside` and replaced by defaults; unknown keys are ignored, never re-emitted; the log names a position, never the record. (`services/settings.rs` tests)
- Settings mutate through `mutateSettingsProjection()`; 60 fps paths commit at gesture end; await `flushSettingsProjection()` when durability gates a transition. (`settings-projection.test.ts`)
- New Design defaults apply once at creation (`app/settings/new-design-defaults.ts`), never to an opened Design. (`document-actions.test.ts`)
- GeoJSON is a derived exchange format: `app/geojson/codec.ts` is pure; export reads settled lon/lat; import decodes the whole file before one undoable `importDesignObjects()` placement with fresh ids. (`geojson-*.test.ts`)
- Stamp export writes a current-version `.canopi` of the visible objects. A stamp payload is version 2 (`canvas/saved-object-stamp-payload.ts`); any other version is refused. (`saved-object-stamp-file.test.ts`, `saved-object-stamp-source.test.ts`)

## Do not

- Read or convert an older stored format anywhere, including inside `Deserialize` (ADR 0021).
- Write a Design field from a component, workbench or raw `store.ts` signal.
- Persist a runtime metre, a plane origin or a Design-level bearing. Only view cameras carry a bearing: `views[].camera.bearing` and `map_view.bearing` in the Design.
- Infer a canvas replacement from `currentDesign` changing.
- Read `updated_at` or `map_view` into a replacement guard: one is generated, the other is only the view. (`design-map-view.test.ts`)

## Where to look

| Area | Module | Tests |
|---|---|---|
| Format, owners, limits | `common-types/src/design.rs`, `views.rs`, `lidar.rs` | `common-types/canopi-design-conformance.json`, `desktop/src/design/format.rs` |
| Web admission and wire | `app/contracts/` | `canopi-design-*`, `file-format-round-trip` |
| Geo rounding, re-origin | `canvas/runtime/scene/geo-frame.ts`, `scene-runtime/reorigin.ts` | `reorigin.test.ts`, `geolocated-design-codec` |
| Design Edit | `app/design-edit/` | `design-edit-*`, the `design-edit-authority-*` policy rules |
| Views, stories, images | `app/saved-views/`, `app/stories/` | `saved-views*`, `story-*` |
| Session, save, replacement | `app/document-session/` | `continuous-save*`, `document-session-*`, `design-session-*` |
| Web session | `web/browser-design-session.ts`, `web/browser-app-data.ts` | `web-design-session`, `web-canvas-workspace` |
| Native files, Drafts, previews | `desktop/src/design/`, `services/design_files.rs`, `recent_design_previews.rs` | inline tests |
| GeoJSON | `app/geojson/` | `geojson-*` |
| Settings | `common-types/src/settings.rs`, `app/settings/` | `settings-*` |
