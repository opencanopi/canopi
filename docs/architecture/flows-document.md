# Design document flows

Answers how a Design is opened, edited, saved, undone, migrated and closed on both editions. Rules: ADR 0009, ADR 0024 (Session core, One Undo order, Close and hide), ADR 0026 (admission, Drafts, Rollback), contracts §4, §10 and §11; the ADR wins on conflict.

### Open, edit and continuous save

Model: target
Source: ADR 0024, contracts §4, 2.1-Q66, 2.1-Q68, 2.1-Q127, 2.1-M85

```mermaid
sequenceDiagram
  participant Root as editions/desktop/ (2.1) owner edition root
  participant Home as platform/design-home.ts (2.1) DesignPicker and DesignHomeStore
  participant Core as app/document-session/core/ (2.1) owner Session core
  participant Fmt as platform/design-core.ts (2.1) DesignCore
  participant Scene as canvas/runtime/scene-runtime/ owner Scene
  participant Doc as app/design-edit/document/ (2.1) owner Document
  Root->>Core: launchIntent(): file argument, else last open Design, else none
  Note over Home: Open dialog, Recent row or file association give a FileGrantId
  Home->>Core: openFrom(source)
  Core->>Core: opening with current kept open and saveable
  Core->>Home: read(home)
  Home-->>Core: present, absent or unreadable
  Core->>Fmt: decode(bytes)
  alt refusal
    Fmt-->>Core: Refusal, current Design untouched, reportFailure
  else admitted
    Fmt-->>Core: OpenedDesign
    Core->>Core: replacing: flush current through its write lane
    Core->>Scene: hydrateSceneObjectsInFrame(objects, plane)
    Core->>Doc: admit the Document fields
    Core->>Core: dispose old scope, open with rev equal to ackRev
  end
  Scene->>Core: changed() with Scene token
  Doc->>Core: core.document(write) receipt with Document token
  Core->>Core: rev plus one, save pending, tick after 1.5 s or on blur
  Core->>Fmt: encode(design), rev read at encode start
  Core->>Home: write(home, bytes)
  Home-->>Core: written sets ackRev, or conflict, quota_refused, failed
```

- Owner: the Session core is the only writer of session state, home, save state and scope; `openFrom` is the one open path, a same-home source answers already-open after a flush.
- Invariant: dirty is `rev > ackRev`; only `written` sets `ackRev`; an edit during a write stays dirty and the lane writes again.
- Tests: contracts §4 scenarios 3, 12, 17 and 18, run against both editions' ports.

### Close and flush

Model: target
Source: ADR 0024 Close and hide, ADR 0009, 2.1-Q20, 2.1-Q22, 2.1-Q61, 2.1-M55

```mermaid
sequenceDiagram
  participant Life as editions/desktop/ (2.1) app-lifecycle adapter
  participant Web as editions/web/ (2.1) app-lifecycle adapter
  participant Core as app/document-session/core/ (2.1) owner Session core
  participant Ask as SessionCoreHost (2.1) bound by the root
  participant Set as app/settings/ owner settings
  participant Drafts as platform/design-home.browser.ts (2.1) owner Draft store
  alt quit, window close or update install
    Life->>Core: one close request
    opt a library job runs
      Core->>Ask: ask first
    end
    Core->>Core: closing, await the write lane flush
    opt Design flush failed
      Core->>Ask: Retry, Close without saving or Cancel
    end
    Core->>Set: flush settings
    opt settings store unwritable
      Core->>Ask: Retry or Close anyway
    end
    Core->>Life: drain the native executor, then exit
  else Design switch or Close Design
    Core->>Core: flush through the write lane, then replace or close the scope
  else visibilitychange to hidden or pagehide
    Web->>Core: hidden
    Core->>Core: flush the Design, leave prompt only while a write failed or is pending
    Core->>Set: flush settings
    Web->>Drafts: on pagehide close the IndexedDB connection after its transaction
  end
```

- Owner: close and hide belong to the Session core; adapters never act on page or window events themselves.
- Invariant: the Design flushes before settings; `current` is disposed only after the write that acknowledged its last rev.
- Tests: contracts §4 scenario 4 (a) and (b), scenario 6; the model test of the close machine with a job running.

### Draft persistence

Model: target
Source: ADR 0026 Web Drafts, contracts §11, 2.1-Q22, 2.1-Q40, 2.1-Q47, 2.1-Q82

```mermaid
sequenceDiagram
  participant Core as app/document-session/core/ (2.1) owner Session core
  participant Fmt as platform/design-core.ts (2.1) DesignCore
  participant DH as platform/design-home.desktop.ts (2.1) owner Draft store
  participant Dur as canopi-support (2.1) publish_durably
  participant WH as platform/design-home.browser.ts (2.1) owner Draft store
  Core->>Core: first edit of a new Design: mintDraftId(), rev plus one
  Core->>Fmt: encode(design)
  alt Desktop
    Core->>DH: write(draft home, bytes)
    DH->>Dur: publish the Draft file durably
    DH-->>Core: written, or failed busy: not saved yet, next tick writes
  else Web
    Core->>WH: write(draft home, bytes)
    WH->>WH: set the pending-write marker synchronously
    WH->>WH: one readwrite transaction: get revision, compare, put
    alt revision moved
      WH-->>Core: conflict, save conflict, nothing overwritten
    else quota
      WH-->>Core: quota_refused, Design kept, leave prompt armed
    else complete
      WH->>WH: clear the marker
      WH-->>Core: written sets ackRev
    end
  end
  Note over WH: a marker found at open names the Draft whose last change may be missing
```

