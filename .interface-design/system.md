# Canopi interface design system

Canopi is a field atlas for designing a living landscape on the map: parchment, ink and ochre floating over satellite or map, with dense, readable controls. Reasons: [ADR 0010](../docs/adr/0010-map-first-interface.md). The target is the design boards in [`boards/`](boards/README.md); the UI gallery shows what shipped.

Read this, then your surface's pattern file:

| Surface | Pattern |
| --- | --- |
| Map canvas, rails, view chip, zoom, annotations, selection and canvas menu, inspection lens, symbol and colour, stories | [Canvas workspace](patterns/canvas-workspace.md) |
| Pan, zoom and turn the map, compass, Pointing device, F1 gestures, PDF map orientation | [Canvas navigation](patterns/canvas-navigation.md) |
| Plants in this Design, Layers, Calendar, Budget, Consortium, Favorites, Design notebook, Stories, finder | [Dock panels](patterns/dock-panels.md) |
| Site data, Profile, Import, Analyze, Data library | [Site data](patterns/site-data.md) |
| Plant catalog, filters, species detail, photos | [Catalog and details](patterns/catalog-and-details.md) |
| Title bar, menus, start screen, dialogs, settings, notices, empty/loading/error states, PDF export, Web on phones | [Controls and shell](patterns/controls-and-shell.md) |

## Direction

- Parchment, ink and ochre, in light and dark. Green never appears in chrome; it is plant data.
- Floating surfaces (`--color-glass`, blur, soft shadow, 14 px radius) over a full-bleed map.
- One meaning per colour: ochre = selected, active or primary; blue = focus ring or water (raster ramps); amber = warning; red = error or destruction. Never ochre for decoration or warnings. Sole exception: the map's location dot, platform blue `#1A73E8`.
- Type: Literata 600 for titles (28 display, 20 dialog, 18 panel), Source Sans 3 for UI (15 body, 14 controls, 12.5 captions), IBM Plex Mono 600 12 for species codes. Weights 400 and 600 only; nothing below 12 px (13 for CJK).

## Workspace layout

- Title bar (floating, 50 px): logo, menubar (File, Edit, View, Tools, Help), Design name (click to rename), save status with its one action, place search (Ctrl K), Help, Settings.
- Left: tool rail (Select · Place plants, Plant a row, Place a stamp · Polygon, Rectangle, Ellipse, Line · Text note, Measure · Undo, Redo), labelled with keys until each tool is used once, then icons; in a short window the last tools fold into More tools, never Undo and Redo. Pan (H) is off the rail, in View and Tools.
- Right: panel rail (Ctrl 1–9; folds into More in a short window) and one panel at a time: 380 px, or 440 px for Site data, Budget, Consortium and Stories; Calendar can Expand.
- Bottom left: view chip with pressed toggles (Grid, Snap to grid). Bottom right: attribution pill, then zoom group (scale bar, −, ratio menu, +, Fit to Design, Show my location on Web, compass).
- Tool cards sit top-left beside the rail (320 px). Status chips (40 px) sit top- or bottom-centre of the visible map.

## Tokens

`desktop/web/src/styles/global.css` is the single source for colour, spacing, type, radii, control sizes, shadows and transitions. CSS Modules use tokens only: no raw `rgba()`, `white` or `black`, weights 400 and 600.

- Palette: paper `--color-bg`, `--color-surface` (panels, menus, dialogs), `--color-surface-alt` (wells, tracks, info notices), `--color-glass` (floating chrome), ink `--color-text` / `-secondary` / `-muted`, ochre `--color-accent` / `-ink` / `-soft` / `--color-on-accent`, `--color-focus`, amber `--color-warning` / `-bg` / `-line`, red `--color-danger` / `-bg` / `--color-on-danger`, `--color-tip` / `--color-on-tip` (tooltips, toasts), `--color-mark` (match highlight).
- Radii: `--radius-md` 7 (menu items, tips, segments), `--radius-control` 8 (buttons, fields), `--radius-lg` 11 (menus, notices, toasts), `--radius-panel` 14 (floating chrome, panels, dialogs). Shadows: `--shadow-sm` (tips), `--shadow-float` (floating chrome, menus, dialogs).
- Type: `--font-display`, `--font-sans`, `--font-mono`; `--text-2xs` 12 · `--text-xs` 12.5 · `--text-sm` 13 · `--text-base` 14 · `--text-dialog` 14.5 · `--text-md` 15 · `--text-lg` 18 · `--text-xl` 20 · `--text-display` 28.
- Control boundaries (`--color-border-strong`) reach 3:1 against the surface; the off switch, selected segment and radio ring too.
- Selected rows: `--color-accent-soft` fill and a 3 px inset `--color-accent` edge. Selected tiles and cells: soft fill and 2 px inset ring. Selected swatches: 2 px gap then a 2 px ring. Pressed toggles: soft fill, accent border and ink, and a check icon.
- Focus: `outline: 2px solid var(--color-focus); outline-offset: 2px` on `:focus-visible` everywhere; text fields show focus with `:focus-within`.

