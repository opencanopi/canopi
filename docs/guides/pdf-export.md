# PDF export

Covers: `desktop/web/src/app/canvas-pdf/`, `desktop/src/services/export.rs`, `scripts/pdf-native-webview/`

## Purpose

The planting-plan PDF is a derived, printable view of a Design, identical on Linux, macOS, Windows and Web. This guide states the pipeline's boundaries and limits, what the print workspace must keep and how to verify it. The scope decision is [ADR 0008](../adr/0008-canvas-pdf-export.md): no network during export, and no map backgrounds until the PDF editor release (ledger 2.1-Q157).

## Authorities and boundaries

- Entry: File › Export › Planting plan (PDF)… (`file.exportCanvasPdf`, Ctrl P) opens the full-window print workspace (`components/canvas-pdf/CanvasPdfDialog.tsx`, mounted by `WorkspaceComposition` in both editions). Its title is "Export to PDF".
- Capture: `CanvasQuerySurface.capturePrintSnapshot()` returns an owned, renderer-neutral projection of settled Scene state in session-plane metres, or `null` while an edit owns the Scene. Maps, viewport decorations and selection never enter it. It never settles an edit or touches persistence.
- Composition: `app/canvas-pdf/live.ts` joins capture, name resolution (chosen language, then English fallbacks in `PdfInput.englishFallbacks`), catalog habits (`PdfInput.habits`) and the edition delivery adapter. Names and habits come from the Species Catalog Workbench's batch projections (`resolveCommonNames`, `resolveHabits`), never from `ipc/**` directly, so both editions print the same key. `workflow.ts` owns the setup, cancellation, admission of current results and delivery status.
- Layout: `layout.ts` composes one page plan in PDF points from field modules that work in millimetres; `text.ts` shapes text with Fontkit over embedded Noto metrics for both preview outlines and PDF text; `encode.ts` replays the plan through PDFKit into one document with named destinations. No screenshot, print stylesheet, native renderer or system font takes part.
- Worker: a lazily imported inline Vite worker (`worker.ts`, `job.ts`) runs each shaping and encoding job; progress messages carry preview-only plans, never exportable bytes; cancellation, timeout, completion or error terminates it. `PdfPagePreview.tsx` renders the same glyph outlines as SVG for previews and thumbnails.
- Delivery: `#canvas-pdf-platform` selects it. Web clicks a Blob URL during the initiating gesture; Desktop uses the dialog and `save_canvas_pdf`, the only PDF command, in the executor's `Local` class through `write_derived_file()`.
- Print setup survives closing the preview and editing and rebuilds on reopen. Today it is Design Session state, discarded on Design replacement; from 2.1's Phase 2c it is the Design's `print_setup` field, saved with it, one Undo entry per workspace session (ADR 0008, 2.1-Q152). Export never dirties, saves or changes Design content, history or settings; layer overrides change print inclusion, not Scene visibility.

## Rules

- Limits: 200 pages per document (`layout.ts`), 120 s per job (`job.ts`), 30 s per font fetch (`text.ts`) and per name or habit lookup (`workflow.ts`), 64 MiB and a `%PDF-` … `%%EOF` payload with a `.pdf` destination for native delivery (`desktop/src/services/export.rs`). Tests: `canvas-pdf-job.test.ts`, `canvas-pdf-font-assets.test.ts`, `canvas-pdf-native-delivery.test.ts`, `native_command_policy::tests`.
- Only Print Areas the user draws, or Whole design, create detail pages; clicking a zone never creates a page and print setup never changes Design zones (`canvas-pdf-areas.test.ts`, `canvas-pdf-area-drawing.test.tsx`).
- Printable content is plants, pinned plant names, zones, annotations and persistent measurement guides; group members print once; maps, Timeline, Budget and Consortium never print (`canvas-pdf-layout.test.ts`, `canvas-print-snapshot.test.ts`; the `null`-during-edit case is in `canvas/runtime/scene-runtime.test.ts`).
- Framing: zoom 1–1000 %, default 100 %; Fit restores full coverage; per-page orientation keeps framing; `PdfSetup.views` is keyed by stable id (`overview`, `area:<id>`, `<source>:legend:<index>`), never by page number (`canvas-pdf-details.test.ts`, `canvas-pdf-continuations.test.ts`).
- Readability: authored appearance and positions are kept; ambiguity resolves with print-only enclosures and Species Codes, never by recolouring or moving the Design; names wrap and are never truncated (`canvas-pdf-readability.test.ts`, `canvas-pdf-species-codes.test.ts`).
- Plant colours: As in the Design, Grayscale (each distinct colour its own grey, ordered by luminance) or Black, for printing only (`print-colors.ts`; `canvas-pdf-print-options.test.ts`, `canvas-pdf-color-mode-labels.test.ts`).
- North arrow and scale default on; turning them off removes the ground scale bar and arrow from map pages; the overview's 50 mm calibration bar always prints (`canvas-pdf-print-options.test.ts`). The north arrow always points to true north.
- Map orientation ([ADR 0015](../adr/0015-rotating-map-and-canvas-controls.md)): today North up (the default) or As on screen turns every page at one angle, the view's bearing. From 2c each page has its own angle, North up, As on screen, a saved view's bearing, Turn to edge or typed, stored in the print setup (2.1-Q151). An area is its centre and its size along the page axes, and turns about its centre with its page.
- Turned layouts keep coverage: the sheets of one split turn together about the split's centre, and Add whole design refits to the printed design at every build (`canvas-pdf-overview.test.ts`, `canvas-pdf-layout.test.ts`).
- A turned page is built on one turned copy of the print snapshot ([ADR 0008](../adr/0008-canvas-pdf-export.md), `app/canvas-pdf/page-frame.ts` from phase 1); layout modules never take an angle, and text stays level on paper (`page-frame.test.ts`). At every angle, North up included, a zone's code anchors at its own top on the page (the top of its part inside the ground, never the upright bounds), and a guide's M code prints beside its own guide, nearer it than any other guide or any zone dimension, or only in the key with coordinates (`canvas-pdf-turned-labels.test.ts`).
- Key: grouped by catalog habit Tree, Shrub, Herbaceous, Climber, Other, with "(continued)" headings on continued columns; without any known habit (catalog failure) the key is one ungrouped list; missing-language names show the English name marked "(en)" (`canvas-pdf-print-options.test.ts`).
- Splitting partitions a sheet along its longest ground axis to about 120 positions per part (2–32 parts); the proposal stays separate from the committed setup and export is unavailable while it is under review (`split-sheets.ts`; `canvas-pdf-field-proposal.test.ts`).
- Find in key (Ctrl F) runs the plant finder's matcher over the printed key and opens the matching page (`key-finder.ts`; `canvas-pdf-key-finder.test.tsx`).
- Workflow: a 100 ms timer coalesces revisions; each effective edit cancels the older job; a Design Session identity change cancels, closes and discards the setup (`canvas-pdf-workflow.test.ts`, `canvas-pdf-dialog.test.tsx`).
- Fonts: `app/canvas-pdf/font-assets.json` pins five Noto files (latin regular and semibold, CJK SC/JP/KR) by upstream commit URL and SHA-256; `scripts/prepare-pdf-fonts.mjs` (Vite plugin, Vitest global setup) verifies them in ignored `app/canvas-pdf/fonts/`, fetching a missing or corrupt one; `font-urls.ts` imports them, so every build names them by content (2.1-M176), and resolves absolute URLs on the main thread, since the worker's blob: base resolves no relative URL; the runtime verifies bytes on load (`canvas-pdf-font-assets.test.ts`). PDFKit and Fontkit are pinned in `package.json`.
- The Tauri CSP keeps `worker-src 'self' blob:` for the inline worker (advice).
- PDF layout imports no renderer or runtime state; no policy test enforces it (advice).

