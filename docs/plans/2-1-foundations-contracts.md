# Canopi 2.1 foundations: contracts

Status: Agreed 2026-10-16, amended 2026-10-17 (the answers to 2.1-Q133, Q78d, E1 to E7 and M1 to M19 in the [decision ledger](../decisions/2-1.md); the Session-core, canvas-map, settings, job-runner and true-metres prototypes; the order review, 2.1-Q137, 2.1-Q138, 2.1-M20 to 2.1-M22; the blocker review, 2.1-M28 to 2.1-M34), amended 2026-10-19 (the capability audit and scope additions, 2.1-Q147 to 2.1-Q160, 2.1-M86 to 2.1-M94),
amended 2026-10-20 (the architecture-model review, 2.1-Q163 to 2.1-Q173, 2.1-M96 to 2.1-M150) (canopi-f47t.52); to be deleted when built. Each contract then lives in its code, module comment and test.
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
    pub stream: Option<TypeRef>,        // the Channel<T> argument's item type, for a streaming command
}
// canopi-desktop: one `commands!` table; each entry expands into a private
// #[tauri::command] wrapper in the module that calls generate_handler!, the handler
// list, and const assertions: entries equal the CommandRow set (a panic names the
// missing command) and each sync kind matches (2.1-M153). build.rs builds the ACL
// manifest from ALL. Rows name types by bare ident; no custom dispatcher.
// canopi-support, beside the executor; Lane is in canopi-types because busy{lane} carries it
pub struct OpSpec { pub lane: Lane, pub priority: Priority, pub deadline: Deadline }
// Deadline::Unbounded only for system work: runner transitions, the janitor, recovery, the reserved settings boot read
```

- The row faces TS only; TS never needs `OpSpec`. Phase 2a builds the map with the generated `invoke<K>` typing. `bindings-gen` takes its TS roots from the rows' args and reply types plus the failure catalogue and `CanopiFile`; the hand `.register` list in `contracts.rs` is deleted, and the name test stays as a backstop.
- "Reviewed" means the row's non-empty `reason`. `SYNC_COMMAND_ALLOWLIST` is deleted; `ESCAPE_ENTRY_POINTS` (the floor that stops `clippy.toml` shrinking) and the reason pin in `BLOCKING_ESCAPE_ALLOWLIST` stay.
- Every invoke carries the action's `OperationId` (ADR 0025). The generated TS command map is written under `src/ipc/`, so the CI change filter's invoke paths are one entry, held to the ast-grep rule by a `ci_lane_policy.rs` test.
- No command takes a raw path: a native dialog returns an opaque grant (ADR 0027), and stored entries carry an id.
- A facade operation declares its `OpSpec` once, as a constant beside the method in its service crate (ADR 0023); nothing restates it. From Phase 3 N1, `canopi-desktop`'s command-map contract test checks that each registered command's facade method declares one and that a job facade returns a `JobId` (it writes its Queued row through an ordinary Library-lane `OpSpec`). There is no retry column (ADR 0025).
  - A command may instead adapt a method of the one composition facade `canopi-desktop::compose`, which awaits only service facade methods (each with its `OpSpec`) and the `FolderRevealer`, declares no `OpSpec`, holds no SQL and makes no executor call.
  - The N1 contract test checks that each command resolves to a facade method with an `OpSpec` or to a compose method whose callees all have one, and `native_command_policy` covers `compose`.
- TS gets `CommandMap` (name to args, reply and failures) and one `invoke<K>(name, args, operation: OperationId): Promise<Result<Reply<K>, Failure>>` (a missing operation is a type error) in `ipc/`. No other module calls the Tauri `invoke`.
- Checks: the `commands!` const assertions (2.1-M153); bindings-gen checks each row's `ts_name` against specta's runtime name; `native_command_policy` (every synchronous command has a `BoundedSync` row with a reason and the reverse, no executor call in a command body); ast-grep `invoke-only-in-ipc` (with a planted invoke outside `ipc/`) and `no-path-string-command-arg`. A `Channel` argument appears only where the row declares `stream` (a case of the const assertions); the updater's progress and the library subscription are its users.

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
| native services | `plant_db_unavailable{cause}` (deleted with the SQLite reader under 2.1-E1 outcome A), `user_data_unavailable`, `library_read_only{reason}`, `not_found{what}`, `conflict{what}` (`conflict{what: name, suggestion}` for a Data library name clash), `import_refused{refusal}`, `design_load{kind}`, `param_invalid{key, code: ParamError}` (`ParamError` in `canopi-types`: Required, NotAnOption, Integer, Range{min, max}, Step{step, nearest}, WrongType; a malformed request settles `invalid`), `io{kind}`, `network{kind}`, `invalid`, `internal` |
| DesignHomeStore: Draft records | `draft_absent`, `draft_unreadable`, `conflict` (shared with file homes), `storage_unavailable`, `draft_store_newer` (the one "New version: Reload" notice, 2.1-Q83), `draft_store_blocked` ("Close other Canopi tabs to continue") |
| browser stores (Web) | `quota_refused{store: drafts, stamps, notebook, species_lists, settings, library}` (one notice; the write is refused whole), `stamp_too_large{limit}` (Export stamp offered, 2.1-Q173) |
| catalog reader (Web) | `catalog_unavailable{cause}`, `catalog_query_failed` |
| Data library (Web library worker, N5) | `over_web_limit{limit}` ("Needs Canopi Desktop" with the limit); `library_storage_unavailable` (no OPFS, as in WebKit private browsing; user_may_retry false, 2.1-M151); `library_held_elsewhere` ("Use here", 2.1-Q171); quota is `quota_refused{store: library}` |
| map | `map_unavailable`, `webgl2_unavailable` (user_may_retry false), `style_failed`, `tile_source_failed{layer}` |
| format core (worker adapter, both editions) | `format_core_unavailable` (the `.wasm` failed to load or instantiate), `format_core_trapped` (`detail`: the panic message or `trapped`) (ADR 0025) |
| byte transport (Desktop IPC) | `ipc_body_not_raw` (a JSON body where bytes are due); `io{kind: too_large}` above 64 MiB, refused by `ipc/bytes.ts` before `invoke` (2.1-M154) |
| updater (Desktop host, F6) | `update_signature_refused` (also a signed version that is not newer, 2.1-M64), `update_no_channel_entry{os, arch, bundle}`, `update_admin_prompt_unavailable` (no pkexec: About shows the download link, 2.1-Q232), `update_admin_prompt_dismissed` (pkexec exit 126), `update_admin_prompt_refused` (pkexec exit 127, not authorised), `update_location_not_writable`, `update_install_failed{bundle}` (2.1-M210); a payload over its cap is `network{too_large}`; a failed check or download reuses `network{kind}` and `io{kind}` with op `updater.check` or `updater.download` |

- On the wire a code is tagged by `kind`, and a code's own sub-kind sits under its code's name: `{kind: "io", io: <io kind>}`, `{kind: "network", network: <network kind>}`, `{kind: "busy", lane}`. `io` kinds: not_found, permission_denied, read_only, no_space, too_large, other. `network` kinds: timeout, offline, status, host_not_allowed, too_large. `plant_db_unavailable.cause`: missing, open_failed, schema_mismatch, fingerprint_mismatch. `design_load.kind` includes `migration_failed{from}`, for files, Drafts and stamp files (§10) and saved-stamp payloads (§11).
- The list above is the starting set. Adding a code is the L14 change: one catalogue row, one locale key in all 11 locales or `silent`.
- `detail` is `RedactedText`, made by the language that produced the text (ADR 0025), and is never shown. `SubsystemHealth[plant_catalog]` carries the catalog's cause, and a library not ready carries `library_read_only{reason}`; one presentation module maps each status to its tone and message (`every_health_status_has_one_message`). `user_may_retry` only lets the screen offer Retry.
- Checks: `every_code_has_a_message_or_is_silent`; `every_code_reaches_the_report`; fixtures `canopi-types/fixtures/failures/<code>.json` read by Rust and TS; ast-grep `no-string-error-command`, `no-cancelled-literal`, `console-only-in-sink`.
- A rejected invoke is one ring entry per settlement; `reportFailure` given a failure whose settlement already has an entry marks it surfaced and adds the notice outcome, never a second entry. Tests (`ipc/transport.test.ts`): a rejected invoke then passed to `reportFailure` leaves one entry; two rejected invokes in one action leave two entries with the same `OperationId`.

## 3. Native scheduling

The executor in `canopi-support` owns the request lanes and the Job lane, `OpSpec`, `CancelToken`, priority, deadlines, settlement logging and the private `blocking::run`; it owns no slot primitive and never names a job. A request is `run(op: OpSpec, token: CancelToken, work) -> Result<T, Failure>`.

The job runner in `canopi-library` owns the heavy and display slots on the Job lane: `enum Slot { Heavy, Display }` with `const _: () = assert!(Slot::ALL.len() == lanes::JOB.workers);`, the FIFO of Queued rows and per-key display coalescing; it takes a slot permit, moves the row to running through a Library-lane system request, then calls `executor.run(OpSpec{lane: Job, ..}, token, work)`.

| Lane | Protects | Workers | Queue bound | Interactive deadline |
|---|---|---|---|---|
| Catalog | the plant DB | data | data | data |
| UserData | `user.db` | data | data | data |
| Library | catalogue row transactions | data | data | data |
| Local | user files, raster reads, header probes | data | data | data |
| Network | HTTP | data | data | data |
| Job | heavy LiDAR work and display preparation, admitted by the job runner's slots | 2 (`inner_parallelism`: all cores, below-normal priority, for heavy engines) | 2 | none (`Deadline::Unbounded`, background) |

Every lane is a bounded queue; a lane-table test checks that the sum of workers plus the reserved settings boot read fits the `blocking::run` pool. A Job `run` on a full queue cannot happen while the slots gate it; if it does it settles `internal` (`job_lane_oversubscribed`) with a debug assertion, never Busy. The values are data in one lane table. Starting deadlines are the 2.0 slow budgets (Catalog and UserData 2 s, Local 10 s, Network the HTTP timeouts).

- **Priority.** Interactive before background within a lane; FIFO within a priority.
- **Deadline.** Measured from enqueue to start. A request not started by its deadline settles `busy{lane}` and its work never runs. Started work runs to completion or cancel; running past its slow budget logs `warn` with `running_ms`.
- **Queue bound.** A back-pressure guard: an enqueue onto a full queue waits until a slot frees or its deadline passes. At the deadline it settles `busy{lane}` (logged `warn` with `queue_full`), so Busy still comes only on deadline expiry. The bound is sized so expected load never reaches it.
- **Cancel.** A `CancelToken` carries its reason (User, Superseded or Shutdown). It is cancelled by `cancel(operation: OperationId)`, one BoundedSync command for an explicit user cancel (for a job it maps to its `JobId`); by `OpSpec`'s optional `supersede_key`, where a new request with the same key cancels the earlier token as Superseded, which settles `cancelled` silently; or by drain, as Shutdown.
  - The drop guard on the command future stays only as a backstop for a runtime abort. `CancelToken::on_cancel(hook)` registers an engine interrupt (rusqlite `InterruptHandle` today, the DuckDB interrupt under 2.1-E1), run once on cancel.
  - Cancelled before start: the work never runs. Cancelled while running: the work sees it at its next check or through its hook. On Desktop a geocoder `AbortSignal` only discards the result.
- **Updater.** `canopi-desktop/src/host/updater/` is the only module naming `tauri_plugin_updater` (ast-grep `updater-plugin-only-in-updater`; cargo-deny allows the plugin only in `canopi-desktop`). Updater state allows one op at a time; a second check awaits the running one's result and a second download call joins the running download.
  - Facade: `check(token) -> Result<Option<UpdateOffer>, Failure>` and `download(offer, Channel<UpdateProgress>, token) -> Result<VerifiedUpdate, Failure>` run inside `executor.run(OpSpec{lane: Network, ..}, token, work)` with `block_on` and a cancel race (`UPDATE_CHECK` background from the launch trigger and interactive from About; `UPDATE_DOWNLOAD` background), settling through the executor's log; N1 moves them with the other Network commands (2.1-M207).
  - Until N0's `OpSpec`, check and download each run in `NativeOperationExecutor::run(Network, ..)` raced against an updater-local cancel flag, with no priority (2.1-M241).
  - The payload stays in memory; cancel drops the transfer; a size cap in the chunk callback settles `network{too_large}` (2.1-M210). The download starts only from About's "Download and install" (2.1-Q235).
  - At the start of `update_download`, before any transfer, a `link_only` probe (so link_only follows downloading, never checking): on `.deb`, `pkexec` on PATH; on the AppImage, its directory writable; else `link_only{url}`, which also covers the macOS dmg until the Q136 probe is clean.
  - `install(verified)` is not a Network-lane facade op (no Busy or deadline); its verify, temp write, pkexec, dpkg and AppImage replace run on the executor's Local class, and restart and cancel are reviewed bounded synchronous commands (2.1-M241).
  - Install on Linux (2.1-Q233): Canopi installs while running (the `.deb` by its own `pkexec dpkg -i` after verifying the payload, 2.1-Q232; the AppImage by the plugin's replace, restoring the backup on failure), then sends the one close request (ADR 0024) through `flushBeforeExit('update')`; a failed install keeps the Design open with "Update not installed: <reason>"; Cancel at the close dialog leaves "Restart to finish updating".
  - Windows (2.1-Q234): `flushBeforeExit('update')` first; proceed writes a pending-update marker, then the plugin runs the installer and exits; at the next launch a marker whose target version is above the running one shows "Update not installed" (reason unknown) and is cleared. Cancel returns to verified and installs nothing (2.1-M209).
  - Restart (2.1-M209): `single_instance::destroy`, `cleanup_before_exit`, then `tauri::process::restart` with the current Design path as argument, so the lock is released and the Design reopens; 2b's app-lifecycle port replaces it (2.1-Q127). `close-guard.ts` exports `flushBeforeExit(purpose) -> 'proceed' | 'cancel'`.
  - Commands (Phase 0): `update_check(operation)`, `update_download(operation, progress)`, `update_install`, `update_cancel(operation)`, `update_restart(design_path)`, `update_launch_check_get`, `update_launch_check_set(on)` and `update_take_launch_notice` (read once, marker cleared), each with its `native_command_policy` row (2.1-M241); `operation` is the caller's fresh id per check or download, the one its cancel names, so a cancel that reaches the host before its op still cancels that op and no later one.
  - `UpdateOffer{version, date, notes_url}` (About shows the version and a "What's new" link to the GitHub release page, 2.1-Q236) and `UpdateProgress{received, total}` live in `canopi-types`. The frontend owns `UpdateState = idle | checking | available{offer} | downloading{progress} | verified | installing | installed | close_requested | failed{failure} | link_only{url}` (`installed`: Linux, restart pending) in `app/updates/` (2.1-M208); `update_download`'s Channel is the only stream. Commands `update_check`, `update_download`, `update_install`.
  - Edges besides the happy path: checking to failed, downloading to failed (network), downloading to idle (cancelled, About's Cancel beside the download, 2.1-Q251), failed to downloading (About's Retry after a failed download that allows it, 2.1-M316), downloading to link_only (the probe runs in update_download), downloading to downloading (progress) and close_requested to failed (a Windows installer that cannot launch after proceed); held by an exhaustive transition-table test (ADR 0028).
  - The launch check runs once, after the start screen is interactive, when the user-DB key row `updater.check_at_launch` (default on when missing, privacy none) is on (2.1-Q164); `host/updater/` alone reads and writes the row, 2.0.3 never touches it, and 2e folds it into settings record 2 (2.1-M206). An available update shows one non-modal notice, mounted only in the Desktop root, that opens About (2.1-M211).
  - Channel and endpoints (2.1-M205): the channel is the Cargo version's pre-release label; `desktop/updater-endpoints.json` (stable and beta URLs on `updates.projectcanopi.com`, redirecting to GitHub release assets, 2.1-Q250) is `include_str!`d for `.endpoints()` and the `HttpPolicy` hosts and read by the release workflow; the e2e endpoint is a build override behind the `updater-e2e` feature, refused in release builds. http.rs's `HttpPolicy` (one row per role: geocoder, image_cache, update_channel, update_payload; User-Agent, timeout, size cap, allowed host) configures the plugin's client.
  - Until 1a, 1b, 2a and 2e land, F6 ships interim pieces as named ratchet entries citing their removing step's bead (2.1-Q239): the updater's own codes and notice (until 1a and 1b), and the key row (until 2e); About's update section and Settings' launch-check switch are children the Desktop root passes, so no edition branch or entry exists (2.1-M319). The restart reopening the Design path it passes adds no ratchet entry; it is plain interim code that 2b's app-lifecycle port replaces (2.1-M209).
  - Tests: `update check settles once in the settlement log`; `offline update check settles network.offline and About shows it`; `cancelled update download leaves nothing staged and settles cancelled`; `a dismissed .deb admin prompt keeps the Design open with Update not installed` (unit; the `.deb` lane's polkit rule refuses, pkexec 127, 2.1-Q244); `an AppImage replace failure restores the backup and keeps the Design open`; `a planted failing Windows installer shows Update not installed at the next launch`; a geocoder request starts while an update download runs.
  - Install tests: `on Windows an update install cancelled at the close dialog installs nothing`; `on Linux a close cancelled after the install shows Restart to finish updating and the update stays installed`.
- **Jobs.** A job facade writes the Queued row through a Library-lane request and returns the `JobId` at once; the runner, not `run()`, starts the work.
- **Display preparation.** In the runner's display slot on the Job lane at background priority, so it never waits behind the heavy job. It is not a visible job and has no deadline: a request while preparing returns `preparing`, and the ready or failed state arrives on the library Channel; deleting the item or closing the Design cancels it with User, and the Channel then sends the key's removal.
- **Settlement.** Every request settles exactly once: ok, a failure code, `busy`, `cancelled`, `panicked`, `join_failed`, or `unavailable` after shutdown. Each settlement logs `op, operation, lane, settlement, code, queued_ms, running_ms, slow`, and `job_id, item_id` for a job (ADR 0025 Logs).
  - An invoke is identified by its settlement event; transport sequence numbers (the Tauri callback id, worker message ids, adapter seqs) stay private to their module and never reach a log, a `Failure`, the ring or a report; one settlement-field table is checked against the tracing layer's fields and the TS ring entry type. Running requests are read from the executor's in-flight table `(operation, op, lane, enqueued_at)`.
- **Frontend.** One invoke per action and command; a fan-out becomes one command over a list (today: `app/plant-browser/live.desktop.ts`, `app/plant-finder/catalog-names.ts`, `app/plant-browser/workbench.ts`); a fan-out that must stay (tile and range reads) names its reason in its command-map row. No client retry. Busy is shown once; Continuous Save reads it as "not saved yet".

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
10. A superseding request interrupts the running one through its hook; a cancel by `OperationId` before start means the work never runs.
11. N concurrent requests under one `OperationId` give exactly N settlement events, each carrying it.
12. Drain order (a composition test): the runner's drain, the janitor, the sidecar killed and reaped, then `executor.close()`; with the executor closed first, `run` returns Unavailable and the job still settles Interrupted.
13. A runner task that dies marks the library `library_read_only{reason: runner_stopped}`; Queued and Running rows settle Interrupted at the next open.

## 4. Design Session ports and their Session suite

```ts
type HomeKey = FileGrantId | DraftId;            // disjoint brands; FileGrantId minted only by Desktop grant decoding, DraftId only by the core's mintDraftId()
type HomeVersion = Brand<string, 'HomeVersion'>; // lowercase hex SHA-256 of the exact bytes the home holds, both editions (2.1-Q165)
type DesignHome =
  | { kind: 'file'; key: FileGrantId; displayName: string; version: HomeVersion | null }
  | { kind: 'draft'; key: DraftId; version: HomeVersion | null };   // null: minted, never written