- Owner: each edition's Draft store adapter; only the core mints a `DraftId` and refuses deleting the open Design's Draft.
- Invariant: every injected fault leaves the last or previous acknowledged revision on reopen; the store takes its `IDBFactory`.
- Tests: the Draft-store suite in Chromium, WebKit and Firefox; contracts §4 scenarios 1, 6, 7, 13 and 16.

### Undo and Redo, with a compound entry

Model: target
Source: ADR 0024 One Undo order, contracts §4, 2.1-Q80, 2.1-M89, 2.1-Q155, 2.1-Q158

```mermaid
sequenceDiagram
  participant Key as app/keyboard/key-router.ts
  participant Tool as canvas/runtime/tools/saved-object-stamp.ts owner _tool
  participant Core as app/document-session/core/ (2.1) owner Design history
  participant Scene as canvas/runtime/scene-runtime/ owner Scene
  participant Doc as app/design-edit/document/ (2.1) owner Document
  Tool->>Core: core.compound(sceneTx, documentWrite) with OperationId
  Core->>Scene: placed copies, species colours only where empty
  Core->>Doc: care actions on the copies, species data only where empty
  alt either half refused
    Core-->>Tool: entry refused, neither half applied
  else both applied
    Core->>Core: one entry with Scene and Document tokens, rev plus one
  end
  Key->>Core: Undo, routed by the canvas to the core
  Core->>Doc: replay the Document inverse
  Core->>Scene: replay the Scene inverse
  Core->>Core: rev plus one, so undo to the saved point still saves
  Key->>Core: Redo replays both halves
  Note over Core: any new edit ends the redo branch, a canvas detach drops Scene tokens
```

- Owner: the Session core holds the one history order; each half is still written by its owner.
- Invariant: one Undo removes the copies and their care actions together; Document writes (views, stories, budget, timeline, consortium, Site data entries, print setup) are entries too.
- Tests: "one Undo restores both halves, one Redo reapplies both"; the Session suite case per Document edit family (2.1-M87).

### v9 to v10 migration and the reader release

Model: target
Source: ADR 0026 `.canopi` admission and Rollback, contracts §10, 2.1-Q35r, 2.1-Q69, 2.1-M21, 2.1-M31, 2.1-M32

```mermaid
sequenceDiagram
  participant Core as app/document-session/core/ (2.1) owner Session core
  participant Chain as canopi-format (2.1) owner .canopi chain
  participant DH as platform/design-home.desktop.ts (2.1) file home
  participant Ask as SessionCoreHost (2.1) bound by the root
  participant Old as app/document-session/state-machine.ts 2.0.4 Desktop
  participant OldWeb as web/browser-design-session.ts 2.0.4 Web
  participant Wasm as canopi-format-wasm (2.1) decode only
  Core->>Chain: decode(bytes): cap, JSON, version, Admission
  alt BeforeFloor or Newer
    Chain-->>Core: refusal, file unchanged
  else Migratable from 9
    Chain->>Chain: frozen v9 schema, pure v9 to v10 step, v10 schema, admission
    Chain-->>Core: OpenedDesign migratedFrom 9, or migration_failed from 9
  end
  Core->>Core: migrated open is clean, first real edit sets pending
  Core->>DH: first new-format write
  DH->>DH: keep Garden (Canopi 2.0).canopi once, never overwriting
  alt folder not writable
    DH-->>Core: copy-blocked
    Core->>Ask: notice names the folder, asks before saving
  else copy kept
    DH->>DH: publish the v10 file, notice says a copy was kept
  end
  Note over DH: a Desktop Draft keeps its v9 form once in the unlisted before-v10 folder, no notice
  Old->>Chain: read half, the frozen v10 read schema only
  Chain-->>Old: newer-read-only, says a newer Canopi saved it, no save path
  OldWeb->>Wasm: IndexedDB Draft or file bytes, decode only
  Wasm-->>OldWeb: newer-read-only, old-key Draft with the same id hidden
```

- Owner: `canopi-format` owns the chain at the one decode choke point; Web runs it in the core worker and a Web open from bytes makes a Draft with no notice.
- Invariant: a step is pure and frozen; a failing step leaves the file unchanged and lists such a Draft as unreadable; the reader release writes no byte.
- Tests: `migration_steps_frozen`; contracts §4 scenario 12; "reader release: a v10 Design opens read-only and says a newer Canopi saved it".

### Today: two session machines and the close-guard loop

Model: current

```mermaid
sequenceDiagram
  participant Guard as app/shell/close-guard.ts
  participant Set as app/settings/projection.ts
  participant Desk as app/document-session/state-machine.ts Desktop
  participant Web as web/browser-design-session.ts Web
  participant Save as app/document-session/continuous-save.ts
  participant Ask as app/document-session/save-problem.ts
  Guard->>Set: flushSettingsProjection() first
  Set-->>Guard: a throw keeps the window open, nobody asked
  loop until flushed, discarded or cancelled
    Guard->>Save: flush()
    Guard->>Ask: requestSaveProblemDecision flush-failed close
  end
  Desk->>Save: flushBeforeReplacement, its own retry loop
  Web->>Save: flushBeforeReplacement, a third loop
  Web->>Save: flush on visibilitychange and pagehide, settings never flushed
```

- Replaced by the Session core in Phase 2b; deleted with `web/browser-design-session.ts` and the state machine.