## Icons and icon-only buttons

- In-house inline SVG only: `components/canvas/toolbar-icons.tsx` (tools and actions), `components/shared/PanelIcon.tsx` (panels), `components/shared/ControlIcon.tsx` (control glyphs); 20×20, 1.6 stroke, round caps, `currentColor`, `aria-hidden`. Dotted icons use filled circles. No emoji or text glyphs as icons.
- Every icon-only button has a localized `aria-label` naming the action and its object, a `ButtonTooltip` with the same label and its shortcut (`aria-keyshortcuts`), a visible focus ring and a size token (28 px in rows, 36–40 px in rails, 44 px on touch).

## Plants

- Symbols: 29 single-colour glyphs from the shared recipes (`canvas/runtime/plant-symbol-recipes.ts`) in three families (plant form, what it gives, what it does) plus four abstract marks; the picker shows them by family, five to a row.
- Colour by species (default), stratum or one colour; any species takes any colour. Stratum colours are Okabe-Ito hues (Emergent gold, High bluish green, Mid blue, Low reddish purple) plus a grey for "No stratum yet"; the stratum is the Design's (Consortium), never the catalog's. Display never changes a stored colour. Plant forms are not strata.
- One species row: glyph 22 · common name (600) over italic scientific name (`lang="la"`) · mono code (44 px, right-aligned) · count (40 px, tabular) · actions. Never a code instead of a name; no name in the interface language shows the English name marked "(en)".
- Every plant list uses the shared finder: search (Ctrl F) over names in every language, scientific names, synonyms and codes, tolerant of accents, capitals and small typos; quick filters (Selected on map, Stratum and Form, then list-specific ones); a live count.

## Layout and interaction

- Keep the map visible. A panel has one title, a close action, compact controls and a scrolling body; apply actions stay visible.
- Preview before mutation; each action keeps its command or workbench authority. Selection, focus, hover, visibility and locks stay distinct.
- Destructive actions confirm and name what is lost, or show an Undo toast (also Ctrl Z). Toasts wait while hovered or focused.
- Keyboard: every pointer action has a keyboard path, turning the map included; one keyboard owner routes keys. F6 and Shift F6 cycle title bar, tool rail, map and open panel. One Esc does one thing, in ADR 0020's order: the active tool's first; a drawing draft steps back one point. Single keys work anywhere except text fields and dialogs and can be turned off; Shift N always resets north.
- Popups anchor to their trigger and stay in the viewport (flipped above, or capped and scrolling). Dialogs are modal, trap focus and return it. Layering uses only the stacking scale in `global.css` (`stacking-order.test.ts`).
- Locale: numbers, dates, currency and units through `Intl`; message formats for plurals and names inside sentences; buttons, footers and segments wrap instead of clipping; terms from the [UI glossary](../docs/guides/ui-glossary.md).

## Reuse before adding a pattern

Shared blocks live in `desktop/web/src/components/shared/` (`SurfaceHeader`, `DockPanelHeader`, `SurfaceSearch`, `SpeciesIdentity`, `ActionMenu`, `Dropdown`, `DatePicker`, `ButtonTooltip`, `SegmentedControl`, `Switch`, `Notice`, `Toast`, `EmptyState`, `ControlIcon`, `usePointerResize`, `usePointerReorder`, `PlantFinder`). They own presentation or an interaction lifecycle; callers keep domain actions.

## Working method

1. Find the surface on its board and in the gallery. Read its pattern file, component, authority seam and tests.
2. Implement through existing authorities with focused behavioural tests. Review populated, empty, long and French states, light and dark, keyboard and pointer, narrow and short viewports.
3. When the change sets a reusable decision, update the pattern file, the board and a gallery fixture together.

## Executable reference

Boards: `python3 .interface-design/boards/build.py`, then `serve.py`. Gallery: `cd desktop/web && npm run dev:ui`; `?surface=workspace` mounts the Desktop workspace (add `edition=web` for Web); direct surfaces take `state=` (see its README), `theme=dark` or `locale=fr`. `npm run typecheck` includes the gallery project.