interface DesignHomeStore {
  read(key: HomeKey): Promise<HomeRead>;          // present{bytes, version} | absent | unreadable{reason}
  write<K extends HomeKey>(key: K, bytes: Uint8Array, expected: HomeVersion | null,
                           opts?: { keepPrevious?: true }): Promise<HomeWrite<K>>;
  // HomeWrite<FileGrantId>: written{version} | conflict{current} | copy_blocked{folder} | failed{failure}
  // HomeWrite<DraftId>:     written{version} | conflict{current} | quota_refused | failed{failure}
  listDrafts(): Promise<DraftRecord[]>;           // records only; canopi-format's draft_summary derives each summary
  deleteDraft(id: DraftId): Promise<Result<void, Failure>>;
  onVersionChange(cb: () => void): Unsubscribe;   // Web store version change (Q40); Desktop never fires
}
// homeKey(home) is the only identity of a home (already-open check, Notebook key, launchIntent, Recent); nothing compares DesignHome values structurally.
// Picking is FileAccess (platform/file-access.ts, 2.1-M155):
//   pickOpen(kind: 'canopi'): Promise<{grant: FileGrantId} | 'cancelled'>
//   pickHomeTarget(name: string): Promise<{grant: FileGrantId} | 'cancelled'>
// The host appends a missing extension and refuses `exists` when the appended name
// exists; a window's pending dialogs settle 'cancelled' on WindowEvent::Destroyed.
// SaveTarget is a FileGrantId; DesignPicker is deleted.
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
  - Also deleted: `app/document-session/continuous-save.ts` (`createContinuousSave`, its `writeHome` option and `overwriteHome`), the orchestration in `state-machine.ts` and `web/browser-design-session.ts`, `DesignSessionState` and `DesignSessionStateStatus` with their test-only `getState()` assertions, and the session counters.
  - The counters: store `sessionGeneration`, `detachedCanvasRevision`, `committedContentRevision`, `acknowledgementGeneration`, `lifetime`; persistence `attachmentEpoch`, `writeEpoch`, `nextSaveIntent`, `latestSaveIntent`; `operationIntent`, `transitionIntent`, `replacementIntent`; and the replacement's pending identity.
  - The Design scope's dispose and `AbortSignal` replace the lifetime and generation counters; the write lane's `rev` and `ackRev` replace the save intents; `latest()` stays for controller requests only (F22). `DesignSaveStatus` (`continuous-save.ts`) goes with them; production reads the core's save state, and Desktop's `operationIntent` and `activeOperationStates` go under F22 (2.1-M118).
- **One write precondition.** `canopi-format`'s writer returns `{bytes, version}` from one canonical encode in the format worker (2.1-M154, 2.1-M156); the core never computes or compares a version and stores only the home returned by `read` or `written`.
  - The adapter compares `expected` with the home's current version inside its atomic step (Desktop: the target lock around `publish_durably`, for files and Drafts; Web: one readwrite transaction) and returns `conflict{current}` on a mismatch.
  - "Keep my version" writes with `expected = conflict.current`; Save as uses its target's precondition (absent, or the probed version of the replaced file). Lost acknowledgement: a `conflict{current}` equal to the digest of the core's own in-flight bytes is adopted as `written`.
  - A Draft open in two Web tabs opens in both, and a Desktop Draft changed by an outside writer enters conflict too (2.1-Q165); the Drafts list may show an advisory `openElsewhere` mark, never replacing the precondition.
- **Adapters resolve keys and never branch on `kind`** (ast-grep: no `.kind` read in `platform/design-home.*.ts`); only the core reads `kind`. Desktop has one native `home_read` and `home_write` pair whose resolver maps a grant to its path and a valid `DraftId` to `drafts/<id>.canopi`; no Draft path crosses to the frontend.
  - The Web Draft-record mechanics (the IndexedDB lifecycle, Q40, the 2.0-key move, the pending-write marker, pagehide and pageshow, the persistence request) live only in `platform/draft-records.browser.ts`, imported only by `design-home.browser.ts` (dependency-cruiser `draft-records-only-in-design-home`).
  - Fault seams are adapter constructor parameters (`IDBFactory` and `Storage`, `DurableFs`), never `EditionPorts` entries.
- **The pre-upgrade copy** (2.1-Q35r). The core passes `keepPrevious` on the first write to a file home after a migrated open and clears `migratedFrom` after `written`; `core.saveWithoutCopy()` omits it; `copy_blocked` is standing save state, not a question (2.1-M162). Web ignores the option.
  - The Desktop adapter runs the precondition, the copy (precondition `Absent`, next free name, never overwriting) and the publish as one executor-backed command; conflict wins over the copy; an unwritable folder returns `copy_blocked{folder}` with nothing published. The Desktop Draft's v9 form in `drafts/before-v10/` stays a migration-time step.
- **Failure names across layers.** Draft records' quota becomes `HomeWrite` `quota_refused`, then save state `quota`, reported as `quota_refused{store: drafts}`; a version mismatch becomes `conflict`, then save state `conflict`; `copy_blocked{folder}` becomes save state `copy_blocked`.
- **Last open home.** One device record, a home key or none, written only by the core: set when a Design reaches open, cleared on Close, unchanged by quit; `launchIntent()` reads it after any file argument (M85); never a grant id, never derived from Recent Designs or Draft timestamps.
  - On Desktop the host turns the stored path (user DB, beside Recent Designs) into a fresh grant (M49); on Web it is a browser record through `platform/browser-record.ts`; a home that is gone or unreadable shows the start screen and clears the record. Test: `closing a Design and then quitting shows the start screen at launch`.
- **File grants.** A file home is a grant, never a path (ADR 0027): FileAccess returns a `FileGrantId` held in `canopi-desktop`, keyed by the canonical parent directory plus the file name (two grants to one file are one home; never the inode); the conflict fingerprint is the content (size, mtime, hash), re-read after each publish (2.1-M155); and Recent Designs and the Notebook hand grant ids to the frontend, their paths kept native-side in the user DB. Grants land with this port in 2b.
- **Drafts.** Only the core mints a `DraftId` (`mintDraftId()`, a brand over `utils/ids`, its pattern and length emitted from the Rust constant and checked by both stores). Each summary comes from `canopi-format`'s `draft_summary(bytes, updated_at)`: name fallback and admission status, unreadable Drafts listed with their reason. The core sorts `listDrafts()` by `updated_at` descending, then id, and its `deleteDraft` refuses the open Design's Draft on both editions.
  - The Start screen's one Drafts list reads this port (`app/design-drafts/controller.ts` and the Web snapshot logic are deleted) and refreshes on window focus.
- **Names.** `app/design-edit/document/design-name.ts` owns `displayName`, `fileStem` and `nameFromSource`; title bar, Start screen, Drafts, the save dialog, every export's suggested name (GeoJSON included) and the open path use it. An unnamed Design stores an empty name. One `normaliseObjectName` serves the Design, view, story and stamp renames; zones keep "empty clears" as a named variant.
- Desktop binds the native files and FileAccess host dialogs. Web binds the IndexedDB Draft store, a file input and FileDelivery downloads.
- A Design scope per open Design: an `AbortSignal` and a dispose list. Its type is `types/design-scope.ts` (L0, its methods the registration API) and its one implementation is in `app/document-session/core/`; only the core opens and disposes a scope. Modules register through `core.onDesignOpened` (a late registration gets the open scope); none watches `sessionIdentity`. The canvas host calls `core.attachScene` and `core.detachScene`; a detached Scene half is data, its unsaved edits kept; a detach removes every history entry holding a Scene token, a compound entry with both halves.
- **Questions are state** (2.1-M162). `closing{current, question?}` and `replacing{current, next, question?}` carry `{id: QuestionId, kind, purpose}`; the dialog renders it and calls `core.answer(id, choice)` (`answered`, or `stale` for an id no longer shown); `dispose()` supersedes pending opens and closes, cancels any question, starts no write and ignores an in-flight write's result; Retry joins the in-flight write; the Clock is injected.
  - Deleted: `SessionCoreHost`, `save-problem.ts`'s request functions, the TS write lanes and the replacement fence. Open for 2b: whether a question is withdrawn when `rev == ackRev`.
- Boot calls `launchIntent()` and then `openFrom`; a last Design that is gone or unreadable shows the start screen, never a refusal on launch; the welcome list opens a Draft through `openFrom` too; nothing else opens a Design. A Web open from bytes makes a new Draft.
- The core reads the in-memory Design through the async design-core port (contracts §10), the format worker on both editions, so save, the Problem Report attachments and Stamps await it; Desktop moves the bytes as a raw IPC body through `ipc/bytes.ts` (2.1-M154).
- **One Undo order**: ADR 0024 (2.1-Q80). Document writes go through `core.document(write, opts?)`: one receipt and one notice each. Each entry has a stable `HistoryEntryId`; `history.newestUndoable` is what an Undo toast shows, `undo({expect})` refuses a stale id, a delete entry never merges, and the core owns MAX_HISTORY (2.1-M159). A policy test fails when a Document key or extra key has no Session-suite Undo case (T7, 2.1-M87).
  - The edit families, one per Document-owned key in `DESIGN_FILE_FIELDS` and one per `DESIGN_EDIT_EXTRA_KEYS` entry: the Design name and description, plant display, views, stories, saved views, budget and its currency, timeline, consortium, Site data entries and the print setup; `created_at` is never edited.
  - **Coalescing.** `core.document(write, {coalesce: key})` is the one way to coalesce: each write applies and advances `rev` live, so a crash loses nothing; consecutive writes with the same key merge into the open entry; the entry closes on the owner's `end(key)`, on any other entry being recorded, on Undo or Redo and on Design replace or detach.
    - Users: the PDF workspace session (opening starts the key, closing calls `end(key)`) and the nudge series. A Session case covers each close trigger. Any other entry recorded meanwhile, Document or Scene, seals the key; the session's next write opens a new entry (2.1-M160).
  - **No Scene history.** `SceneHistory` is deleted: each entry carries its Scene half as the scene runtime transaction's command and its Document half as the `core.document()` inverse, replayed through their owners.
    - Undo and Redo, from the key, the Edit menu or the toolbar, go first to the active tool's transient (`transientHistory`, like the Esc queries), then to the core; a draft's points never enter the Design history or advance `rev`; `canUndo` is the transient or the core.
  - A compound entry (2.1-M89) joins one scene runtime transaction and one `core.document()` write under both owner tokens. `core.compound(type, sceneEdit, (sceneResult) => documentWrite(fields, apply))` runs in order: (1) the core opens one Scene edit under the Scene token, its selection staged in the Scene; (2) the Scene half mutates it, minting copy ids; (3) the Document half is built from that id remap through `documentWrite` (a Scene key does not compile) and admitted through Design Edit (2.1-M158).
    - (4) Refused: the Scene edit restores through its transaction's undo path, the selection is never published, no entry, `rev` unchanged, and admission answers busy meanwhile; admitted: commit the Scene edit, publish its selection once, apply the Document write, record one entry with both tokens, `rev + 1`; if applying still throws, the core undoes the Scene command before recording. Ids are never pre-minted in a tool.
    - Users: a stamp placement with its care actions and species data (2.1-Q155); deleting a species' last plant with its consortium entry (2.1-Q158); consortium rows are derived by `effectiveConsortiums(stored, plants)`, only user-edited rows are stored, and the hand-synced reconcile is deleted (2.1-M158). Tests: one Undo restores both halves, one Redo reapplies both; a refused Document half aborts the Scene edit: no copies, no entry, rev unchanged.
  - **Placement.** `core.place(fragment, at)` brings a Design fragment (Scene objects plus Document parts) into the open Design as one compound entry, owning the id and group remap, the fill-only rule (never overwrite a Design value; a notice names what was added) and the species-code rule (2.1-Q168).
    - Stamp placement is its first caller (2c); GeoJSON import moves onto it only if that removes a route (2c design check). Merge, cross-Design copy, detected trees and "Use as a swale" enter only through it. A policy test: no other module calls `core.compound` with Scene objects and Document parts from outside the Design.
