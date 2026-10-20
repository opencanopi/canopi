# Story export: implementation plan

Status: agreed; 2.1 (canopi-5ys2.3.4). Saved views, the Stories panel, presenting and the snapshot capture shipped in 2.0; their rules are in the [design document](../guides/design-document.md) and [map workspace](../guides/map-workspace.md) guides and the [dock panels](../../.interface-design/patterns/dock-panels.md#stories) pattern.
Mockups: design canvas boards StoryAuthor, StoryPresent, StoryPhone.

## 1. What users get

- **Export a story** as a self-contained web page and as a PDF, one step per page, from the Stories panel and File › Export.

## 2. What it builds on

- `common-types/src/views.rs`: `SavedView`, `Story`, `StoryStep`, `RichTextBlock`, `StoryImage` (embedded data, 1 MiB per image, 10 MiB per Design), validated on both trust boundaries.
- Saved-view snapshots: `maplibre/view-snapshot-map.ts` renders a view off-screen on the single hidden map and returns an image, flags (tiles missing) and credit text, never a URL.
- The PDF pipeline of [ADR 0008](../adr/0008-canvas-pdf-export.md): one layout and encoder for every edition, no network during export.

## 3. Design

- **Web page:** one HTML file with inline CSS, the story text, images and one map snapshot per step (PNG/WebP) with its attribution. Static snapshots are offline and respect imagery terms; live Google tiles are never embedded in a page outside Canopi (D3).
- **PDF:** one page per step: snapshot on top, title and text below, through the existing worker and limits, delivered by `platform/file-delivery.ts`.
- **Snapshots in exports** carry the same "some tiles missing" flag the saved-view thumbnails use; an export with missing tiles says so and still completes.
- Export never changes the Design, its history or its settings.

## 4. Accessibility and languages

The web page keeps a heading per step, `lang` per story (defaulting to the UI locale), image descriptions as `alt`, and text that scales without clipping; all UI strings in 11 locales.

## 5. Tests

Codec tests for the HTML document (no external requests, every image inline, attribution per snapshot); PDF layout tests for the step page; delivery tests per edition; an i18n completeness run.

## 6. Decisions (the user adopted the recommendations)

- **D3 Export map:** static snapshots, not an interactive web map (Google imagery cannot be embedded outside Canopi).

## 7. Open questions

- Saved-view thumbnails with Site data: decided with story maps (ledger [2.1-Q30](../decisions/2-1.md)).
