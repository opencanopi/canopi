# Canopi 2.0 breaks stored data

Status: Accepted (2026-10-02, Canopi 2.0); amended 2026-10-03 and 2026-10-05 (U33: older local data stays in place; no backward compatibility before 2.0 ships) and 2026-10-16 (this ADR now covers only data from before 2.0; [ADR 0026](0026-stored-data-after-2-0.md) governs version 9 on); 2026-10-17 (newer data: the reader release opens the 2.1 forms read-only, ledger 2.1-Q138; per edition, and the reader release named by role: 2.1-M32, 2.1-M33; 2.1-M42)

## Context

ADR 0013 kept a migration ladder: `.canopi` files from v7 and user databases from schema 8 were upgraded on open, with a Web mirror of every step, corpus fixtures on both trust boundaries, a one-off "Saved as Canopi 2 format" notice and an in-memory upgrade for saved stamps. Every format change cost a step in two languages.

Canopi has two users, and the maintainer converts their `.canopi` files by hand. The user decided (2026-10-02): "Don't worry about migrations. This is a breaking release. You can drop all file migration code except the error message saying old versions are not supported by canopi v2.0 and onward." For local data they chose to move old data aside rather than refuse it or delete it (replaced by U33). The same day they widened it: "You can modify the .canopi files or the user local data if it's necessary to improve our project. But don't change the plant database."

## Decision

- **Designs (`.canopi`).** Version 9 up to the current version opens, on both trust boundaries (a version below the current one through ADR 0026's steps). Versions 1 to 8, and a missing version, fail with `unsupported_version` and the typed kind `OlderVersion`, which reads "Made with Canopi before 2.0; Canopi 2.0 and later can’t open it"; a newer version reads as newer. The file is never changed. No converter or code reads a format from before 2.0.
- **Admission stays.** Current-format checks are not migration: every object needs a unique, non-empty id (a file missing one is refused, nothing repairs it), the fields Canopi always writes (the root lists, each view's ground) are required, and ranges are checked; unknown root keys, 1.x ones included, are carried, never refused. They also catch mistakes in hand-converted files.
- **Local data from before 2.0 stays in place, never read, never deleted, never upgraded** (user, 2026-10-05, U33, replacing the dated move-aside of 2026-10-02, whose backup naming, read-back checks, rollback and quota fallback cost about 300 lines for data only development builds and 1.x hold). Canopi 2.0 starts fresh and says once that older data can't be opened.
  - Desktop user database (Favorites, Recent Designs, Design notebook, saved stamps, settings): schema 1 to 8, or tables without a version, is renamed `<file>.before-2.0-<unix-seconds>` with its journal files, since 2.0 needs that path. A newer schema is refused untouched; a damaged file is renamed `<file>.corrupt-<unix-seconds>`.
  - Desktop Drafts in an older format and the retired 1.x autosave store stay where they are, unread.
  - LiDAR library: a catalogue from before 2.0 (below version 25) or a damaged one is set aside under `lidar-library.set-aside/` and rebuilt from the originals it keeps (recovery, not migration); a newer one is refused.
  - Web: 2.0 stores under new keys (`canopi:web-app-data:v3:*`); the 1.x keys (`canopi:web-app-data:v1` and `v2:*`, Drafts included) stay unread and unchanged, so 1.x Web still opens them.
- **Newer data.** A 2.0 build from before the readers refuses a newer Desktop store unchanged (but for ADR 0026's beta-only settings window, 2.1-M42) and on Web reads only its own 2.0 keys, so every 2.1 record stays byte-identical. The reader release (the next 2.0.x after Phase 1, 2.1-M33) opens the 2.1 forms, and any later version of them, read-only and writes none of them ([ADR 0026](0026-stored-data-after-2-0.md) Rollback).
- **Saved stamps.** Only payload version 2 is read; after 2.0 payloads migrate on their own chain from floor 2 (ADR 0026).
- **Settings.** New fields have defaults. From 2.1 a bad value resets only that field and the original is kept once as `settings.before-reset` ([ADR 0026](0026-stored-data-after-2-0.md), ledger 2.1-Q54); the 2.0 `settings.set-aside` of a whole record is replaced.
- **Additive `.canopi` changes** (amended 2026-10-03 with U21; U33 made the view's ground size required on 2026-10-05) follow ADR 0026's additions rule: from `.canopi` v10, an optional field valid alone, or a new literal of a set v10 made an open string, keeps the version. Admission has no `deny_unknown_fields`, so files on either side of such a change still open.
- **No backward compatibility before 2.0 ships** (user, 2026-10-05, U33): "we should not waste any time and energy on backward compatibility". No fallback reads an older shape and no test covers a version that never shipped; a field only development files lack may become required at version 9.
- **Format changes.** The `.canopi` format and local data (user database, Drafts, Web storage, LiDAR catalogue, settings) may change when that improves the project, without asking the user first; each change is named in the handoff. From 2.0 on, every change to a user-work store's shape is a frozen migration step or an additive annex ([ADR 0026](0026-stored-data-after-2-0.md)); derived stores are rebuilt. The plant catalog database (`canopi-core.db`) never changes.

## Consequences

- Supersedes [ADR 0013](0013-stored-data-migrations.md). "Delete, don't deprecate" now covers all older-format code: `common-types/src/migrations.rs`, its Web mirror, `user_db_migrations.rs`, their fixtures and the upgrade notice are gone.
- Designs from the 2.0 previews (v7, v8) and Canopi 1.x are refused; the maintainer converts them by hand. Older local data left in place still opens in an older Canopi; the renamed user database can be renamed back.
- A version 1 stamp payload saved in a current (schema 9) database is kept but can no longer be placed; nothing moves it aside.
- The renamed Desktop user database carries Unix seconds in its name.