- The Scene serializer is typed `Pick<CanopiFile, SceneKey>`, where `SceneKey` is exactly the fields of `ScenePersistedState`, so it cannot write a Document or `Format` field (`version` from the encoder's `CURRENT`, `updated_at` stamped by the core at write, `map_view` supplied by the core from the camera; 2.1-M121), and no second composer re-lists fields. A policy test maps every Scene-owned key to a `ScenePersistedState` field. Tests build whole Designs from one generated factory over `DESIGN_FILE_FIELDS` defaults; no whole-file literals.
- The Scene codec exposes `hydrateSceneObjectsInFrame(objects, plane)`, which the whole-file hydrate and the GeoJSON import call; no production code builds a `CanopiFile` except the serializer and the generated defaults factory (ast-grep `no-canopifile-literal`).

Session suite (cases; run against both editions' ports; the Draft store also against the real IndexedDB in Chromium, WebKit and Firefox):
1. A new Design's first edit creates a Draft; Continuous Save writes its home.
2. Save as moves the home from Draft to file and deletes the Draft; a failed delete is reported and the Draft stays listed.
3. Open reads and decodes first; a refusal touches nothing. Then the current Design flushes (ADR 0009 dialog), the Scene admits the new half, and only then is the old scope disposed. A source that is the open Design's home (by `homeKey`) answers already-open. Two opens: the latest wins, and `current` stays open and saveable until the new one is admitted (2.1-Q66).
   - A file opened during an unsaved edit flushes the current Design first and opens without asking; a failed flush asks Retry / Discard changes / Cancel, and Cancel keeps the current Design (2.1-Q166).
4. Close flushes, then closes; the Desktop window is destroyed on the closing-to-idle edge, never on the level "close requested and open". (a) A failed Design flush asks Retry / Close without saving / Cancel (ADR 0009). (b) When only the settings store cannot be written, the Design is flushed first, then the dialog asks Retry / Close anyway (Q20).
5. A home whose version moved enters conflict; nothing is overwritten. Runs for file and Draft homes on both editions' real ports.
6. A quota refusal keeps the Design in memory, shows the typed message and arms the Web leave prompt; a pending async Draft flush arms it too, and it disarms when the write settles (Q22, carrying WEB-03's test forward).
7. `busy` leaves the status "not saved yet"; the next tick writes.
8. A canvas handoff (detach, attach) keeps unsaved edits. After a stamp placement with care actions, detach then attach: Undo neither removes the care actions nor leaves stamp copies (the compound entry is gone whole); likewise a last-plant delete with its consortium entry. Ctrl Z during a draft removes its last point and leaves the Design history unchanged.
9. A reopened empty Design opens at its saved `map_view`, bearing 0; a Design with objects opens at its saved `map_view`, bearing included (U28/U30, ADR 0015).
10. Every known key survives decode, compose and encode through the core; an unknown root key is kept; the Scene serializer leaves every Document field as it was.
11. Write admission refuses a Design it could not reopen and names a non-finite field.
12. A migrated open is clean: blur and close write nothing until an edit, except a Web open from bytes, whose new Draft does not exist until an edit. Before the first new-format write to a Desktop file home, the old file is kept once beside it with the notice; an unwritable folder sets `copy_blocked` and the notice asks before saving (2.1-Q35r).
    - Cases: copy kept then published; `copy_blocked` then save without copy; conflict before copy; an existing copy name never overwritten; a Desktop Draft's v9 form kept once.
13. Deleting the open Design's Draft (by `homeKey`) is refused on both editions' ports; a minted id passes the native id check.
14. A new Design starts with Settings › New Designs (plant display) on both editions; an opened one keeps its own.
15. A Drafts list failure shows the typed notice; a failed delete is reported and the Draft stays listed.
16. Every fault the fault seam injects (kill after any step, disk full, read-only, rename failure, IndexedDB quota and abort) leaves the last or previous acknowledged revision on reopen, and no Draft is lost (Q47). A lost acknowledgement whose stored bytes match is adopted as `written`.
17. An edit made while a write is in flight stays dirty, and the lane writes again.
18. Reopening the open Design's home after an edit flushes first and never shows stale content; Close without saving waits for a write started while its dialog was open.
19. A Desktop focus-lost event with a pending `rev` starts a write (it replaces the close-guard focus test when 2b deletes the guard).
20. The pending-write marker is set on the clean-to-dirty transition: a page killed during the encode (worker held), or after an edit before the flush tick, shows the notice at reopen.

## 5. Canvas host

```ts
interface CanvasHostElements { readonly container: HTMLElement }   // the element MapLibre and the scene draw into; the only element measured
interface CanvasHostView { readonly surface: ReadonlySignal<CanvasSurfaceState>; readonly ready: ReadonlySignal<boolean>; retryMap(): boolean; retryLayer(slot: LayerSlotId): void }
mountCanvasHost(elements: CanvasHostElements, deps?: Partial<CanvasHostDeps>): CanvasHostHandle
  // deps are a test seam only: core (Pick<SessionCore, 'attachScene' | 'detachScene'>), createComposition, flushSettings, reportFailure
useCanvasHost(containerRef): CanvasHostView
```

- Owner: `app/canvas-map-surface/canvas-host.ts` and `use-canvas-host.ts` (L3, new in 2b); no edition record and no surface binding.
- Start order: lease; create the one workspace composition from the installed `EditionPorts`; start it; `core.attachScene(seam)` (`attached` and `no-design` proceed, `no-design` showing the start screen until `openFrom` admits a Design; `cancelled` reads unavailable); resize the container; observe it; publish; `ready = true`.
- Release order: `core.detachScene()` synchronously before any await (if it throws busy the host keeps the lease, reports `canvas-release-failed`, and a later release retries); disconnect the observer; flush settings; dispose the composition; unpublish; `ready = false`.
  - Cleanup errors are aggregated and reported once through `reportFailure` (codes `canvas-start-failed`, `canvas-release-failed`, source `canvas-host`). An unmount during start waits for the creation and attachment settlements, then detaches the exact seam. A zero-size container is "not laid out": no NaN camera.
- Gallery: the gallery root runs the real Session core over a memory Draft home; its `launchIntent()` returns the fixture as a `{kind: 'bytes'}` source; an effect keyed to `view.ready` frames the fixture through public viewport commands and sets the gallery's `framed` signal; a framing failure is reported and fails the e2e loudly.
- Policies: lease, publish, `attachScene` and `detachScene` only in `canvas-host.ts`; `mountCanvasHost` only from `use-canvas-host.ts`; ast-grep refuses a second argument to `mountCanvasHost` outside tests; `data-map-active` only from the map-surface visibility.
  - No `useState` or signal holding a surface or map state outside `canvas-host.ts` and `map-lifetime.ts`; no `map-lifetime` import from `components/`.
- Suite (`canvas-host.test.ts`, through the real host): each attach outcome; a cancelled start reads unavailable; the release order; a failed attach aborts; `detachScene` busy keeps the lease; a zero-size container; the host measures its container; a guarded unpublish that throws; an owner cleanup failure with no unhandled rejection; aggregated errors.
  - Also a table test of `composeSurface` over both unions, and `retry === 'offered'` implies `retryMap()` returns true. `document-session-lifecycle.test.ts` is deleted in the commit that adds it.
- Deleted: `CanvasHostEdition`, `activate`, `resizeTo`, `label`, `onReadyChange`, `onStartFailure`, the per-edition `createComposition`, `consumeQueuedDocumentLoad`, `app/document-session/lifecycle.ts`, `use-canvas-document-session.ts`, the hand lifecycles in `web/WebCanvasWorkspace.tsx` and `ui-gallery/GalleryCanvasSurface.tsx`.
- Fallback if the 2b canvas-host prototype fails: `CanvasHostBinding { surface, attach, detach }` with a policy that only the gallery binding differs from the core pair; `resizeTo`, `label` and `activate` go in either case.

**Canvas surface state.** `CanvasSurfaceState = idle | starting | unavailable{cause: runtime-failed | start-cancelled | runtime-destroyed} | map{map: MapLifetimeState, retry: offered | withheld | never} | releasing`, computed by the pure exported `composeSurface(lease, mapState)` (exhaustive over both unions) and exposed as `surface` on the handle and the app-level read-only `currentCanvasSurface`.

- The lease: `free | held{gen, start: starting | attached | cancelled | failed{cause}, runtime: alive | destroyed, mapFailure: none | handling | settled, map: MapLifetimeHandle | null} | releasing{gen}`.
- Retry rule: `never` for `no-webgl2` or a destroyed runtime; `offered` only when the map failed, `mapFailure` is settled and the runtime is alive; else `withheld`. The failure cleanup carries a deadline: a hung dispose is reported once and then settles. Transitions run inside `batch()`.
- Readers (CanvasPanel, the Web mount, `map-notice.ts`, `design-reveal.ts`, `data-map-active`) read only `surface`.
- Deleted: `MapLibreCanvasSurfaceState` and its constants and equality, `publishState`, `onStateChange`, `publishUnavailable`, the writes in `document-session/lifecycle.ts:142` and `WebCanvasWorkspace.tsx:211`, the composition's `mapState`, `publishMapState` and `canRetry()`, `onRetryAvailabilityChange`, and the `useState` copies in `CanvasPanel.tsx` and `WebCanvasWorkspace.tsx`.
- Phasing: 2b lands the host with `held.map` behind the `MapLifetimeHandle` type, backed by the composition's state; 2d replaces only the handle's implementation.

## 6. MapPort and the RasterDisplay sequence suite

- Each consumer in `maplibre/` declares its port as `Pick<maplibregl.Map, ...>`. No hand-written map interface and no `as unknown as` map cast remain. `app/`, `canvas/` and `components/` reach the map only through `maplibre/` modules.
- `maplibre/scene-host-layer.ts` declares the inversion port `ScenePainter<Snapshot>` (`init(surface)`, `resize(size)`, `paint(frame)` drawing inside MapLibre's frame and never clearing, `dispose()` never losing the shared context) and owns `createSceneHostLayer({id, frames, painter, onAttached?, onFailure})`.
  - The host owns its phase machine, size contract, one paint per eligible frame, teardown order and `presentFor(view): Promise<void>` (resolving on the MapLibre `render` after the layer's present, rejecting on failure or dispose). The snapshot map awaits `presentFor` instead of reading `sceneSyncCount`.
  - The one implementation is `canvas/runtime/renderers/pixi-scene-painter.ts`, built with its host by `scene-layer-factory.ts`; `SceneRenderTarget`, `PixiScenePresentation` and `SceneHostLayer` stay three roles.
  - Deleted: `maplibre/shared-scene-layer.ts`, `maplibre/shared-scene-renderer.ts`, the `createRenderer`, `createStage` and `createPresentation` options, the `addLayer` cast in `view-snapshot-map.ts`, `sceneSyncCount` as a wait protocol and the hand fakes `createFakeLayer` and `createComposition`.
  - Tests: the host with a recording painter and `createFakeMap()`; the real painter through real MapLibre and Pixi (one present per frame, `resetState`, no context loss on dispose, no surviving ticker); a model-based test of the host phase machine.
- `maplibre/` imports nothing from `canvas/` (ADR 0022). It also exports the MapLibre DOM class constants (read by `canvas/runtime/input/dom-input-source.ts`, `map-background.ts` and `view-snapshot-map.ts`; the panel CSS's MapLibre selectors move into a `maplibre/` stylesheet) and owns the `maplibre-gl.css` import, which edition roots take from it. The contour style builders (`canvas/contours.ts`) move into `maplibre/`; the World map is deleted (2.1-E5).
- One `createFakeMap()` in test support implements the union of the picks with behaviour: style load and reload events, sources, layers, `getZoom`, `getBounds`.
- `maplibre/map-lifetime.ts` owns one instance per map slot (workspace, story presenter, snapshot, print): `MapLifetimeState = creating{attempt} | admitted{attempt} | ready{attempt, layers: ReadonlyMap<LayerSlotId, LayerStatus>} | failed{attempt, cause: no-webgl2 | engine-start | style | later-style-load | context-lost} | released`.
  - `LayerStatus = loading | ready | failed{reason} | skipped{reason}` (the background band and terrain have fixed slots; library rasters and vectors are keyed by layer id). Writers: the lifetime's own engine events and one slot handle per contribution (`lifetime.slot(id).set(status)`, ignored after released); every input carries the attempt token.
  - API: `state`, `slot(id)`, `restart()` (failed to creating{attempt + 1}), `release()` (contributions, then the map). The WebGL2 check is `creating -> failed{no-webgl2}` (code `webgl2_unavailable`). It holds no Retry policy (§5) and imports nothing from `app/` or `canvas/`.
  - It absorbs the admission states of `workspace-map-controls.ts`; the satellite configuration is passed in, and the band order and the shared scene layer id move into `maplibre/`. A later `style.load` fails the map with Retry (ADR 0004), never a silent empty map.
  - Deleted: `terrainStatus`, `basemapStatus`, `layerSkipped` and `raster-display/adapter.ts`'s `RasterDisplayLayerState`; a policy refuses any other layer-status type in `maplibre/` or `app/`.
- One composition owner in `maplibre/` serves the workspace, the story presenter and the snapshot map, which is built through the same factory and lifetime; its caller hands it the scene layer factory, and both scene layers dispose before `map.remove`: a view saved with contours on gives a thumbnail whose style holds the contour layers. One contour style builder (minor, major = interval × 5, labels) serves the terrain contribution and the vector contour descriptors, and contour ink follows the map backdrop (`mapBackdropOf`), never the UI theme.
- Web Mercator has one owner per language: the Rust `crs` leaf's `web_mercator` module and `geo/web-mercator.ts` (metre and unit forms), with `inspection.rs` the one named oracle; the display descriptor carries `lattice_zoom: Option<u32>` from warp, and `overzoom.ts` overzooms only when it is set and the source is 3857.
- Raster pool tests run the real worker handler, a `createRasterLane()` factory with per-instance state that `worker.ts` only wires, through `inProcessLane()` with timing controls (hold, release; `hang` lands with 2d's MAP-17 deadline, 2.1-M172); `FakeLane` and `IdleLane` are deleted.
- Browser tests route the basemap through one `e2e/support/basemap.ts` (`serve`, `hold`, `abort`), its pattern built from `OPENFREEMAP_BASEMAPS`.

RasterDisplay sequences, run on the fake and on the real `LayerManager` with the real pool and worker (the P1 harness):
1. `[A] -> [] -> [A]` draws A's tile for a single-asset and a two-asset item (also with a Blob asset).
2. `[A] -> [B] -> [A]` (ramp to another variant and back) draws the mosaic.
3. A ramp or range change keeps the tile drawn.
4. A later `style.load` mid-sequence fails the map with Retry, and the Retry map draws every shown layer.
5. Dispose releases every pool source (also with a Blob asset).
6. A refused source shows as that layer's `LayerStatus` failed and a diagnostics entry, never a silent empty tile.
7. A hung lane is released by the task deadline.

## 7. Item kind

`LibraryItemKind` is a closed enum in `canopi-types` with its stored literals (`literal()`, `ALL`), which `bindings-gen` emits, not a trait; `kinds.rs`, a `canopi-library` leaf (ADR 0023), owns `parse_kind(&str) -> Result<LibraryItemKind, LibraryFailure>`, the only parse of the stored literal; each layer owns its own exhaustive match, with no wildcard arm (ast-grep; 2.1-M46, 2.1-M125).

Two kinds exist in 2.1: `Raster` and `Vector`. Each operation lives in its own layer and matches on `LibraryItemKind` exhaustively, so the compiler's list of non-exhaustive matches is the checklist a new variant fills. The `Vector` variant comes with bring-your-own vectors (2.1-Q100), imported through the one bounded GeoJSON reader and drawn by `maplibre/library-layers.ts`; hydrology's vector outputs reuse it.

The summary and delete shapes carry no raster-only field, so the point-cloud variant (seen and profiled, 2.1-Q79) adds a display and a profile, not a second summary.

```rust
// canopi-types (bindings-gen emits it; kinds.rs matches over it)
pub enum LibraryItemKind { Raster, Vector }      // stored literals 'raster', 'vector' (in the v26 CHECK)
// repository
fn decode(row: &ItemRow) -> Result<Item, LibraryFailure>;   // the one row decoder: reads the kind column through kinds::parse_kind; recovery calls it too
fn claims(item: &Item) -> Vec<LibraryPath>;      // what the janitor must keep
// extensions
fn prepare_display(item: &Item, variant: &Variant, recipe: &DisplayRecipe) -> DisplayState;
fn sample(item: &Item, at: SessionPoint) -> Result<Sample, LibraryFailure>;   // native value sampling
```

- An unknown stored literal is refused by `decode` and by recovery; it is never read as a raster.
- `bindings-gen`'s enum is bound to the frontend `LibraryItemType`. Frontend picking stays in `sampler.ts` (R5).
- **Identity.** Every item has one opaque `LibraryItemId` (`canopi-types`). Step v25 to v26 adds `library_items(id PK, kind CHECK from LibraryItemKind::ALL, lineage_tag CHECK from Lineage::ALL, name_key UNIQUE)` plus one detail table per lineage; ids are kept, and an id found in both old tables refuses on the verified copy (a planted fixture). `repository::resolve(&LibraryItemId)` is the only id-to-table map.
  - Deleted: `LibraryItemRole` with its registration, schema and TS type, `LibraryItemSummary.role` (replaced by `lineage`), and the `kind` fields of `LidarSampleTarget`, `LidarDisplayRequest` and `LidarDisplayDescriptor`; display, cache and layer keys become (id, generation, variant).
  - Fallback if Step 2.0.4 R2 cannot carry the v10 change: it moves to v11 (2.1-M130). `ProvenanceInput` stays library-item-only in 2.1; the sunlight design check records its two input options (plan After the foundations).
- **Quantity and display table.** One table in `canopi-types` beside `LibraryItemKind`, keyed by quantity and role; 2c lands it with its TS emitter and the unit columns (unit family, and display units and precision per unit system, §14), and N1 adds the display columns: scale (linear, log or circular), importable, declares units, fixed unit, the ramps offered with the default first (no blue outside water), the default range, whether relief draws and the profile role.
  - Rust `draws_relief` and `build_plan` and TS `kindRamps`, `kindDisplayDefaults`, `displayVariant`, `profileRole` and `itemTypeStyle` read it. `RASTER_QUANTITIES` is deleted, and `item-types.ts` holds no table keyed by quantity: it is the reader layer over the generated rows.
  - The label key follows a fixed pattern from the quantity literal; the default range per unit is a column of the row; the ramp-to-colormap map lives with the renderer's colormap table; unit suffixes belong to `utils/format.ts`.
  - Checks `every_output_quantity_has_a_row` (each row has a scale) and ast-grep `no-quantity-keyed-table-in-ts` (no `Record<RasterQuantity, ...>` outside `generated/`).
- **Display recipe.** An analysis row carries its recipe: its output quantity (whose row gives scale, default ramp and range) and the output sentinels masked as no-data (aspect's flat -1). The windowed tool contract declares those sentinels. `prepare_display` reads the recipe and the output quantity's row; the item-type descriptor's scale is generated from the quantity row.
- **Descriptor contract.** The legend, the value readout, the range controls and the style controls read only the item-type descriptor; colormap stops come from the renderer's table, not a hand copy. Unit formatting dispatches on the descriptor's quantity, not unit strings. The descriptor also carries the lineage table (L4: label, filter group, can rerun, can refresh, detail facts), so panels never read `role` or `provenance.analysis_id` (ast-grep `no-lineage-field-read`).
- **Lineage.** One field per item, `Source | Analysis{provenance} | External{tool, date, notes, links}`, replacing `LibraryItemRole` and `provenance` in catalogue step v25 to v26, a frozen step with its fixture that rebuilds its tables on a verified copy (ADR 0026); out of date and Refresh exist only for `Analysis`. A derived result's name is written once in the language used at calculation and is editable (2.1-Q98). Unsupported-CRS advice names only supported systems whose area covers the file, or a short list when the extent is unreadable (2.1-Q99).
- **Generated, once.** The quantity rows and each importer's accepted-format list are generated from `canopi-types` to TS; the file dialog filter (`actions.ts`) and suggested-name stripping (`suggestedItemName`) both read the list. The gallery replays transcripts the real commands write (§13).
  - Analysis rows stay authored in `canopi-types/analysis-registry.json`; `bindings-gen` reads and checks them only through the `canopi-types` registry types (serde and schemars), its mirror structs are deleted, and a drift test fails if it declares its own registry shape, so a new group or kind is edited once.
- **Analysis dispatch.** A registry row says what an analysis is (id, recipe version, group, inputs and grid requirements, typed parameters, outputs with quantity and recipe), never how it runs. `AnalysisId` is generated from the rows (closed, `literal()`, `ALL`, `from_literal`); `EngineId` and `ENGINES` (identity per engine: crate, version, revision from `Cargo.lock`) live in the engines layer.
  - `trait AnalysisExecutor { const ENGINES: &[EngineId]; fn admit(&self, input, grid, limits: &EditionLimits) -> Result<(), AnalysisUnavailable>; fn run(&self, ctx) -> Result<ExecutorOutcome, String>; }`; `executor(id: AnalysisId) -> &'static dyn AnalysisExecutor` is the one exhaustive dispatch.
  - Shape helpers (`analyses/windowed.rs`, `analyses/whole_grid.rs`) own chunking, halo cropping (a const halo asserted against `MAX_RECIPE_HALO`, or a parameter-derived halo under a named per-analysis ceiling, 2.1-M166), cancel checks and staging.
  - The runner builds `ToolProvenance` from `ENGINES`; freshness compares recorded engine identities (a retired engine is stale `engine_retired`; an unknown analysis id reads with `analysis_retired`). `EditionLimits` owns the whole-grid cell cap and the Web memory limits; Web availability is the ADR 0030 row, never derived from shape or engine.
  - Deleted: `AnalysisLane`, the row field `lane`, `LaneSchema`, the TS `AnalysisLane`, `"lane"` in the registry JSON, `EXECUTORS`, `AnalysisExecutor::analysis_id`, `AnalysisUnavailable::EngineMissing` and the `GeolibreTool` parameter of `offers`, `input_unavailable` and `FreshnessCheck::new`.
  - Checks: a row without an arm fails to compile; `analysis_row_has_golden_fixture` requires two chunks and a golden provenance; analyses call only their declared engines.
- **Raster engines.** No engine trait: `engines::raster_read` (`probe<R: Read + Seek>`, `RasterReader::open(src, expected)`, `read_window(window, cancel)`; the only raster read path, merged with `prepared_raster.rs`'s tile reader) and `engines::raster_write` (`write_controlled`, `write_display`, `write_relief` over `RasterView{grid, samples}` into a `Write + Seek` sink).
  - `RasterFailure` (Unreadable, NotGeoreferenced, Truncated, OverBudget, OutOfSpace, Cancelled) is a catalogue entry; one constant owns the 25 M-cell cap. Only the repository opens paths and publishes sinks through `publish_durably`; `canopi-library-wasm` supplies an OPFS `Read + Seek` adapter, with one adapter suite on native and wasm.
  - Golden lane: `golden::gdal` and `golden::geolibre` free functions, goldens recording their provenance and tolerance; ordinary and wasm lanes compare against stored goldens only; the scheduled lane runs the oracles.
  - Deleted: `RasterEngine`, `RasterInput::File`, `RustRasterEngine`, `LidarLibraryInner.engine`, every `&dyn RasterEngine`, the `GdalEngine` implementation and trait-driven harness, `prepared_raster.rs`'s private reader, `LibraryEngines` and `LidarEngineStatus`.
  - Checks: no `Path` or `std::fs` in engines; no trait whose implementations are all `cfg(test)`; `GeoTiff::from_reader` and `open` only in fixtures. Fallback if the N0 probe fails: none needed beyond keeping the trait-free modules; record the outcome in ADR 0023.
- Catalogue CHECKs list the enum's literals and change only through a catalogue step.
- **Stored enums.** Every stored enum in `canopi-types` (`LibraryItemKind`, `LidarImportProgressPhase`, `LidarDisplayRangeBasis`, and §8's `LibraryJobState` and `LibraryJobOutcome`, which replace `LidarImportJobState` and `AnalysisJobState`) has one `literal()` and an `ALL` table; decode refuses an unknown literal with a typed failure; the repository binds values as parameters; each catalogue step's CHECK text is generated from `ALL` (the `library_jobs` state and outcome CHECKs among them), and a unit test holds each CHECK to its enum.
- **Names and coverage.** The `canopi-library` repository owns item names: one key (trim, NFC, a language-free lowercase fold) under a UNIQUE index over source layers and derived items, one allocator in the write transaction for import, rename, recovery and derived results, a clash settling `conflict{what: name, suggestion}`. Import coverage asks the scene runtime for the Design's outline points (rotated zones, ellipse polygons, plant crowns at canopy spread, guide ends) by a read-only query.
- **Files the WebView reads.** The host grants every WebView-readable directory (display COGs, later display vectors) from one list the LiDAR paths owner exports, and the image cache from its own owner; a mock-app test serves a display COG and refuses a file in `display-cog-staging`. A file the user picks is not on that list: dialogs run in the host, so the dialog plugin adds no picked file to the scope, and a contract test refuses one over `asset://` (2.1-M81).
  - Host dialog commands (Phase 0 F5, 2.1-M214) take their final shape: `pick_open(kind)` and `pick_save(kind, stem)`, one pick at a time (a second is refused), settled cancelled when the window is destroyed; 2b changes only their return type. The window capability holds no dialog open or save permission. The one list is a generated table yielding both the asset-scope grants and the CSP asset origin (M84); it has no Web column.
- **Library changes** reach the frontend through one `tauri::ipc::Channel` subscription per caller, which sends the current state (jobs, progress and the display state per (item, variant) key) on subscribe and then each change in order; no broadcast event, no status read, and no TS code compares job-state names (2.1-M56, 2.1-M103).
  - The facade owns the subscriber set, keyed by (WebView label, page-load generation); a subscription ends on unsubscribe by the app-scope disposer, the host's page-load-started event for its WebView, a send error or executor close.
  - Tests: a model test interleaving subscribe, reload, unsubscribe and a settle leaves one live subscription after a reload and sends nothing to a closed one; a mock-app reload counts subscribers.
- **Display resolution** belongs to the Data library port (2.1-M132). L0 `types/display-asset.ts`: `DisplayAsset { key; bytes: string | Blob; bounds }`, `key = <kind>/<itemId>/<generationId>/<variant>/<n>`; on Desktop `bytes` is a range-readable asset URL from the real `convertFileSrc` inside the Desktop library adapter, on Web the OPFS `File`, never a `blob:` URL.
  - `platform/library.ts` `display(ref) -> Promise<DisplayState>`, `DisplayState = Preparing | Ready{assets, latticeZoom} | Failed{code} | Gone`; Preparing and later states arrive on the subscription (no poll). A display file is write-once per generation id.
  - The raster pool and LayerManager take `DisplayAsset` through a synthetic `canopi-display://asset/<key>.tif` resolved by the injected tiler client. Dispose order: the layer, then the pool handle (in-flight reads abort), then the entry.
  - Display keys, Blobs and `asset:` or `blob:` values never reach a Design, export, saved view or log (policy test). `convertFileSrc` only in `platform/*.desktop.ts` adapters owning a store row.
  - Deleted: `lidarAssetUrl`, the `toAssetUrl` parameters, the frontend `path` field and `asset://localhost` literals outside the adapter. Fallback if the N5 probe fails: an owned `blob:` URL lease inside the browser library adapter; the port is unchanged.
- **Port operations.** `platform/library.ts` also exposes `subscribe(listener)` (the current state, then each change in order, progress included) and `cancel(jobId)`; the Desktop adapter wraps the Channel, the Web adapter relays the library worker's port messages (2.1-M151).

## 8. Jobs state machine

One `library_jobs` table for imports and analyses, written only by the `jobs.rs` runner; catalogue step v25 to v26 merges 2.0's `lidar_import_jobs` and `lidar_analysis_jobs` into it, and this is the shape the reader release freezes in catalogue 26. Step v25 to v26 renames every catalogue table from `lidar_*` to `library_*` (2.1-M127).

The stored enums are `LibraryJobState { Queued, Running, Settling, Settled }` and `LibraryJobOutcome { Succeeded, Failed, Cancelled, Interrupted }` in `canopi-types`; Settled carries the outcome in memory. The transitions are one pure function in `canopi-types`, applied by `jobs.rs` under the SQLite CHECKs and by the Web runner to its IndexedDB job store.

| From | Event | To |
|---|---|---|
| (new) | submit | Queued |
| Queued | runner starts it (heavy capacity 1, FIFO) | Running |
| Queued | cancel (analysis) | Settled(cancelled) |
| Queued or Running import | cancel | withdrawn: the job row is deleted in one catalogue transaction; a first import's item goes with it; a Retry's item reads Failed again under its earlier import, with Retry and Dismiss; the originals stay until that Dismiss (user 2026-10-09); the withdrawal bumps the revision watch |
| Running | cancel before the runner registered its token | recorded, applied at registration |
| Running | work returns or cancel is seen | Settling |
| Settling | publish or discard done | Settled(succeeded, failed{failure}, or the token's reason: User gives cancelled, Shutdown gives interrupted) |
| Running | drain at quit (cancel with reason Shutdown) | Settling, then Settled(interrupted) with Run again (2.1-Q61) |
| Running, Settling | found at open | Settled(interrupted), offering Run again |
| Queued | found at open | Settled(interrupted), offering Run again (Q38) |
| Settling | cancel or drain | ignored; settles normally within the drain's bounded wait |
| Queued, Running | an input item deleted | refused: Delete settles `conflict{what: job}` and names the job; the screen offers to cancel it |
| Settled | Dismiss | row deleted, then the janitor runs |

```sql
state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'settling', 'settled')),
outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'interrupted')),
failure TEXT,                                     -- the catalogue JSON form (code and payload, no detail); unknown decodes to internal
operation_id TEXT NOT NULL,                       -- the action's OperationId (ADR 0025)
CHECK ((state = 'settled') = (outcome IS NOT NULL)),
CHECK ((outcome IS 'failed') = (failure IS NOT NULL)),
CHECK (failure IS NULL OR json_valid(failure))
```

- Each transition is a guarded `UPDATE ... WHERE id = ? AND state = ?`; 0 rows matched is `conflict{what: job}`.
- `failure` decodes with the live failure decoder; an unknown or unreadable value is `internal`. Check `stored_job_failure_round_trips_every_fixture`.
- Settled is final; Retry submits a new job. State changes are a revision watch plus a re-read, which cancel, Delete, Dismiss and the janitor wait on. No polls, and no lossy broadcast.
- Progress: the watch carries progress for every job kind (phase plus fraction, or indeterminate) on the same channel subscription, so imports keep what `LidarImportProgress` shows today (2.1-M56).
- A settle that fails (`io{no_space}` during publish included) hands its `writing` claims to the janitor at once.
- Open runs in order: recovery settles every found job as above, then turns every `writing` claim into unclaimed (the holder of the `ExclusiveOwner` runs recovery, so none is live at open), then the janitor's open run sweeps.
- Quit, drain and facade gating: ADR 0024 Close and hide, Native executor and Library jobs (2.1-Q61). The drain also cancels display preparation with reason `Shutdown`, waits a bounded time, then kills the sidecar child; a row not settled by then settles Interrupted at the next open.
- Test: a model-based sequence test against the real runner and the SQLite CHECK, covering cancel while Settling, input deletion, progress, a failed settle, quit while Running, and open recovery before the sweep; a job in Settling when the drain starts publishes and records succeeded, and the next open leaves it; LID-01: a cancel made while the executor is busy also withdraws an import, never settling Failed.
- **Web runner** (2.1-M151). The same `jobs.rs` runner and janitor run in the library worker over the catalogue in SQLite on the OPFS pool VFS (journal mode DELETE); engines run in a child engine worker, whose loss leaves the library worker live. The worker holds the `canopi-library` Web Lock as its `ExclusiveOwner`, so recovery never settles a live tab's job.
  - The page terminates the library worker on `pagehide` (the lock and OPFS handles go at once) and reopens it on `pageshow`; the next holder's open settles in-flight jobs Interrupted with Run again. "Use here" asks the holder over BroadcastChannel; it drains and releases, and the new holder recovers. No OPFS settles `library_storage_unavailable`. The model-based sequence test runs on both editions' runner.

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

- The chain lives in `canopi-format` (ADR 0023). A migrated open is clean, so only a real edit writes. The pre-upgrade copy, `copy_blocked` and which opens show the notice: ADR 0026 `.canopi` admission (2.1-Q35r); the copy is named `<name> (Canopi <old version>).canopi` and never overwrites an existing file.
- `canopi-format` owns a frozen `release_label(format_version)` table (v9 -> "2.0"), emitted into each `spec/v<N>/`; the pre-upgrade copy's name is built only from it.
- A `StepFailure` refuses with `design_load{migration_failed{from}}` and the step's from-version; the file is left unchanged and the refusal is reported. A Draft or stamp file that fails is listed as unreadable, never hidden. The harness covers it with a planted failing step.
- A step is pure: no I/O, clock or randomness. Its input is checked by the frozen vN-1 schema and its output by the vN schema. It never touches the live structs.
- Steps run in order, once, at the one decode choke point, before the schema decode. Open, Drafts, stamp files and write admission all pass through it. Web runs the same code in the core worker.
- Each released version has `canopi-format/spec/v<N>/`: schema, fields, new-Design defaults, `fixture.canopi` cut from its tag (v10's from the first build that writes v10, 2b), its hand-written expected output, and the `additions/` annex for optional fields valid alone (Q36).
- The reader release freezes only v10's read schema, a hand-made read fixture and its expected read output, while `DESIGN_FILE_FIELDS` still describes v9; a release check holds the emitted v10 schema equal to that read schema or its `additions/` (2.1-M31).
- A version fixture covers every `DESIGN_FILE_FIELDS` key with a non-default value, every nested struct filled, and one unknown root key.
- The v10 step (2.1-Q69) makes ramps, raster quantities and locales open strings (an unknown literal is kept and the documented default used) and gives every nested object an extension bag that keeps unknown keys. It moves `extra.plant_display` into the typed Document field `plant_display` and passes any other unknown `extra` key through; if none remain, the extra-key registry is deleted; its symbol-scale range is the settings field table's.
  - The v10 step drops `kind` from `LidarPresentationEntry` (`{id, name, visible, opacity, order, ramp, reversed, range}`): a v9 entry whose `kind` contradicts its id resolves by id; two v9 entries with one id keep the lowest `order`; an id the library lacks reads by its stored name as unavailable; admission refuses duplicate ids on write; each case has a corpus fixture. This is in the v10 read schema Step 2.0.4 freezes (2.1-M130).
  - The budget shows plant lines only, each reduced to its target and unit cost, with one currency per Design (2.1-Q96); non-plant lines move unshown into the budget's extension bag (2.1-Q162).
- Group members are typed ids of plants, zones, notes and measurement guides (2.1-Q154); the guide member kind is in the v10 read schema Step 2.0.4 freezes (2.1-M94). Admission normalises groups at decode (dangling members removed, groups under two members dropped) and refuses them on write; a corpus case has a one-member group and a dangling member. In TS one `normaliseGroups(groups, existingIds)` in the scene layer serves mutations, notes, stamp files, GeoJSON import and arrangement placement.
  - The group corpus (a one-member group, a dangling member, a duplicate member, one case per member kind including measurement guides) runs through both `normaliseGroups` and core decode with equal outputs; a property test: whatever `normaliseGroups` outputs, write admission accepts.
- v10 additions after the freeze (2.1-Q36, 2.1-M94), each under `additions/` with no step and ignored by the reader release: the Document field `print_setup` and the zone stroke colour and opacity (T4).
  - `print_setup` (2.1-Q152, 2.1-M90, 2.1-M161): `PrintPage{id, name, area, framing}` in print order, `area` one of `Box{centre, size, angle_deg}`, `WholeDesign{angle_deg, fallback}` or `SplitSheet{split, along_page{right_m, down_m}, size}`; `PrintSplit{id, pivot, angle_deg}`. A sheet's centre is the pivot plus its `along_page` turned by the angle, and its offset and size use the pivot's ground scale, so sheets tile at any latitude; a `Box` uses its own centre's scale.
  - A split's sheets share its pivot and angle, a sheet split again joining its parent's split; admission refuses a sheet naming a missing split; no sheet count is stored; the paper and print options; default pages are derived and never written until the first edit, so opening or exporting never dirties the Design.
  - `app/canvas-pdf/print-setup.ts` alone crosses frames: `inPlane(setup, plane)` gives a branded `PlanePrintSetup` (never in a signal, store or write) and `applyPrintEdit(setup, edit, plane)` gives the next `PrintSetup`, untouched pages byte-identical. Tests: a corpus case with a split and a whole-design area; a property test at 49° and 65° on two plane anchors.
- A v3 stamp payload maps to the stamp file and back: colours to `plant_species_colors`, unit costs to species-targeted budget lines, strata to `consortiums`, care actions to `timeline` with `PlacedPlant` targets remapped through import's id map, recurring actions through `recurrence`.
  - One optional `TimelineAction` offset from placement is a v10 addition (Q36, M94), valid alone, never written by the Design path, resolved to a date at placement.
  - Test (2b): a v3 payload with every Q155 item goes stamp to file to stamp equal through the real codec. `file.ts`'s hard-coded empty timeline, budget and consortiums are deleted.
- A Recent Designs preview that cannot be read carries the core's `DesignLoadFailureKind`, beside its size cap and transient-or-cacheable flag (`NAT-11: Recent and Open give the same refusal for each corpus file`).
- Tests: the chain runs from every fixture to head against its expected output; `migration_steps_frozen` pins released steps by content hash; a release check fails on a schema change without a step and fixture; `canopi_format_fixture_covers_every_field`; the encode-decode round trip and "every accepted Design re-encodes to an admitted file" as property tests.
- **Document references.** References from Document data to Scene objects or library entries are typed ids resolved at read by the one resolver; one that does not resolve is kept and shown `unavailable`, never dropped, so Undo of a delete restores it with no second write. Pruned instead only where a dated user decision says so, as one compound entry; normalised and refused on write only where the reference forms the object (groups).

| Reference | Rule |
|---|---|
| timeline and budget `PanelTarget` | keep and mark |
| stamp care-action targets on placed copies | keep and mark |
| consortium entry of a species' last plant | prune (2.1-Q158) |
| group members | normalise |

Rows are added by their releases (print pages pointing at views or stories; Site data entries pointing at library ids). A test fails when a reference-bearing type has no row.

**The design-core port** (`platform/design-core.ts`; both editions bind the worker adapter `platform/design-core.worker.ts`, 2.1-M154):

```ts
interface DesignCore {
  decode(bytes: Uint8Array): Promise<Result<OpenedDesign, Refusal>>;   // cap, JSON, version, chain, admission
  encode(design: InMemoryDesign): Promise<Result<Uint8Array, Refusal>>; // admission on write
  newDesign(input: NewDesignInput): Promise<Result<InMemoryDesign, Failure>>;  // input carries the plant_display defaults from settings' NewDesignDefaults slice
  draftEnvelope(record: unknown): Promise<Result<DraftContent, Refusal>>;
}
// Worker adapter states: loading | ready | load-failed | poisoned; poisoned -> loading (respawn); ready -> loading (recycle after a large open, once idle)
```

- The one compile, settlement, traps, load-failed and encode traps: ADR 0025 Format core failures (Q34). The worker is recycled after a large open, once idle.

- Only `platform/design-core.worker.ts` imports the `canopi-format-wasm` glue. It reports the core version; a test checks it equals the crate version. Encode is canonical: a property test encodes each generated Design twice and finds the bytes equal (2.1-M156).
- Edit-time predicates (colour range, opacity, rich-text links, embedded image bytes, group normalisation (`normaliseGroups`)) stay in TS in `app/design-edit/document/admission.ts`, over constants generated from `design.rs`; a vitest contract test holds them against the core. `app/contracts/design-admission.ts` is deleted.
- The one New Design command in `app/shell-commands/` calls `openFrom` with `NewDesignInput`, then, when Settings › New Designs › Open on satellite is on (the settings' `NewDesignDefaults` slice), `setMapBackground('satellite')` once it settles `applied`; `app/settings/new-design-defaults.ts` and its two call sites are deleted.
- Deleted when the core lands: the TS schema decoder, `design-ingestion.ts`, the TS `.canopi` write-admission (validity) mirror and encoder, and the four TS new-Design builders (the stamp file's `composeSavedObjectStampCanopiFile` is the fourth: the stamp file is built from the core's builder and the codec's per-entity serializers, and `STAMP_FILE_LAYERS` is deleted).
  - Also `app/document-session/write-admission.ts` (write exclusion: the TS write lanes map, `blockingWrites`, the replacement fence, `executeImmediately`, both prepared-destination brands and weak maps), replaced by the Session core write lane and the `canopi-support` target lock; `prepareDesignWriteDestination` and `prepareDraftWrite` in `ipc/design.ts`; Rust `with_write_admission`, `write_admission_key`, `WRITE_ADMISSIONS`, `write_derived_file` and `write_file_durably`.
  - Also `CanopiDesignIngestionErrorKind` and both `CanopiDesignIngestionError` types (`desktop/src/design/format.rs` and `app/contracts/canopi-design-errors.ts`) with their mappers; the core's admission refusals map once to `DesignLoadFailureKind` and its catalogue code.
  - `design-write-admission.test.ts` goes in the commit that adds the Session fast-check model test; the per-path tests move into a `canopi-support` property test (N interleaved publishes with mixed preconditions give one written per fingerprint generation, and the final bytes equal the last written). A name policy refuses `write_admission` and `WriteAdmission` identifiers.

## 11. Local-data migrations and the Web Drafts move

| Store | Kind | Floor (v2.0.0) | Chain home | Runs in |
|---|---|---|---|---|
| `.canopi` files, Drafts, stamp files | user work | 9 | `canopi-format` | the format worker on both editions; native for data on disk |
| settings record, Desktop and Web | user work | 1 (a 2.0 record has no version field and reads as 1, inside the chain; the v2.0.0 fixture is that unversioned record) | the settings field table: each step is data (add a field with its default, rename, drop, map a literal), and both editions' runners are generated from it (2.1-E6); a step that cannot be data moves the chain into `canopi-format` | native; Web, both generated |
| user DB (table shape only) | user work | 9 | `canopi-store` | native |
| saved-stamp payloads (`payload_json`, relative metre arrangements, not `.canopi`; type `SavedObjectStampPayload` in `canopi-types`, its TS type, version constant and frozen schemas emitted by `bindings-gen`; `canvas/saved-object-stamp-payload.ts`'s copies deleted) | user work | 2, the payload version each row carries; 2.1 adds the v3 step (guides, pinned names, locks, notes, species appearance, 2.1-Q155's care actions and species data; 2.1-M88), and a reader that meets a newer payload lists it as needing a newer Canopi and never places, writes or deletes it | `canopi-format`, run per row at open by each edition's stamp store (`canopi-store` on Desktop, a browser record on Web, 2.1-Q112); the store owns the library order (new rows take max + 1; `restore(row)` puts a deleted row back whole, with the same id, name, payload bytes, `created_at` and position, in one transaction; if a reorder ran while the toast was up, the row goes before the item that followed it, or at the end if that item is gone; reads return the ordered library); Web backend: IndexedDB `canopi-user-data` | native; wasm |
| library catalogue, Desktop and Web | user work | 25 | `canopi-library` repository | native; wasm in the Web library worker over OPFS (2.1-M151) |
| source `meta.json` | user work | 1 | `canopi-library` | native |
| Web 2.0 keys in `localStorage` (Drafts, stamps; read once by the first 2.1 steps, left unwritten for older tabs) | user work | 3, the container's own version | none: removed in 2.2 | TS |
| Web species-lists record (`platform/browser-record.ts`, its 2.1 key, frozen for the reader release (2.1-M23), capped at 50 entries) | user data | its first 2.1 version | `platform/browser-record.ts` | TS |
| Web settings record (`platform/settings.browser.ts` over `browser-record.ts`, synchronous boot read) | device state | 1 | the settings field table | TS |
| Web `canopi-user-data` database (stores `stamps`, key `id`, index `order`; `notebook`), owned by the saved-stamp and Notebook browser adapters, constructed with their `IDBFactory` | user work, not frozen for the reader release: kept unshown after a rollback (2.1-Q173) | the first 2.1 shape | its chain in `platform/store-chain.ts`, synchronous steps in `onupgradeneeded`; every write one readwrite transaction (max + 1 inside it) | TS |
| Service worker preferences (IndexedDB `canopi-sw`, store `prefs`, key `keep_catalog`: a boolean with a version), owned by the service worker; the page reaches it through the platform offline adapter over `postMessage` | device state, wiped on reset; the kill-switch deletes it with the catalog caches | none (no migration) | none | the service worker |
| Last open home, written by the Session core (Desktop: user DB beside Recent Designs; Web: a browser record) | device state | none | none | native; TS |
| display COG cache, previews, image cache | derived | none | none | wiped and rebuilt on a bump |

- One store chain (2.1-M157): `FLOOR`, ordered `STEPS`, `CURRENT = FLOOR + STEPS.len()`, so a bump without a step does not compile. Below the floor follows ADR 0021; newer is refused unchanged, except that the reader release reads a newer form of each store it froze (Rollback below).
  - `canopi-types::store_chain` holds the closed `StoreId` table, `Step`, `Chain{store, floor, steps, readsNewerUpTo}` and `admit` (Absent, BeforeFloor, Current, Migratable, NewerReadable, RefusedNewer); `platform/store-chain.ts` is its TS twin: a step returns the branded `StepDone` (an async step does not compile; a thenable settles `step-returned-thenable`) and runs synchronously inside `onupgradeneeded`, so a failing step leaves the store unchanged.
- Open lifecycle: opening, migrating, then ready, recovered{counts}, newer-read-only (a version at or above a form the reader release, or a further reader release, froze: it reads only the fields, tables and literals it knows, is shown and never written; Step 2.0.4, 2.1-M32), refused-newer, set-aside-damaged{file} or unavailable{code} (for settings, a reset field is ready with a notice, not a state): the `StoreOpenStatus` union in `canopi-types`.
- `SubsystemHealth` is a closed `StoreId` map to `{status: StoreOpenStatus, notice?: StoreNotice}`, generated in `canopi-types`. Store ids: `plant_catalog` (ready or unavailable{cause}), `user_db`, `settings`, `library_catalogue`, `web_drafts`, `web_records` (species lists and settings records), `web_user_data` (stamps and Notebook), `web_library`. Saved-stamp payloads have no id: their status is per row.
  - `StoreNotice = moved_aside_pre_2_0 (user_db) | fields_reset (settings) | write_failed`, each shown once and cleared on dismiss. The health model in `failures/` owns the one signal: Desktop pushes each change after the initial snapshot, Web adapters write to it, and a store version change re-runs that store's open. The status feeds the problem report.
  - Deleted: `LidarLibraryStatus`, `recovery::LibraryOpenStatus`, `PlantDbStatus`, `LocalDataStatus` and the three signals in `app/health/state.ts`.
- **Browser records.** Raw `localStorage` and `sessionStorage` only in `platform/browser-record.ts` (ast-grep `web-storage-only-in-adapters`, §18 F10; the pending-write marker and the first-paint theme key are the named exceptions, 2.1-M190): it holds the record runner, the keys, the `QuotaExceededError` to `quota_refused{store}` mapping, the `storage`-event `onExternalChange` and one `SubsystemHealth` entry per store with the bytes used. A store whose records grow uses IndexedDB.
  - A per-stamp payload cap is enforced in `canopi-format` payload admission on both editions (`stamp_too_large{limit}`), stated once in the ADR 0030 table, with a test that capture refuses one byte over it.
  - `web/browser-app-data.ts` and its partition table are deleted once Drafts reach IndexedDB; `canvas/saved-object-stamp-payload.ts`'s TS payload copy is deleted.
- Degraded stores: ADR 0026 (2.1-Q67). Opening never writes, per medium: SQLite keeps its main-file hash, a pre-existing `-wal` byte-identical, `user_version` and a canonical row dump (a created `-shm` or empty `-wal` is engine metadata; never `immutable=1`); IndexedDB keeps its canonical dump; one conformance case asserts each medium's predicate. Durable files go through `canopi-support`'s `publish_durably(source, target, role, Precondition)` behind the `DurableFs` seam; each writer's sidecar name is unique.
- A migration works on a copy and swaps it in durably once verified; the original is never half-migrated. SQLite steps run in one transaction on the copy and write their store's own version marker: `user_version` for the user DB, the `lidar_catalogue_meta` row `schema_version` for the catalogue.
- Settings (2.1-Q54): a bad value resets only that field; the original record is kept once as `settings.before-reset` (a user-DB row on Desktop; secret, never read by the app, replaced by the next reset) before the reset is written; writes are patches of changed fields; one fixture corpus in `canopi-types` runs through both editions' runners.
- Rollback: ADR 0026 (2.1-E4, 2.1-Q138, 2.1-M21). The reader release (Step 2.0.4) reads every 2.1 form and writes none, so each store migrates in place: no new homes, no unwritten previous forms, no kept copy of a replaced form. Desktop settings stay the user DB's `settings` row (2.1-M17). Kept for their own reasons: the `.canopi` pre-upgrade copy (2.1-Q35r), each migrated Desktop Draft's v9 form in `drafts/before-v10/`, the 2.0 Web Drafts key and a new Web key for settings and each record whose shape 2.1 changes (older tabs, 2.1-Q83).
  - In the reader release a newer Design opens in a read-only view outside the editing Session: no home and no Draft id; edit tools, Undo, Rename, Save and Delete off; no continuous save and no hide or pagehide flush; Close the only exit; a v10 Design is never handed to the 2.0 store or persistence paths.
- Tests: a fixture per store from each release tag; the chain runs from each to head; the rollback lane (Step 2.0.4) runs the readers on each 2.1 store step's output and finds it read and no byte written, built from the release candidate on the frozen fixtures until the reader release is tagged, then from the latest stable 2.0.x tag (2.1-M37); on a `release/2.0` PR or candidate, from that candidate, on the fixtures and on what `main` or a pending store step's branch writes (2.1-M68).
  - The D3 rollback test installs the latest 2.0.x stable release over 2.1.0's stores and finds each shown read-only, then the last 2.0.x before the readers (2.1-M33), which on Desktop refuses each 2.1 store unchanged and prunes no library file, and on Web keeps to its 2.0 keys and leaves every 2.1 record byte-identical.

**Web Drafts move to IndexedDB** (the first Web step):
- Object store `drafts`, key `id`; a record holds `id`, `canopi_version`, `version` (the `HomeVersion`), `name`, `updated_at` and the Design as `.canopi` text, read through the core's chain. Web settings carry the settings record's version (from 1) and species its own record version; the container version counts from 3. Settings and every record whose shape 2.1 changes move to a new key, leaving the v3 key to 2.0 tabs (ADR 0026 Rollback). Saved stamps get their own browser record (2.1-Q112).
- Persistent storage is requested on the first Draft with a one-line reason (existing unkept Drafts: the save-status warning's Keep my drafts, 2.1-Q198); if refused, the welcome screen and save status warn and offer Download a copy (2.1-Q82). Step 2.0.3 builds it on the localStorage store; the grant is per origin, so this store keeps it unchanged.
- A write gets, compares and puts the version inside one readwrite transaction; a mismatch is `conflict`. Writes are async. The Web lifecycle adapter reports hidden (`visibilitychange`) and `pagehide` to the core, and the core asks the Draft records to flush; the Draft records listen to no page event. The pending-write marker covers a write the page did not live to commit. A quota failure is `quota_refused{store: drafts}`.
- The step copies every Draft from the old localStorage key, refused ones included, each into its own record in one transaction. The comparison form is the canonical encode of each draft object: the old key holds parsed objects and a record holds `.canopi` text, so the copy writes the canonical encode and the read-back compares every id and its canonical encode with the record. The old key then stays unwritten, for tabs older than the reader release and as the lossy v10 step's 2.0 form; 2.2 removes it (2.1-M21). On a mismatch the failure is reported and the step runs again at the next open.
  - Staged move (2.1-M157): the copy transaction also writes `meta.move{state: copied, sourceHash, rev}`; the read-back runs outside any transaction through the format worker; a later readwrite transaction checks `rev`, re-reads the old key's hash synchronously and only then makes the records live; a mismatch or a moved `rev` leaves nothing live.
- The step runs whenever the old key exists, at open and on a `storage` event for that key, so a 2.0 tab that writes after the move is caught.
  - Each old-key id maps to at most one "copied from an older tab" Draft, kept in the store's id map with the canonical encode copied at the move. An id whose canonical encode equals that moved encode, or its existing copy, is skipped; the record's current content is never the comparison, because a 2.0 tab rewrites every id, including Drafts edited since in 2.1. Otherwise the first such write creates that id's copy and later writes update the same copy, so the user's original record is never overwritten, a 2.0 tab left open adds at most one Draft per id, and each copy is reported once.
  - A two-tab e2e (the last 2.0.x before the readers writing Drafts, settings, favourites and recently viewed after the 2.1 deploy, and a reader-release build holding the Draft store open) is in the Draft-store suite; the 2.1 records stay unchanged and the upgrade is not blocked.
- An old tab meets a newer database (Q40): on `versionchange` it saves, closes and shows the one "New version: Reload" notice (2.1-Q83). If that save fails, it keeps the Design in memory, offers Download a copy before the reload message and arms the leave prompt, then closes.
- The reader release lists this store's Drafts read-only through the format worker and hides an old-key Draft with the same id; it reads settings and the species-list record read-only from their 2.1 keys, and writes none of them. It checks the store exists with `indexedDB.databases()` (or aborts the upgrade at `oldVersion` 0), so it creates no database, and its connection follows Q40 below.
- While the upgrade is blocked, the new tab shows `draft_store_blocked` from the `blocked` event. An older build refuses a newer store with `draft_store_newer`.
- The pending-write marker is a `localStorage` entry per Draft id that follows the session's unacknowledged state: the Draft records expose a synchronous `markPending(id)`, which the Session core calls in the same task as the edit that makes `rev` exceed `ackRev` (once per clean-to-dirty transition, before any encode or hide flush is requested).
  - The store clears it when a committed write brings `ackRev` to `rev`. A marker found at open shows the notice naming the Draft whose last change may be missing, and the event is reported.
- The connection closed on `pagehide` goes back to opening on `pageshow` with `persisted` and on the next write.
- The store is constructed with its `IDBFactory`, so the fault suite injects quota and abort (Q47).
- Browser tests seed storage only through the adapters' exported keys and encoders, and seed a Draft by calling the real Draft-store adapter in the page (`e2e/support/web-storage.ts`; ast-grep `no-raw-web-storage-key-in-e2e`).
- The Draft-store suite covers each case above in Chromium, WebKit and Firefox.

## 12. Ratchet file and planted violations

One directory, `policy/ratchets/` at the repository root (2.1-M191), one JSON file per rule family, read by every fitness check. Phase 0's K builds the format, the comparison, the fail-closed loader, the planted-fixture runner and the adapters; F1a, F1b, F2, F3b, F3d and F4 register families into it (2.1-M186). Each step's owners file says who edits each family file (2.1-M26, 2.1-M73, 2.1-M95):

```json
{ "version": 1, "family": "l3-feature-scc", "ledger": "2.1-M186", "tool": "dependency-cruiser",
  "scope": ["desktop/web/src/app/**"], "lane": "commit", "keys": "name",
  "entries": { "app/lidar <-> app/shell": { "count": 1, "bead": "canopi-f47t.52.45" } } }
```

- `lane` is `commit`, `push` or `ci`; a count family holds `"count": n` instead of `entries`, and only jscpd clones are a count; its planted violation is compared with 0 (2.1-M231). A named family lists its violations, each entry `path: count` or a named edge, with an optional bead, and states its key kind in `keys` (`path`, `path-rule` or `name`; only path keys are drift-checked and renamed by `git -M`); a site in a file not listed fails even when the total falls (2.1-M222).
- The performance budgets are a `budget` family: each key a ceiling and a tolerance, failing only above the ceiling times one plus its tolerance (a fraction); `policy/ratchets/coverage.json` is a `floor` family: exclusion globs and per-tool floors, failing below a floor (2.1-M222). A tool is valid when its adapter `policy/adapters/<tool>.mjs` exists; `--list-rules` reads each policy table's top-level `rules` array of rows with an `id`.
- Tools and adapters: dependency-cruiser (its `--baseline` and `--ignore-known` output normalised here, never a second rule home), ast-grep with rule tests, oxlint (JSON to per-file entries, with `--report-unused-disable-directives` as an error), knip, jscpd,
  - clippy (item-level `#[expect(clippy::<lint>, reason)]` counted per file; a module- or crate-level `#![expect]` for a ratcheted lint is refused; `disallowed_methods` entries keyed by the method path the item calls, 2.1-M223); tsc (a `tsc-strict` family from a second tsconfig, normalised per file), cargo-deny, cargo-shear, the OSV scan and the file-size script (2.1-M58, 2.1-M188). `primitives.json`'s `tool` column names one of these; a tool without an adapter is refused (2.1-M189).
  - rustc's `missing_docs` on common-types goes through the clippy adapter: `#![deny(missing_docs)]` at the crate root and today's undocumented items each an item-level `#[expect(missing_docs, reason)]` counted per file, so a new undocumented item fails and a documented one drops its expect (2.1-Q217).
- Inline suppressions are one `suppressions` family (`path: tool:rule -> count`): every `oxlint-disable`, `#[expect]` (but a lint a clippy-tool family selects, such as `rust-too-many-lines` and `rust-missing-docs`, and `clippy::disallowed_methods`, the push-lane `disallowed-methods` family keyed by method, 2.1-M223), inner `#![allow]` (every lint, `cfg_attr` arms included; the outer form is denied by `clippy::allow_attributes`, 2.1-Q216), `ast-grep-ignore` and production `@ts-expect-error`; a directive naming no rule is refused; test `@ts-expect-error` is exempt (2.1-M187, 2.1-M274).
- CI fails when a violation is not listed or the count rises, and when a listed entry no longer occurs or the count falls without the file being lowered. So the file only shrinks and is never stale.
- Raising a baseline or adding an exception needs a commit naming a bead id and a ledger id. The pre-commit gate and its CI run resolve both from files only, never `bd` (2.1-M197): the bead exists in `.beads/issues.jsonl` and is open, and the ledger id is a Q row (a user decision) present in the ledger on the PR's merge base, so a branch-added row authorises nothing until its own PR lands (2.1-M195). An E or M row never authorises an exception or a raised baseline (ADR 0028).
- Gate modes: `pr` runs per commit over base..head on pull_request; `tree` runs on push to `main` with no message rules; a squash merge reaches its authority through the subject's PR number (2.1-M195). The one area-to-checks table lives in the gate script (2.1-M198).
- A new ratchet family lands green: its first baseline lists today's sites and its planted violation fails. The gate accepts that first baseline in the commit that creates the family when the commit names the family's ledger row, E and M rows included; the Q-row rule above covers raising an existing family's baseline or adding an entry to it (2.1-M40).
- An entry renamed with its file in the same commit, at the same or a lower count, the rename detected by `git -M` or named in the layer table, is a rename, not an added entry, and the gate accepts it without a Q row (2.1-M74).
- Guarded data files hold user-reviewed contracts; the gate refuses a change to one without a Q row in the commit. The `guarded-files` family is seeded with the coverage floors (`policy/ratchets/coverage.json`) and `desktop/capabilities/main-window.json` (2.1-Q225).
  - Each planned one joins in the commit that creates it: the ranking corpus in `canopi-types/species-search-ranking.json` (§15), the quantity table's precision columns (§14) and `canopi-types/edition-capabilities.json`. A capability row whose Decided id is not a ledger row fails `policy-tables-check`. The performance budgets are ratchet entries, guarded by the rule above.
- The test-deletion guard (ADR 0028) accepts a deleted test, or a removed or loosened `expect` in a kept test, only with a new test whose title the commit quotes (one per deleted test, with no fewer assertions), a Q row, or a `Retires-test: <title> — <why no user sees it>` trailer in a commit deleting the code under test (2.1-M282), none for a test whose only subject is a doc (2.1-M329). A title deleted and re-added in one commit is a move and passes; a reworded title passes with `Rewords-test: <old> -> <new>` when the new test is in the same file with no fewer assertions (2.1-Q224).
  - Loosened means fewer `expect` or assert calls in a test, a new whole-value equality on an expression covering the membership asserts on it that it replaces (2.1-M283), or a matcher swap from a closed list; regex at commit time, `vitest list --json` base against head in CI (2.1-M199).
- The policy inventory (`policy/inventory.json`) has one row per stated rule: `{id, doc, quote, state}`, where `quote` is an exact phrase `check_docs.py` finds in `doc`, and `state` is `exists{check}`, `planned{phase, bead}`, `advice` or `process`; a primitive rule's row holds only `{id, doc, quote}` and reads its state from `primitives.json` (2.1-M193).
  - `check_docs.py` fails when a quote is gone, when an `exists` check or a rule id an ADR or guide names is not in `policy-tables-check --list-rules` (the registry, never committed), and at a phase close when a `planned` row names that phase. A change to `advice` or `process` from `exists` or `planned` needs a Q row, held by the gate, and so does dropping a `rules.json` or `primitives.json` row or moving it from active to planned (2.1-M229).
- A rule's owner path follows the layer table's destination column, so a move in the table renames the owner in the generated rule (§18 F13 moves with `civil-date` in 2a).
- Each rule has a planted violation under the checker's fixtures. The test runs the real tool with the real config on it and asserts that rule's id fails. A rule without a planted violation fails the checker.
- The fail-closed checker also refuses a missing source table, a path that no longer exists, an unused exemption, a missing required rule, and a reporter that exits 0 with errors.
- The layer table (`policy/layers.json`, ADR 0022) is a source table like the others; each upward or cyclic edge it removes is a named ratchet entry, so exits are measured per edge.
- Rules added by the Q45 pass, each with its planted violation:
  - `no-hand-generation-guard` (controllers use the scope's `latest()`), `bare-catch-names-reason` (a bare catch reports or names its reason); search folds are §18 F18's `search-fold-only-in-search-text`;
  - `no-shell-breakpoint-media-query` (640, 480, 960, 760 px only through the shell's `data-layout` attribute), `no-reexport-only-types-module`, `no-inline-dialog-filters`, `no-hard-coded-import-extension`, `no-currency-symbol-table`, `number-format-only-in-utils`, `no-webmercator-literal`.
- Detached spawns (`tauri::async_runtime::spawn`, `tokio::spawn`, `tokio::task::spawn`) outside the executor and the runner's loop: a named ratchet from 4 to 0 at N1 (§18 R2); a spawned task is owned, its `JoinHandle` drained by the bounded drain.
- Class C07's `no-hard-coded-label` (Phase 1b, with its planted violation): a JSX text node, or a `label`, `title`, `aria-label` or `placeholder` attribute, holding a literal outside `t()`.

## 13. Contract suites (Q16)

Only where a fake carries behaviour or two real sides exist. The suite registry `policy/suites.json` (suite id, sides, test path), a hand-edited source table (2.1-M193), lists these rows; a check confirms each path exists.

| Suite | Sides |
|---|---|
| Runtime surfaces | the test fake and the real scene runtime, commands and queries together (`tools.arm` then the read-only tool, selection and revision bumps); the fake imports `sceneHasObjects` and the layer state from the scene module |
| RasterDisplay | `createFakeMap()` and the real layer manager, pool and worker |
| Session ports | the Desktop and the Web adapters |
| DesignHomeStore: Draft records | every case through the port's public methods, parameterised by kind and edition: Desktop files and Drafts with the `DurableFs` fault implementation; IndexedDB in Chromium, WebKit and Firefox with the injected `IDBFactory` and `Storage` (Q40, the 2.0-key move, the marker, quota and abort); case 5 once per kind and edition |
| Settings store | the Desktop and Web runners on one fixture corpus in `canopi-types` |
| Stamp store | the user DB and the Web browser record |
| Design Notebook store | the user DB and the Web browser record, keyed by Design home (N2) |
| catalog reader (outcome A: one reader in node, release lane, three browsers and the Desktop WebdriverIO suite; outcome B: both readers on one fixture catalog) | the real DuckDB reader and the native catalog commands, on one fixture catalog built by the production pipeline (a synthetic seed through `prepare-db.py`, then the Web generator; the Web generator alone once E1's switch deletes `prepare-db.py`, 2.1-M51) and the ranking corpus (§15); filters, options, names, cursor, browse order and photo attribution included. The reduced-catalog fake is deleted |
| Species user lists | the Rust `user_db` store and the Web browser adapter: cap 50, oldest dropped first; re-viewing moves a species to the top without a duplicate; newest first; a favourite toggle is idempotent; both adapters on one fixture; shared lifecycle cases (quota, degraded, cross-tab, newer) generated from one fixture table, also for saved stamps and the Notebook; an ordered-calls case (two un-awaited applies, then a read) |
| LiDAR transcripts (replaces the LiDAR facade row) | the real commands through the `fixed_library_tests` mock app write `editions/gallery/fixtures/lidar/*.json` in check mode; the gallery replays them, and the freshness check fails on drift; `engines` and `LidarEngineStatus` are deleted |
| Redaction | one tagged corpus `canopi-types/fixtures/redaction/` (`shared` and `native_only` cases): Rust runs all, TS the shared ones; properties: idempotent, no planted secret or path survives, never throws on arbitrary UTF-8, the TS path pattern stays linear; input capped before scanning and redacted before truncation; a redactor that throws stores `redaction_failed`; Rust owner `canopi-redact` (`Redactor::generic()`, `with_roots(..)`, `redact(&str) -> RedactedText`), TS owner `failures/redact.ts`, which redacts only frontend-origin text; `Failure.detail`, log fields and report inputs take only `RedactedText`; a ring entry is `{origin: native, detail: RedactedText} \| {origin: frontend, text}` |
| Native scheduling | the Rust executor and the TS transport on shared fixtures |
| Failure report | the one TS builder over the Desktop native-sections command and the Web adapters on a shared fixture (ring level typed `FrontendDiagnosticLevel` from `canopi-types`); manifest equals zip on both editions; a section the edition lacks is marked not on this edition |
| Format core | the TS edit-time predicates (group normalisation among them) and the core; the core natively and through the real worker on the corpus |
| Data library port (N5) | the Desktop adapter over the library commands and the Web adapter over the library worker (SQLite on the OPFS pool, a child engine worker): import, list, delete, display, sample, profile and the terrain analyses on one fixture set, the analysis goldens equal on both; submit, progress, cancel while Queued, cancel while Running, cancel while Settling (ignored), Delete refused while a job reads the item, Dismiss plus janitor, a reopen after an unfinished job showing Interrupted with Run again; a subscription sending the current state first and then each change in order; settlement to succeeded, failed{code}, cancelled or interrupted; stored files equal to the listed items after a failed or cancelled import and after Delete, on both adapters; display: both adapters Ready, the real worker handler renders one fixture tile equal on both, the key is stable, a deleted item gives Gone, a regenerated item gets a new key; Web: a killed worker keeps the last committed state, "Use here" settles the old holder's running job Interrupted, no OPFS answers `library_storage_unavailable` |
| Geocoding transport | both adapters (invoke and fetch faked) on one fixture give the same match order and scores, and the same code for 403, 429, timeout, oversize and an empty or malformed body |
| FileDelivery | both adapters and a fake: cancel, an abort mid-dialog, every kind and suffix, a refused wrong extension; a wire test asserts the binary body |

**Gallery bindings.** The gallery root builds a complete `EditionPorts` record, installs it once, calls `installAppLifetime(ports)` and the key router. Binding class per port, never per bootstrap:

- Compute ports (the design core, page rules) bind their browser adapter.
- Storage ports (DesignHomeStore, settings, saved stamps, Notebook, species user lists, Recent Designs) bind their browser adapter over an in-memory backend at the adapter's fault seam.
- Native, network and host ports (picker and file access, FileDelivery, geocoding transport, problem report, app lifecycle, window control, species reader) bind a recorder or fixed-result fake in `editions/gallery/fakes/<port>.fake.ts` written `satisfies Port`.
- The Data library binds a transcript-replay fake over the JSON `fixed_library_tests` writes, one method as one command with `Reply<K>`. Fallback if the Data library cannot be one method per command: its fake is the Desktop library adapter over a transcript `NativeHost`, with one named exception to the gallery-graph rule.
- `?edition=desktop|web` picks one generated capability set. A `?state=` seed is an ordered list of calls to the bound ports' public write APIs. A replay miss returns typed `unavailable` ("gallery: no transcript for X").
- The gallery graph contains no `ipc/`, `@tauri-apps/*` or `*.desktop.ts`. Deleted with the root: the 7 gallery aliases, `memory-backend.ts`, `memory-dialogs.ts`, `canvas-pdf-platform.ts`, `budget-export.ts`, `GalleryCanvasSurface.tsx`, the 29 `vi.mock(ipc)` sites (ast-grep `no-vi-mock-of-ipc-or-platform`).

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
- **Normalisation** has one implementation, `canopi-search-text` (ADR 0023), built from `species-search-normalization.json`: Desktop links it natively for queries and the SQLite function, the catalog build calls its key CLI, and the frontend calls `canopi-page-rules-wasm` through `platform/page-rules.ts` in the page wherever search and the in-Design finder run. Hiragana folds to katakana (`りんご` finds リンゴ). The Python and TS algorithms and their 9,228 lines of generated tables are deleted.
  - The shared corpus is the crate's oracle, run natively and through the wasm, and grows to ligatures, other scripts and every locale. A failed wasm load reports once and search says it is unavailable.
- **Filter options.** `plant-filter-fields.json` holds each closed filter's ordered `values` (climate zones added; habit is Desktop's four values on both editions, 2.1-Q59; life cycle and soil tolerances derived from their clauses), each shown with the interface glossary word from the locale files (2.1-Q55). Both readers return that list filtered by one rule (values present in the catalog); `species_catalog_contract.py` refuses a catalog value missing from it.
- **Web catalog.** It carries every field, filter, photo and fact Desktop has, read on demand by range requests (2.1-Q113); photos are one fixed-width Commons rendition on both editions, and a Desktop cache failure shows the failed-photo state (2.1-Q109).
- **Manifest.** One TS module, `admitWebCatalogManifest`, over constants `bindings-gen` emits from the artifact contract JSON; `web_release.py` and the generator tests run it through node, and the Python render step and the generator-to-generator calls are deleted.
  - The catalog manifest is an immutable content-named file; each release's page bundle carries its name beside the contract fingerprint; the edition manifest lists it for upload and service-worker install but is never used to look it up.
  - Tests: a `test_web_release` case refuses a catalog manifest whose name is not content-versioned; the deploy-skew e2e's N-1 tab admits N-1's catalog manifest after N deploys.
- **Reader outcome.** Outcome A of 2.1-E1: one reader at `desktop/web/src/catalog/` (`reader.ts`, `duckdb-worker.ts` the only importer of `@duckdb/duckdb-wasm`, rule `duckdb-only-in-catalog-reader`) serves both editions; the roots supply `CatalogSource {manifestUrl, workerUrl}` in `EditionPorts`; the generator emits one dialect; `catalog_unavailable{cause: missing, schema_mismatch, corrupt, engine_load, byte_source}` and `catalog_query_failed`.
  - Outcome B: `platform/species-reader.ts` over two readers and two dialects, each with a drift test.
  - Both: `search(request, signal)` with the `AbortSignal` driving a generation token and `cancelPendingQuery`; `status: ReadonlySignal<'ready' | {unavailable: code}>` replaces `whenPlantDbAvailable`; name lookups reject on failure; favourites and recently viewed join in TS over `platform/species-lists.ts` (`withFavorites(rows, set)`), and search never depends on the user DB.
- **The corpus** (2.1-Q48): per locale, real queries with the best result first, plus empty-query rows for the Recommended browse, seeded from today's Desktop with wrong-first rows corrected to what the user expects (the prototype's side-by-side tables beside it), reviewed by the user once. A changed row names the user's dated decision. It runs on the one fixture catalog (§13) natively and through DuckDB, and checks that each top result's marks fall on word starts of the entry that matched. Fakes and the gallery return fixed results in the corpus order and never rank.

## 16. FileDelivery rows and file kinds

- `platform/file-delivery.ts` (L1) `deliver(row: {content, stem, kind}, signal) -> Promise<'saved' | 'downloaded' | 'cancelled'>`; a cancel is a result, never a throw; a failure goes through `reportFailure`. `content` is `{bytes: Uint8Array} | {text: string} | {native: LibraryItemId | OperationId}` (library results written host-side).
- Desktop adapter: the host save dialog (filters from the file-kind table) returns a `FileGrantId`, then one `deliver_file(grant, kind, body)` command writes the file, bytes as a raw binary IPC body through `ipc/bytes.ts` (2.1-M154), the extension rule held host-side (a missing extension appended, `exists` refused when the appended name exists, 2.1-M155); `save_canvas_pdf` and `export_file` become this command.
- Web adapter: a Blob download; a native-source row is refused unless an ADR 0030 row says otherwise. Deleted: `#canvas-pdf-platform`, `#budget-export-platform`, `PdfDelivery`, `ipc/export.ts` `exportFile` and the per-feature platform files.
- A row is `(content, stem, kind)`. One file-kind table (canopi, geojson, pdf, csv, geotiff: extensions, MIME types, label key; geotiff is `.tif, .tiff`, `image/tiff`, its label key) feeds every FileDelivery row, the Desktop dialog filters (TS and Rust `pick_geojson_file`, which takes the extensions from its caller) and the Web `accept` strings.
- The port's shared core owns the one sanitiser, the one replacement character and the one localised fallback stem (`Untitled` through `t()`); the stem comes from `fileStem` (§4). The five local sanitisers are deleted.
- A library-result GeoTIFF carries its provenance in a TIFF metadata tag, so every row stays one file; on Desktop its content is the item's id, written native-side.
- Test: one table per edition over every kind and suffix, the budget CSV's `-budget.csv` and the library GeoTIFF included (2.1-Q100).

## 17. Species lists inside the app

- Every plant list on both editions (Find plants, Web and Desktop favourites, recently viewed) ranks through `findPlants`, which applies the match rule and tiers of `species-search-ranking.json`, emitted to TS, over `platform/page-rules.ts` keys (§18 F18), and has no tier logic of its own: best match first, ties in list order. It joins the ranking corpus suite (§15) for in-list rows. Non-plant lists (calendar, Start screen, Drafts) share one text filter over the same normaliser. `utils/normalize-search.ts`, the Start screen fold and `filterFavoriteSpecies` are deleted.
- Favourites and recently viewed: cap 50, oldest dropped first, newest first, one row per species, the cap stated here once (§13 suite). A shared constant only if the cap becomes a setting. A species is recorded as recently viewed once its detail has loaded, once per opening (2.1-Q102).
- Every Design species list and legend without a query is alphabetical by the shown name, collated in the interface language, the Latin name breaking ties (2.1-Q94); one species-legend builder serves the panel, the canvas legend and PDF.

## 18. Primitive owners

Each raw primitive a second copy would use has one owner and one rule (ADR 0028), landed in Phase 0 (but the rules named below) as a shrink-only ratchet whose baseline is the count measured on `main` after the 2.0.3 tag and F0's toolchain upgrade (the counts below are sites / files at 2.0.1, references only, 2.1-M39, 2.1-Q141); the ratchet reaches 0 in the last phase or stream named.

F35, F36 and F29's ToolHost owner test have no Phase 0 count: each lands as a new family of today's sites at its stream's start (2c, 2m, 2c), failing on its planted violation (§12, 2.1-M40); F28's `wasm-glue-only-in-adapter` lands with each `-wasm` crate (ADR 0022), since Phase 0 has no glue to guard (2.1-M77). A rule's failure message names its owner and a canonical example.

Source table: `policy/primitives.json` (family, primitive, `owner_today`, `owner_target{path, phase, bead}`, rule id, `tool`, canonical example module, ADR; 2.1-M189); the generated dependency-cruiser, ast-grep and clippy messages, and `clippy.toml`'s reasons, read owner and example from it.

- The checker requires `owner_today` (an existing path, or `none` for 0 allowed sites) and the example to exist, refuses a tool with no adapter (§12) and, run with `--phase-close <phase>`, fails a row whose `owner_target` phase is that phase or earlier while `owner_today` differs from its path; a row whose owner is not built yet (the command table, `editions/*`) carries `"status": "planned"` and generates no rule until its phase (2.1-M223). Required rules are `policy/rules.json` rows; a row naming a family requires that family file. Rule ids live only in this table and `rules.json`.
- Each R row carries its exact matcher, and its baseline is the matcher's output. Each cargo-deny crate ban is its own rule id, landing with its crate (N1, N2), and `deny.toml` is checked to hold a `[bans]` entry citing each cargo-deny row.

| # | Primitive | Owner | Rule | Baseline | Phase |
|---|---|---|---|---|---|
| F1 | Tauri `invoke` | `ipc/` generated `invoke<K>` | `invoke-only-in-ipc` | 2 / 2 | 2a |
| F2 | Tauri window, dialogs, `convertFileSrc` | the `platform/*.desktop.ts` adapters: file access (dialogs; 2.1-M12), display resolution in the Data library port (`platform/library.ts`, 2.1-M132) and window control | `tauri-only-in-native-host`, `ipc-only-in-desktop-adapters` (2.1-M143) | 9 / 8 | 2a, 2b |
| F3 | Notices and toasts (plugin-dialog `message`) | the `failures/` notice signal, its one notice row and one window-level toast slot | `notice-only-in-failures` | 2 / 2 | 1b, 2a, N2 |
| F4 | `new maplibregl.Map`, style readiness | `maplibre/map-lifetime.ts` and its factory | `map-constructor-only-in-factory`, `style-load-only-in-map-lifetime` | 3 / 3; 12 / 5 | 2d |
| F5 | `addSource`, `addLayer` and removals | each workspace map contribution | `map-sources-only-in-contributions`; the `ownsResource` contract | 1 / 1 outside | 2d |
| F6 | `maplibregl-*` classes, the MapLibre CSS | `maplibre/` constants and import | `maplibre-class-only-in-maplibre` | 7 / 3; 2 / 2 | 2c, 2d |
| F7 | Tile hosts, the Maps key | the `maplibre/` providers, the key from the settings slice; origins from `policy/origins.json` | `google-key-only-in-reviewed-readers`, `google-key-urls-only-in-satellite-provider`; CSP origin table | 1 / 1; key readers 2 | 2d, 2e |
| F8 | `pixi.js` | `canvas/runtime/renderers/` and the Pixi kit | `pixi-only-in-renderers` | 3 / 1 | 2a |
| F9 | Renderer module state | the scene runtime snapshot | `no-renderer-module-state` | listed in ADR 0024 | 2c |
| F10 | `localStorage`, `sessionStorage`, `indexedDB` | Web storage: `platform/browser-record.ts` (`owner_target`; exceptions the pending-write marker and the first-paint theme key); IndexedDB: the Draft-store, settings, stamp, species-list, Notebook adapters and the library worker's lock and port; the service worker is the only owner of the `canopi-sw` database | `web-storage-only-in-adapters`, one id with two patterns (2.1-M190) | 12 / 3 | 2b, 2e |
| F11 | `Intl.NumberFormat`, `toFixed`, currency symbols | `utils/format.ts` | `number-format-only-in-utils`, `no-currency-symbol-table` | 56 / 31 | 2a, 2c |
| F12 | `Intl.PluralRules` | `i18n/` | `i18n-completeness` (exists) | 0 | none |
| F13 | `new Date(str)`, `Date.parse`, date display | `app/timeline/civil-date.ts`, moving to `planning/civil-date.ts` in 2a through the layer table | `date-only-in-civil-date` | display 12 / 5; parse 38 / 12 | 1b |
| F14 | `navigator.clipboard` | `platform/clipboard.ts`, an adapter with no port | `clipboard-only-in-adapter` | 3 / 2 | 2a |
| F15 | `fetch` | the purpose owners (geocoder, map providers, species reader, PDF fonts, the Web release watch `web/browser-release-watch.ts`); `platform/geocoding.ts` `pageFetchJson` is the geocoder's only `fetch`; every origin in the origin table; `app/design-template-import/workflow.browser.ts` a named entry until 2a deletes Web Templates (2.1-Q24) | `fetch-only-in-owners`; the CSP origin table | 6 / 6 | 2a, W1 |
| F16 | `new Worker` | the module that starts each worker | `worker-only-in-owner` | 0 outside | 2b |
| F17 | DraftId, OperationId, other ids | the Session core; the dispatcher, ToolHost commit and panel submit; `utils/ids.ts`; transport sequence numbers never exported | `ids-only-in-minters`; ast-grep `no-correlation-field`: no correlation or seq field in `Failure`, ring entries or log fields except `operation`, `job_id`, `item_id` | 12 / 4 | 1b, 2b |
| F18 | Search folds (`normalize('NFD')`, fold tables) | `platform/page-rules.ts`: the one TS normaliser in 2a, over `canopi-page-rules-wasm` from N4 | `search-fold-only-in-search-text` (NFC and non-search NFKD uses allow-listed) | 4 / 3, and 3 TS copies | 2a, N4 |
| F19 | Web Mercator formulas and constants | the constants and WGS84 radii in `canopi-types`, emitted by `bindings-gen`; the formulas in `geo/web-mercator.ts` and the Rust `crs` leaf | `no-webmercator-literal` | 2 implementations | 2a, N1 |
| F20 | Module-level `effect(` | `installAppLifetime` and the Design scope | `no-module-effect` | 8 / 7 | 2a, 2b |
| F21 | `sessionIdentity` reads | `core.onDesignOpened` | `no-session-identity-watch` | 88 / 30 | 2b |
| F22 | Hand-written request counters | `latest()` in the scope module | `no-hand-generation-guard`, extended to `app/document-session/` | 10 controllers | 2b |
| F23 | `console.*`, bare `catch`, window hooks | `failures/` `reportFailure` | `console-only-in-sink`, `bare-catch-names-reason` | 46 / 30; 72 | 1b, each moving stream (0 at Phase 3) |
| F24 | Redaction | `failures/redact.ts` (frontend-origin text); `canopi-redact` natively | the redaction corpus; ast-grep `credential-literal-only-in-redactors`: no credential-name literal or path regex outside the two owners | TS redactors 2 to 1, native detail never re-redacted | 1b |
| F25 | Layout breakpoints | `app/shell/phone-layout.ts` (`data-layout`) | `no-shell-breakpoint-media-query` | 11 / 11 | 2a |
| F26 | Dialog filters, sanitisers, downloads | the FileDelivery rows and file-kind table | `file-delivery-rows`, `no-inline-dialog-filters` | 7 / 5; 5 sanitisers | 2a, N2 |
| F27 | Import extensions | the generated accepted-format list | `no-hard-coded-import-extension` | 1 / 1 | N3 |
| F28 | `.canopi` decode, encode, `CanopiFile` literals | `canopi-format` through the design-core port | `no-canopifile-literal`, `wasm-glue-only-in-adapter` | 4 TS mirrors | Step 2.0.4, 2b |
| F29 | The active tool and armed source | `_tool` through `tools.arm(id, source, request?)`, the only owner of the active tool and its armed source; `armCanvasTool` (`app/keyboard/arming.ts`) the only app caller, plus the runtime's drop path; tool rows in `app/command-table/tools.ts` (`TOOL_ROWS`, `ToolId`, `isToolId`), where `CommandOrToolId = CommandId \| ToolId` is declared; map input requests settle once: picked, cancelled{reason: escape, tool-change, design-closed, superseded} or detached; `pinAt` and `finishProfile` deleted | the ToolHost owner test; `tool-arming-only-in-arm-canvas-tool`; ast-grep `tool-id-literal-only-in-rows` (context pattern; today's owner `canvas/runtime/tool-id.ts`) | 47 / 16 (production 38 / 15) | 2c |
| F30 | Highlights | the canvas | `plant-highlight-only-in-canvas` (ast-grep) | 2 MapLibre overlay files | 2c, 2d |
| F31 | Settings-owned values | `app/settings/` signals through `patchSettings` | `settings-no-upward`, `patch-settings-only-in-field-owners` | 13 / 6 | 2e |
| F32 | `role`, `provenance` reads | the descriptor's lineage table | `no-lineage-field-read` | 44 / 12 | N3 |
| F33 | Zone shape decoding | the zone kernel | `zone-decoding-only-in-kernel` | 22 | 2c |
| F34 | `keydown` listeners | `app/keyboard/key-router.ts`; focus-owned text entry | `key-listener-only-in-key-router` | 2 / 2, both owners | none |
| F35 | Unit conversion constants and maths | the quantity table and `utils/format.ts` | `unit-maths-only-in-quantity-owner` | counted at 2c's start | 2c |
| F36 | Ground scale: Earth radii, latitude-based scale, zoom to pixels per metre, shown lengths and areas | the session plane in `geo/` (§20) | `scale-only-through-plane`; `PlanePoint` and `ConformalPoint` brands | counted at 2m's start | 2m |
| F37 | In-process TS serialisation | the closed owner set: the Session core write lane, settings persistence (`app/settings/`), `app/record-workbench/` (`createRecordWorkbench<Snapshot, Command>(port, scope)`), the Site data sampler lanes, display admission (`app/data-library/display.ts`) | ast-grep `serial-lane-only-in-owners` (self-reassigned promise tails, `.then(run, run)` when self-reassigned, awaiting `while (a \|\| b)` drains); a sixth owner is a design decision recorded here | counted when the rule lands | each owner's stream |
| F38 | Analysis parameter rules | `canopi-types` (`ParamInput`, `ParamError`, `RequestShapeError`, `check_request`, `resolve_request`), reached through the page-rules wasm (`platform/page-rules.ts`) and the library facade | ast-grep `no-param-rule-in-ts`; boundary corpus `canopi-types/fixtures/analysis-requests.json` run natively and through the real page wasm; `every_param_kind_has_cases` | 1 implementation | N4 (and 2c's first use) |
| F39 | lon/lat point type | `GeoPoint` (generated) | ast-grep `single-lonlat-point-type`: no other `{lon, lat}` or `[lon, lat]` point type (Phase 0 F4, 2.1-M212) | about 17 hand sites; `GeoPosition`, the site-overlay tuple | F4, 2a |
| R1 | `tauri::`, `AppHandle` | `canopi-desktop` | `tauri-only-in-shell`; cargo-deny | 6 / 4 | N1 |
| R2 | `thread::spawn`, `spawn_blocking`, `rayon`; detached spawns (`tauri::async_runtime::spawn`, `tokio::spawn`, `tokio::task::spawn`) | `blocking::run` in `canopi-support`; the executor and the runner's loop, each `JoinHandle` drained by the bounded drain | clippy `disallowed-methods`; `BLOCKING_ESCAPE_ALLOWLIST` (exist); detached spawns `detached-spawn-only-in-executor` (ast-grep until N1, 2.1-M275) | 0 outside; detached spawns 4 / 2 | N1 |
| R3 | Executor calls in commands | facade methods with their `OpSpec` | `native_command_policy` | 81 / 10 | N1 |
| R4 | Library SQL, `rusqlite` | the `canopi-library` repository | `sql-only-in-repository` | 147 / 9 (100 SQL literals, 47 `rusqlite` paths) | N1 |
| R5 | `format!` SQL, `value_*` columns | generated queries | `no-formatted-sql` in every crate; the drift test | 33 / 7 | N2, N4 |
| R6 | User DB SQL | `canopi-store` | `user-db-sql-only-in-store`; cargo-deny: no catalog-store edge (with the crate) | 2 / 2 | N2 |
| R7 | `CanopiFile` decode and write | `canopi-format` | `canopi-decode-only-in-format`; cargo-deny | 0 | 2b |
| R8 | `fs::write`, `rename`, `copy` of a published path | `publish_durably` behind `DurableFs` (from 2b, 2.1-M28) | `durable-write-only-in-publish` (ast-grep until clippy `disallowed-methods` in 2b, N1, 2.1-M275) | 25 / 10 | 2b, N1 |
| R9 | `remove_file`, `remove_dir_all` | the janitor | `janitor-only-deletes` | 45 / 10 | N1, N2 |
| R10 | `sha2`, hashers | `canopi-support` hash | `hash-only-in-support`; cargo-deny `wrappers` (with the crate) | 15 / 7 | N1 |
| R11 | `SystemTime::now` | `canopi-support` time | `wall-clock-only-in-time` (ast-grep until clippy `disallowed-methods` in N1, 2.1-M275) | 16 / 8 | N1 |
| R12 | `proj4rs`, EPSG codes | the `crs` leaf | `crs-only-in-crs` | 9 / 5 | N1 |
| R13 | `Result<_, String>` | the failure catalogue | `no-string-error-command`, widened to `From<String>` | 67 / 14 (65 commands, 2 `From<String>`) | 1a, 2b, 2e, N1, N2 (0 at Phase 3) |
| R14 | `"cancelled"`, `check_cancel`, flags | `CancelToken`; `SpeciesSearchCancellation`, `supersede_species_search` and `SPECIES_SEARCH_CANCELLED` deleted, replaced by `supersede_key` "species_search" (N4) | `no-cancelled-literal` | TypeScript 40 / 6 (2.1-M268); Rust 46 / 15 (8 `"cancelled"`, 33 `check_cancel`, 5 `cancel.load`; 2.1-M275) | 1a, N1 |
| R15 | `warn!`, `error!` | the failure logger | `tracing-warn-only-in-failure-logger` | 71 / 21 | 1a, each moving stream (0 at Phase 3) |
| R16 | `reqwest` and other clients | `canopi-support::http` (`http.rs`, `HttpPolicy`), which also takes `image_cache.rs`'s direct `ureq::get`; `geocoder_fetch(url)` (a `canopi-desktop` command, https only, hosts from `GEOCODER_IDENTIFIED_HOSTS`, 5 s, 1 MiB, body verbatim); named exception: `host/updater/` through tauri-plugin-updater, whose own client is configured from `HttpPolicy` (`configure_client`) rather than replaced, covered by the updater e2e (N-1 to N, tampered payload, old-but-signed payload; 2.1-M210) | `http-client-only-in-http`; a policy test holds the exception list to that one entry | 4 / 1 | N1, N2 |
| R17 | `Command::new` | `canopi-support::process` (the tool runner); `FolderRevealer` goes to the opener in F5 (canopi-zhv0); named exceptions: `host/updater/`'s `pkexec dpkg -i` and the plugin's Windows installer launch (2.1-Q232, 2.1-M210) | `process-only-in-runner` (ast-grep until clippy `disallowed-methods` in N1, 2.1-M275) | 3 / 1 | N0, N1 |
| R18 | Search folds | `canopi-search-text` | the shared corpus | 6 implementations | N4 |
| R19 | Locale lists, `sys_locale` | the `canopi-types` registry | the consistency test | 1 | 2a, 2e, N2 |
| R20 | `wasm_bindgen` | the `-wasm` crates, each created in its phase | cargo-deny | 0 | Step 2.0.4, N4, N5 |
| R21 | App data paths, `dirs::` | `app_folders`, the library paths, the Drafts directory; homes as crate::module: image cache `canopi-catalog::image_cache` (or `canopi-desktop` under E1 outcome A), recent previews `canopi-store::recent`, problem report and app folders `canopi-desktop::compose` | `no-path-string-command-arg` (§1): the generated command map carries no `path: string` except `UserPath` display fields | 36 / 10 | N2 |
| R22 | `catch_unwind` | the executor settlement (`native_operation.rs`), its own reason; `bindings-gen`'s test site (`publication.rs`, inside its `#[cfg(test)]` module) an item-level `#[expect(clippy::disallowed_methods, reason = ...)]` on its test function, counted in the `disallowed-methods` family, never an `#[allow]` (2.1-Q216, 2.1-M187, 2.1-M188, 2.1-M189) | clippy `disallowed-methods` | 1 | none |

F37 deletes `app/mutation-queue.ts` and its `lifetime`, `epoch`, `tail`, `bumpLifetime`, `bumpEpoch`, `isCurrent`; the workbenches' duplicated load, barrier and refresh code, generation counters and mirror patches; settings `requested`, `drainPromise`, `draining`. Each owner has a fast-check model suite.

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
  readonly anchor: GeoPoint;                       // the objects' bounds centre, or the view centre
  readonly axisScale: { ax: number; ay: number }; // N0·cosφ0 and M0, per Mercator unit
  toPlane(p: GeoPoint): PlanePoint; toGeoPoint(p: PlanePoint): GeoPoint;
  toView(p: PlanePoint): ConformalPoint; fromView(p: ConformalPoint): PlanePoint;
  pixelsPerMetre(zoom: number): { x: number; y: number; mean: number };
  groundLength(a: PlanePoint, b: PlanePoint): Metres;          // the local factor applied, < 1 ppm on 10 km
  groundArea(ring: readonly PlanePoint[]): SquareMetres;
  trueNorthAt(p: PlanePoint): Radians;                         // plane north to true north, clockwise
}
```

- `GeoPoint` (generated from `canopi-types`) is the only lon/lat point type; no other module declares a `{lon, lat}` or `[lon, lat]` point type. Phase 0 F4 lands that rule as a family and replaces the two local duplicates (`app/lidar/site-transients.ts`, `canvas/runtime/view/types.ts`); `GeoPosition` (`canvas/session-plane.ts`) is deleted in 2a; the GeoJSON position in `maplibre/site-overlay.ts` is written inline as `readonly [number, number]`, never aliased (2.1-M307).
- Brands land with their first consumer, never in Phase 0 (2.1-M212): `PlanePoint`, `ConformalPoint`, `Metres` and angles in 2m, ids in 2a, `OperationId` in 1a, each generated from its Rust newtype by specta's `branded!` (present in the pinned 0.0.10; the specta bump is its own later release set).
- The plane is an exact affine image of Web Mercator; the view transform is the camera similarity on `ConformalPoint` composed with diag(1/ax, 1/ay). A frame change is a plane method; no other module multiplies by `cos(lat)`, takes a latitude to convert a zoom, or holds an Earth radius.
- Every length and area the user reads (chips, guides, PDF text, the profile length, a row's count from its spacing) is `groundLength` or `groundArea`, then `utils/format.ts`. A shape sized on the ground draws and hits through the affine; a mark sized in pixels uses pixels; `pixelsPerMetre(zoom).mean` serves sizes and tolerances only.
- `trueNorthAt` is the one owner of north on the plane (2.1-M91): 0 for this Mercator-based plane, whose meridians are straight, but every reader asks it, never assuming plane-up. It serves plane consumers only (the PDF page north arrows, 2.1-Q151, and any plane-drawn overlay).
- One solar-position owner in the engine takes a UTC instant and WGS84 lon/lat and returns true azimuth and altitude (2.1-M167). The timed overlay and every sunlight analysis read it; no second solar-position code exists. Whether whitebox's shading core is used or copied (ADR 0002), its `solar_pos`, almanac, azimuth binning, fixed year and longitude-inferred UTC offset are not used: sun positions come from the owner.
  - A day's samples span that date's whole sun-above-horizon arc at the site, so no zone or fixed offset sets a day boundary. Hours of direct sun are sunlit samples x step, never a fraction x a day length.
  - The clock the user sees (the site's legal time, the device's or solar time) is the sunlight design check's question (plan After the foundations); whichever it is, it only converts the UTC instant for display.
- A sun azimuth applied to a raster in its own CRS is the solar position's true azimuth minus that raster's `crs` grid convergence at the site (`grid_convergence`, ADR 0023), read by the sun engine adapter; tested against IGN's published Lambert-93 convergence at a few points.
- 2m lands `trueNorthAt`; `scale-only-through-plane` also fails on a north derived outside it.
- Re-origin builds a new plane with its own factor; objects re-hydrate from lon/lat, and the 1e-9° write-back rounding stays idempotent.
- Fixtures build their view through the real plane or name `conformalFixturePlane` explicitly; none assumes a similarity at latitude 0.
- Tests: a stored lon/lat lands on MapLibre's pixel to 1e-6 px at 0°, 49° and 65°; `groundLength` and `groundArea` against a WGS84 Vincenty reference within 1 ppm over a 10 km site; a rotated 100 m square at 49° keeps its sides to 1 cm and its corners to 5″; re-origin idempotence; `scale-only-through-plane` fails on a planted `cos(lat)` scale.

## 21. Object-action matrix

2.1-Q147, 2.1-M86, 2.1-M163, 2.1-M164. `app/command-table/object-capabilities.ts` (L2, beside the command descriptors; it imports no feature, ADR 0022) holds the matrix as data; the audit's 28 kinds by 57 capabilities seed it (gate-logs `capability-matrix.md`).

```ts
type ObjectKind = (typeof OBJECT_KINDS)[number]['id'];      // plant, zone-rect, …, pdf-page-furniture
type Capability = (typeof CAPABILITIES)[number]['id'];      // select, move, edit-by-values, …
type Cell =
  | { state: 'yes'; via: readonly CommandOrToolId[] }   // CommandOrToolId: app/command-table/tools.ts
  | { state: 'partial' | 'no'; gap: BeadId }
  | { state: 'partial' | 'no'; decision: LedgerOrAdrId }    // a deliberate exception
  | { state: 'n/a'; reason: string };
// app/command-table/object-capabilities.ts (L2; type-only imports; imports no feature)
type ObjectOwner = 'scene' | 'document' | 'data-library' | 'map-layer-store' | 'stamp-store' | 'tool-session';
type Backing =
  | { field: DesignFileFieldKey }                    // owner = DESIGN_FILE_FIELDS[key].owner
  | { sceneTarget: SceneDesignObjectTarget['kind'] } // owner = 'scene'
  | { printSetup: PdfPageKind | 'setup' }            // owner = 'document' through print_setup
  | { store: 'data-library' | 'map-layer-store' | 'stamp-store' }
  | { transient: 'tool-session' };                   // never persisted
interface ObjectKindRow { id: string; backing: Backing; references?: readonly Backing[];
  requires?: readonly EditionCapabilityId[] }        // site-data-entry, analysis-result, profile-line:
                                                      // site-data-below-limit; saved-object-stamp: saved-stamps
type Applicability = 'enabled' | 'disabled' | 'hidden' | { lacking: readonly EditionCapabilityId[] };
function commandApplicability(row: CommandOrToolRow, ctx: CommandContext): Applicability;
function cellOn(root: EditionCapabilitySet, kind: ObjectKind, action: Capability): Cell | { state: 'lacking'; requires: readonly EditionCapabilityId[] };
// lacking: the union of the kind's requires and each `via` row's requires the root's set lacks
function ownerOf(row: ObjectKindRow): ObjectOwner;   // the only way to read a kind's owner
const CAPABILITY_MATRIX = { /* … */ } satisfies Record<ObjectKind, Record<Capability, Cell>>;
```

- Rows carry `id` and `backing` only; the six free-text authority values are deleted. `references` names stores a row depends on without owning them. The undo-restore suite picks its write path by owner; store-backed and transient owners are excluded from the undo, copy and paste, stamp round-trip and merge suites with an n/a reason.
- `CommandContext` is flat and JSON-serialisable; the context menu is the table's projection (drops hidden and lacking, greys disabled; sections and `group` placements give separators and submenus); the menu bar and palette grey disabled and lacking and show the row's Instead text; `runCommand` re-reads the live context, the selection from the runtime. Gate consumers are commands, tools (the Site data pin is `siteData.pin`, armed through `tools.arm`), keymap rows and analysis-registry rows; `CanvasRuntimeAppCapabilities` and `DESKTOP_SITE_DATA_CAPABILITIES` are deleted.
- Owner test: every `ObjectOwner` owns at least one row and names an authority in AGENTS.md or an ADR; tool-session rows are n/a in every persistence cell.
- Each stream edits its kinds' rows in the change that alters a capability; a fill turns a `gap` cell into `yes` in the same change.
- Tests, one policy family in F1's inventory:
  - Exhaustive: `satisfies` fails `tsc` on a missing cell; a unit test maps every `DESIGN_FILE_FIELDS` entry, `SceneDesignObjectTarget` kind and PDF page kind to a row or a named non-kind list, so a new field or union member fails until it has a row.
  - Backing: each `yes` names a command or tool whose real availability query is enabled for a fixture selection of that kind on each edition root, and each `no` is disabled, each lacking cell answers lacking on the root that lacks it, and a kind's fixture cannot be created on a root lacking its `requires` (this catches 2.1-Q150's Web Save as stamp); every gate row is named by some `requires` and no adapter row is.
  - Behaviour: table-driven suites (copy and paste round trip, undo restore, stamp round trip, print inclusion) run through the real runtime for every kind marked `yes` (ADR 0028, public surfaces).
  - Reasons: each `gap` is an open bead in `.beads/issues.jsonl`; each `decision` is an id in `docs/decisions/2-1.md` or an ADR.
  - Ratchet: the `gap` cells are a named per-entry ratchet in `policy/ratchets/` (§12), so a new hole fails until it is filled or decided, and a filled one leaves the list.

## 22. Edition ports

`platform/edition-ports.ts` (L1) declares `EditionPorts`, the one record a root builds and installs once (`edition-root-parity`, `edition-ports-installed-only-by-roots`). Fields, each a port file in `platform/` with its `.desktop.ts` and `.browser.ts` adapters beside it:

| Field | File | L-row |
|---|---|---|
| designHome | `design-home.ts` | L10, L17, L21 |
| designCore | `design-core.ts` | L5 |
| fileAccess (with `pickOpen`, `pickHomeTarget`) | `file-access.ts` | L9 |
| fileDelivery | `file-delivery.ts` | L12 |
| lifecycle | `app-lifecycle.ts` | ADR 0024 |
| settings | `settings.ts` | L16 |
| library | `library.ts` | L21 |
| savedStamps | `saved-stamps.ts` | L21 |
| designNotebook | `design-notebook.ts` | L21 |
| speciesLists | `species-lists.ts` | L21 |
| geocoding | `geocoding.ts` | L23 |
| speciesReader (outcome B of 2.1-E1) or catalogSource (outcome A) | `species-reader.ts` or a plain `CatalogSource` value | L20 |
| capabilities | computed at startup from edition plus OS over `canopi-types/edition-capabilities.json` | ADR 0030 |

- Not fields: Desktop window control (bound only by `editions/desktop/`), the inversion port `ScenePainter` (declared by `maplibre/`), and the one-implementation adapters `clipboard.ts` and `page-rules.ts`.
- One `createWorkspaceRuntimeComposition`, one map contribution reader and one `CanvasRuntimeAppAdapter` (in `app/canvas-runtime/`, the inversion seam keeping i18n and settings out of `canvas/runtime`) read the capability set.
- Each edition branch is deleted in the step that builds its alignment (plant labels and species cache: ED-34, 2c; save selection as stamp: 2.1-Q150; Site pin, Profile and the Site, LiDAR and terrain values: N5; terrain: ED-38, 2d; My location: ED-27, 2d), and the six variant files go with their last branch.
- A check: every `*.browser.ts` or `*.desktop.ts` sits in `platform/` beside a port with the same stem.
