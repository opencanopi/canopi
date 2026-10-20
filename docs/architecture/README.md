# Architecture model

For coding agents: the diagrams of Canopi's code as it is and as 2.1 makes it, plus the [abstraction register](abstractions.md). The rules sit in ADRs 0022 to 0030 and the [2.1 ledger](../decisions/2-1.md); where the model and an ADR disagree, the ADR wins and the model is fixed.

## How to read it

- Each diagram follows a `Model:` line. `Model: target` draws 2.1 with every unbuilt part marked `(2.1)` (a class `<<2.1>>`, dashed `:::target` for readers); `Model: current` draws HEAD with no marks and exists only while the target replaces that structure.
- Labels name code by path from the repo root, `desktop/web/src/`, `desktop/src/` or `common-types/src/`, or by crate name. A state diagram follows an `Enum:` line naming the union it draws.
- `scripts/check_docs.py` fails a path, type, crate or enum that does not exist unless marked `(2.1)`; a mark on something built; a `(2.1)` in a current diagram; a state not in its enum or a member not drawn; a cargo graph that differs from `Cargo.toml`; a missing `Model:` line; and a file over its byte budget.
- Owners show on labels or as `<<owner X>>`. Rows of the register give the canonical example to copy; a row saying "pending prototype" is not settled.

## Where to go

Diagram files: [components](components.md), [data design](data-design.md), [data services](data-services.md), [states](states.md), [document flows](flows-document.md), [service flows](flows-services.md), [output flows](flows-outputs.md). Headings are named in quotes; frontend paths are under `desktop/web/src/`.

| For this change | Read this diagram | Edit this owner | Copy this example |
|---|---|---|---|
| A new Tauri command | [data services](data-services.md) "Native scheduling types"; [service flows](flows-services.md) "Failure from native code to the notice and the report" | `CommandRow` rows in `canopi-types` (2.1); today `desktop/src/commands/` and `ipc/` | `desktop/src/commands/species.rs` with `ipc/species.ts` |
| A new failure code | [data services](data-services.md) "Failures and store health"; [service flows](flows-services.md) "Failure from native code to the notice and the report" | failure catalogue in `canopi-types` (2.1) | `canopi-types/fixtures/failures/` (2.1); today `ipc/plant-db-errors.ts` |
| A new Design field (Scene or Document) | [data design](data-design.md) "Design fields and their authorities" | `common-types/src/design.rs` (`DESIGN_FILE_FIELDS`); Scene in `canvas/runtime/scene-runtime/`, Document in `app/design-edit/` | `app/design-edit/views.ts` (Document); `canvas/runtime/scene-runtime/transactions.ts` (Scene) |
| A new Document edit or compound edit | [document flows](flows-document.md) "Undo and Redo, with a compound entry" | Session core `app/document-session/core/` (2.1); Design Edit `app/design-edit/` | `app/design-edit/budget.ts`; compound shape pending prototype H |
| A new canvas tool | [states](states.md) "Tool lifecycle" | `canvas/runtime/tools/tool-host.ts`; tool rows in `app/command-table/tools.ts` (2.1) | `canvas/runtime/tools/text-note.ts` |
| A new map layer or contribution | [states](states.md) "Map surface lifetime"; [components](components.md) "Frontend layers" | `app/canvas-map-surface/workspace-map-contributions.ts`; the settings map-layer slice in `app/settings/` | `app/canvas-map-surface/workspace-map-contributions.ts` |
| A new settings field | [data services](data-services.md) "Settings" | field table in `canopi-types` (2.1); today `common-types/src/settings.rs` and `app/settings/state.ts` | `platform/settings.desktop.ts` |
| A new library item kind | [data services](data-services.md) "Library items, kinds and lineage" | `kinds.rs` in `canopi-library` (2.1); today `desktop/src/services/lidar/catalogue.rs` | `common-types/src/library.rs` |
| A new analysis | [data services](data-services.md) "Analysis registry and the quantity table"; [service flows](flows-services.md) "Analysis run on Desktop and in the Web worker" | `common-types/analysis-registry.json` | `desktop/src/services/lidar/analyses/terrain.rs` |
| A new importer | [service flows](flows-services.md) "Site data import on Desktop" | importer list in `canopi-library` (2.1) | `desktop/src/services/lidar/import.rs` |
| A new export or file kind | [output flows](flows-outputs.md) "PDF export with per-page angles" | FileDelivery `platform/file-delivery.ts` (2.1) and the file-kind table | `app/canvas-pdf/platform.desktop.ts` |
| A new edition difference | [components](components.md) "Ports and edition roots"; [data services](data-services.md) "Object capability matrix and edition capabilities" | `canopi-types/edition-capabilities.json` (2.1); `platform/edition-ports.ts` (2.1) | `platform/settings.desktop.ts` with `platform/settings.browser.ts` |
| A new store or stored-format step | [data design](data-design.md) "The .canopi file: v9 and v10"; [document flows](flows-document.md) "v9 to v10 migration and the reader release" | `canopi-format` (2.1) for `.canopi`; the store's chain otherwise (pending prototype W) | `desktop/src/design/format.rs` |
| A new Web storage record | [states](states.md) "Drafts"; [document flows](flows-document.md) "Draft persistence" | `platform/browser-record.ts` (2.1) or the store's IndexedDB adapter | `web/browser-app-data.ts` |
| A new locale string | none | `i18n/` (all 11 locales) | `i18n/en.json` |
| A new command or shortcut | [components](components.md) "Frontend layers" | `app/command-table/` (2.1); today `app/canvas-commands/index.ts` and `app/keyboard/keymap.ts` | `app/canvas-commands/index.ts` |

## Keeping the model true

When a phase builds a `(2.1)` part, the same PR drops its marker; the checker fails the PR otherwise. A current diagram is deleted in the change that deletes the structure it draws, and a register row changes in the change that moves its owner or example.
