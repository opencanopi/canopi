# Rust crates and native layering

Status: Accepted (2026-10-16, Canopi 2.1 target; built by the 2.1 foundation phases); amended 2026-10-17 (Q34 format core, Q37 engine procedure, Q47 fault seam, Q45 pass; the job-runner prototype and the module-map run: ledger 2.1-M4, 2.1-M5, 2.1-Q65, 2.1-Q79, 2.1-Q122); amended 2026-10-17 (the reader release: 2.1-Q138, 2.1-M21; the readiness review: 2.1-M44, 2.1-M46)

## Context

In 2.0 almost all native code is one Tauri crate. LiDAR is 57% of production code and depends on Tauri. Plant search calls user-DB favourites, so catalog depends on store; `design_files` names a desktop folder revealer, so store depends on desktop. Commands name an executor class 81 times and run LiDAR workflows themselves. The `.canopi` rules exist in Rust and in TS. The module-map run found 2 production SCCs, 14 LiDAR back-edge pairs and 29 sites of LiDAR extensions importing each other. The user chose the crates (2.1-Q9), an item-kind owner now (2.1-Q10) and one `.canopi` core (2.1-Q34).

## Decision

- **Twelve crates, leaf first.**
  - `canopi-types` (renamed `common-types`): shared shapes and `DESIGN_FILE_FIELDS`, the failure catalogue (ADR 0025), the settings field table, the quantity table, the TS-facing command map (no `OpSpec`, which lives with each facade).
  - `canopi-format`: a leaf over `canopi-types` owning stored user work (ADR 0026): `.canopi` read checks, the frozen chain, the writer with admission, the wire conversion, the one new-Design builder, typed refusals, the spec emitter, the Draft content rules and the saved-stamp payload chain. It replaces `desktop/src/design/format.rs`; no tauri, tokio, sqlite or wasm-bindgen.
  - `canopi-search-text`: the one implementation of search normalisation (ADR 0027), with a key CLI for the catalog build. `canopi-format-wasm` (its read half in Step 2.0.4, the whole core in Phase 2b), `canopi-search-text-wasm` (Phase 3 N4) and `canopi-library-wasm` (Phase 3 N5, 2.1-Q122: the library's leaves and engines for the Web terrain worker) are thin exports, each loaded by one adapter (ADR 0022).
  - `bindings-gen`: emits TS from `canopi-types`; never depends on Tauri.
  - `canopi-support`: the executor, durable files, hash, time, `acquire`, `move_aside`, the store migration runner and the one private `blocking::run`. Durable files sit behind a `DurableFs` seam with a fault implementation (kill after any step, disk full, read-only, rename failure, 2.1-Q47); `publish_durably(bytes or staged, target, role)` is the only way a Design, export, store, image-cache or library file is published.
  - `canopi-library` (renamed from the planned `canopi-lidar` at the crate split, 2.1-M4): the Data library, with no Tauri. `canopi-catalog`: the plant DB and search. `canopi-store`: the user DB, settings record, favourites, recently viewed, saved stamps, Recent Designs, the notebook, Design files and Drafts. `canopi-desktop`: the Tauri shell, commands, host and composition. Crown detection adds `canopi-vegetation`, a pure-algorithm leaf called by `canopi-library`'s crown extension (L3).
- **No edge between catalog and store.** Favourites and recently viewed are user data in `canopi-store`; `canopi-catalog` takes a set of names and returns projections; `canopi-desktop` composes the two. `design_files` returns the checked folder and the command reveals it, so `FolderRevealer` stays in `canopi-desktop`.
- **Commands are one-line adapters.** Each service crate exposes async facade methods, such as `library.delete_item(id).await`, each declaring its lane, priority and deadline once as its `OpSpec` constant (ADR 0025). Command bodies make no executor call; a bounded synchronous flag signal is allowed. One `commands!` table expands each entry into its wrapper, its `CommandRow` and the handler list.
- **Tokio is a per-crate rule.** `canopi-support` and `canopi-library` take tokio `rt` (the runner is given a `tokio::runtime::Handle` when it is attached; tests pass their own); `canopi-desktop` keeps sync and time. There is no spawner trait. Blocking work runs only through `blocking::run` (ADR 0025).
- **Library internal order:** leaves (grid, `crs`, `kinds`, `lineage`, test hooks) < engines < repository < extensions < jobs < facade.
  - Leaves and engines build for `wasm32-unknown-unknown`, with no tokio, sqlite or `std::fs`: a default `native` feature gates the repository, extensions, jobs, facade, threads and the tokio and SQLite dependencies, and `canopi-library-wasm` takes `canopi-library` without it, so the Web terrain worker (2.1-Q65) runs the same engine; raster input arrives as bytes or a reader trait, never a path. The repository, extensions, jobs and facade keep tokio and SQLite.
  - `crs` is the one CRS authority (ADR 0014): transforms on `proj4rs` over the table's rows and reads wbgeotiff GeoKeys; no other module names a projection crate. `lineage` is one field per item: `Source`, `Analysis{provenance}` or `External{tool, date, notes, links}`, replacing `LibraryItemRole` and `provenance` in catalogue step v25 -> v26; out of date and Refresh exist only for `Analysis`, and the Design keeps its `role` literal, written from lineage, so `.canopi` does not change.
  - Repository: the catalogue, all SQL, the kind-aware decoder, store open and migrations. Its row structs carry domain types and refuse a corrupt row with a typed failure.
  - Extensions: one module plus a registry row per analysis and importer (ADR 0027), display preparation, sampling, generation and coverage. **No extension imports another**; a piece two need moves down to a leaf or an engine. Each module is assigned to one layer in `module_layering.rs`.
  - Jobs: the runner and the janitor (ADR 0024). The runner matches the job kind exhaustively and calls the extension's work function; no extension names the runner; the facade hands display preparation to the display slot. Runner state lives in `jobs.rs`. Modules import by their defining path, not through `lib.rs` re-exports.
- **The item kind has one owner now** (2.1-Q10): the closed enum `LibraryItemKind`, its `literal()` and `ALL` live in `canopi-types`, which `bindings-gen` emits from; the `kinds.rs` leaf owns its decode and the exhaustive matches over it (2.1-M46).
  - The repository's one kind-aware decoder replaces the readers that assume a raster; extensions match on the kind exhaustively, so the compiler lists what a new variant fills. Recovery refuses an unknown kind. The kinds are shaped for point clouds that are seen and profiled (display by class, height or intensity; a profile through them; 2.1-Q79), and the `Vector` variant comes in 2.1 with bring-your-own vectors (2.1-Q100); hydrology's vector outputs reuse it.
- **The global-lane engine (L22) is open** (2.1-Q37). At Phase 3's start a GeoLibre-first design check prototypes the in-process whitebox crates and the GeoLibre CLI sidecar on the 25 M-cell cap (job model, cancellation, memory, packaging, reuse for crowns and `wblidar`, and running single-threaded in a wasm worker for the Web terrain analyses, 2.1-Q65, which a sidecar cannot); this ADR then records the winner and its one pin (`desktop/binaries/geolibre.pin` for the sidecar, `Cargo.lock` for the crates).
  - The same check decides the windowed terrain engine (slope, aspect, frost pockets), which must also run in the Web worker (2.1-Q65), so only in-process crates qualify; N1 moves Desktop's windowed slope onto it and adds aspect and frost pockets on it (2.1-M44), and N5 runs it as wasm.
- **Tests.** Behaviour tests run against the facade inside each service crate; no `test-hooks` feature exists. `canopi-desktop` keeps the generated command-map contract test, which checks that each command's facade declares an `OpSpec` and that a job facade returns a `JobId`.
- **A crate step's exit is structural.** Build times are information; a slowdown becomes a performance bead, not a reason to undo a crate.

## Alternatives rejected

- **Catalog and store inside `canopi-desktop`.** Keeps the edges that make both untestable alone.
- **The `.canopi` core as a cfg'd module of `canopi-desktop`.** tao, wry, tokio fs, ring and sqlite do not build for wasm32.
- **A one-method `TaskSpawner` trait.** One real implementation behind two wrappers.
- **Jobs below extensions.** The runner calls the work, so that edge pointed up the order (job-runner prototype).
- **A build-time threshold per crate step.** It lets speed reopen a structure the user decided.

## Consequences

- A mutant in a Tauri-free `canopi-library` rebuilds and tests only that crate (ADR 0028).
- `native_command_policy`, `module_layering`, `ci_lane_policy` and the coverage configuration change with each crate move; the `lidar-native` CI job and the AGENTS.md gate row take the new name.

## Checks

- cargo-deny (to be created by Phase 0; bans by Phase 3): Tauri only in `canopi-desktop`; tauri, tokio and sqlite never under `canopi-format`; wasm-bindgen only in the `-wasm` crates (one from Step 2.0.4, then N4's and N5's from Phase 3 in either order, 2.1-Q122); only `canopi-desktop` depends on both catalog and store; `sha2` only in `canopi-support` (wrappers). `cargo tree -p bindings-gen -i tauri` is empty.
- `cargo check --target wasm32-unknown-unknown -p canopi-library --no-default-features` (the leaves and engines) in CI (to be created by Phase 3 N1).
- Rust SCC count 0 (`rust-scc` ratchet, Phase 0); `module_layering.rs` (exists), narrowed to the library order with the module-to-layer list and no extension-to-extension edge (Phase 3 N1).
- ast-grep (Phase 0, as ratchets): `tauri-only-in-shell`, `sql-only-in-repository`, `no-formatted-sql` (every crate), `canopi-decode-only-in-format`, `tracing-warn-only-in-failure-logger`, `http-client-only-in-http`; `crs-only-in-crs` (ratchet from Phase 0, 0 at Phase 3, then replacing the projection-crate test in `crs.rs`, which exists).
- clippy `disallowed-methods` (exists; Phase 3 N1 widens it): no `std::fs::rename` or `write` of a published path, no `SystemTime::now`, no `Command::new` outside the tool runner and `FolderRevealer`, no blocking call outside `blocking::run`.
- `native_command_policy::tests` (exists) gains "no executor call in a command body".