## The side sheet keeps

Title, paper (A4 / US Letter), Plant colors (segmented radio), Map orientation (North up / As on screen; from 2c a selected page's option), Include (printable layer checkboxes and the North arrow and scale switch), the selected page's options or the split review, Find in key, Add field sheet, page thumbnails and Save with the page count (`canvas-pdf-dialog.test.tsx`). The preview holds only the page heading, hint, page editor and errors. While a plan rebuilds, the last plan stays visible, marked busy, with framing input disabled and exportable bytes cleared.

## Do not

- Before the PDF editor release's design check (2.1-Q157), do not add a map background, tile fetch or any network request to the pipeline (ADR 0008).
- Do not add a second PDF or image export command; there is no PNG export.
- Do not concatenate documents, use browser text metrics for the preview, or let a screenshot stand in for layout.
- Do not keep a persistent worker or let progress messages carry exportable bytes.
- Do not let export dirty, save or edit the Design, or change Scene visibility through print layer overrides.
- Do not treat encoder fixtures or screen checks as printer tests; physical readability and the 50 mm bar need paper evidence.
- Do not commit generated validation artifacts or private `--input` Designs.

## Verification

```bash
cd desktop/web && npx vitest run src/__tests__/canvas-pdf src/__tests__/canvas-print-snapshot.test.ts
cd desktop/web && npm run build:pdf-validation                    # production sample host into ignored dist-pdf-validation/
python3 desktop/web/scripts/pdf-validation/run-browser.py …       # Playwright drives the host on loopback
python3 desktop/web/scripts/pdf-validation/verify.py …            # Poppler + Pillow compare SVG previews with rendered pages
python3 -m unittest discover -s desktop/web/scripts/pdf-validation -p 'test_*.py'
```

Shell or shared runtime changes also need `npm test` and both builds; native delivery changes need the Rust gates. `.github/workflows/pdf-production-probe.yml` runs the validation host in the desktop WebView engines through `scripts/pdf-native-webview/run.py` (worker, CSP and fixed-path delivery, not the save dialog); keep its push and pull-request path filters aligned.

## Where to look

| Area | Module | Tests |
| --- | --- | --- |
| Capture | `canvas/runtime/query-surface.ts` | `canvas-print-snapshot.test.ts`, `canvas/runtime/scene-runtime.test.ts` |
| Workflow and live composition | `app/canvas-pdf/workflow.ts`, `live.ts` | `canvas-pdf-workflow.test.ts` |
| Layout | `app/canvas-pdf/layout.ts`, `coverage.ts`, `field-*.ts`, `overview*.ts`, `page-furniture.ts`, `field-key.ts`, `integrated-key.ts` | `canvas-pdf-layout.test.ts`, `canvas-pdf-overview.test.ts`, `canvas-pdf-strips.test.ts`, `canvas-pdf-zone-measurements.test.ts` |
| Text and encoding | `app/canvas-pdf/text.ts`, `encode.ts`, `worker.ts`, `job.ts` | `canvas-pdf-text.test.ts`, `canvas-pdf-encoding.test.ts`, `canvas-pdf-worker-errors.test.ts` |
| Print workspace | `components/canvas-pdf/` | `canvas-pdf-dialog.test.tsx`, `canvas-pdf-preview.test.tsx`, `canvas-pdf-key-finder.test.tsx` |
| Delivery | `app/canvas-pdf/platform.*.ts`, `desktop/src/services/export.rs` | `canvas-pdf-delivery.test.ts`, `canvas-pdf-native-delivery.test.ts` |
| Validation host | `desktop/web/scripts/pdf-validation/`, `scripts/pdf-native-webview/` | `test_preview_files.py`, `pdf-production-probe.yml` |
