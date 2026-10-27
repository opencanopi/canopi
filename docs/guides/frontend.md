# Frontend

Covers: `desktop/web/src/`

## Purpose

Boundaries of the Preact frontend in `desktop/web/src/`. Related: [design system](../../.interface-design/system.md), [editions](editions.md), [design document](design-document.md), [map workspace](map-workspace.md).

## Authorities and boundaries

- Stack: [architecture](../architecture.md#stack); banned libraries: [AGENTS.md](../../AGENTS.md). `generated/` is bindings output and never hand-edited.
- Import direction: components → actions/controllers/workbenches → Design Edit or state. Canvas edits go through runtime commands on `currentCanvasSession` (`canvas/session.ts`); non-canvas Design edits through `app/design-edit/`; panels read canvas entities through read-only runtime queries. A view never mirrors an authority's state to restyle it.
- Commands: `commands/registry.ts` is the one public seam over `commands/graph/`. `app/shell-commands/index.ts` owns neutral ids, label keys and shortcut matching; `app/shell-commands/menus.ts` (`composeWorkspaceMenus`) is the one menu model for the menubar, the compact Menu button, the palette and the F1 dialog; `app/workspace-commands/` holds the capabilities and canvas intents both editions share.
- Keys ([ADR 0020](../adr/0020-focus-and-keyboard-ownership.md)): the one key router owns the window key listeners (capture: IME composition, focus class, held keys, a live canvas gesture, F6; bubble: under a modal only its `worksInModal` rows, after the modal's own element handlers; otherwise global rows (Ctrl F asks the open plant finder first), the Stories Undo toast's pushed scope, the Esc chain, then the keymap); a key a focused widget already handled (`defaultPrevented`) is left alone.
- Single keys: they work anywhere except text fields and dialogs and can be switched off; Shift N always resets north. `app/keyboard/keymap.ts` holds the rows (their scope and whether the switch turns them off) and the pushed key scopes (`pushKeyScope`); each edition composes its shell rows and runs them through its own command sink.
- Focus and Esc (ADR 0020): one focus owner (`app/keyboard/focus-owner.ts`) moves focus: F6 / Shift F6 regions, arming a tool from a panel, returning focus after a field. One Esc chain gives each Esc to one thing, the active tool first; Esc and the rotation chords (Shift N, Shift ↑, Shift ←/→) are display-only `keyHints`. `app/shell-commands/shortcut-text.ts` localizes canonical strings (`Ctrl+Shift+Z`) and derives `aria-keyshortcuts`.
- Modal layer: `app/shell/modal-layer.ts` is the one owner. A dialog (the command palette included) holds it through `useModalLayer()`; chrome registered with `useModalInertRegion` becomes `inert`; menus and key routing stand down.
- Visible map area: chrome registers through `components/shared/useMapChrome.ts`; `app/shell/visible-map-area.ts` derives two frames: the chips' frame (the `--map-inset-*` properties) from all registered chrome, and the frame the camera fits into without chrome registered with `frames: false` (status chrome such as the map notice, which comes and goes with load state, and stands in that frame through `--map-framing-inset-*`); also each rail's room and whether credits fold. Both rails fold through `components/shared/rail-fit.ts`.
- Workspace frame: `components/workspace/WorkspaceComposition.tsx` owns primary/side routing, the dock, the phone sheet and the shared dialogs, and validates registered surfaces against the shell projection, so command capabilities decide which panels exist.
- Plant finder: every plant list uses `components/shared/PlantFinder.tsx` over `app/plant-finder/`. `matcher.ts` is pure; `quick-filters.ts` gives Stratum (the Design's) and Form (catalog habit) filters; `map-matches.ts` rings matches only for Plants in this Design through a highlight channel that never selects or dirties. The catalog searches through the workbench's FTS, not the matcher.
- Resource ownership: every runtime, renderer, MapLibre instance, timer, listener, worker and DOM overlay has one lifecycle owner. Application-lifetime owners are installed by `platform/desktop.ts` and `platform/browser.ts` with stored disposers; module-level `effect()` calls dispose under `import.meta.hot.dispose()`.

## Rules

Rule ids in parentheses are rows of `policy/rules.json` and `policy/primitives.json`.

- `components/**` never imports `ipc/**` or `@tauri-apps/**`; `app/**` never imports `components/**` (`tauri-only-in-native-host`, `ipc-only-in-desktop-adapters`, `layer-order`).
- `ipc/**` imports nothing from `app/**` but the types of a port it implements; gates and encoders stay app-side (`layer-order`; `ipc/design.ts` excepted until canopi-m4v0).
- `app/*/controller.ts` modules are leaves; cross-concern orchestration lives in workflow modules with `installX()` / `disposeX()` (`no-controller-imports-controller`).
- Command consumers read the registry and its projections, never `commands/graph/**` or canvas state (`command-graph-only-through-registry`, `keyboard-imports-no-command-targets`, `tool-rail-imports-no-canvas-state`, `menu-bar-imports-no-session-state`).
- The right-click menu runs only its request's scene-edit commands (`context-menu-imports-no-session-or-commands`; `canvas-context-menu-entries.test.ts`).
- Every command with a shortcut appears in File, Edit, View, Tools or Help with that shortcut; Single-key shortcuts off drops character-key shortcuts (Shift N excepted) from routing, rails, menus and F1 together (`commands-registry.test.ts`, `key-router.test.ts`, `keymap.test.ts`).
- While a modal dialog holds the layer, chrome is inert, the menubar opens nothing and the key router runs only rows that work in a modal (`modal-layer.test.tsx`, `key-router.test.ts`). F6 cycles the four regions and returns focus (`focus-owner.test.ts`).
- The visible map frame and rail room follow the registered chrome; a rail folds its last entries into More before covering chrome (`visible-map-area.test.tsx`, `tool-rail.test.tsx`, `panel-rail.test.tsx`).
- The matcher depends only on `utils/species-search-normalization.ts` (`plant-matcher-imports-only-normalization`; `plant-finder-matcher.test.ts`, `plant-finder-quick-filters.test.ts`).
- Species Catalog UI consumes `speciesCatalogWorkbench`, never a storage engine; Web species detail stays behind the reduced adapter (`search-session-only-in-workbench`, `species-detail-imports-no-edition-code`, `web-species-panel-imports-no-plant-detail`). See [species catalog](species-catalog.md).
- Planning panels read `app/planning-projection/` and write through their workbench and Design Edit (`planning-panels-import-no-authorities`).
- `canvas/runtime/**` never imports `i18n` or settings; it receives them through `CanvasRuntimeAppAdapter` (`canvas-runtime-reaches-no-settings-or-i18n`).
- Every user-visible string goes through `t()` and exists in all 11 locales (`i18n-completeness.test.ts`); English is sentence case and placeholders fit their field (`i18n-copy.test.ts`); plant symbol names exist per id in every locale (`botanical-symbols.test.ts`). Terms follow the [UI glossary](ui-glossary.md).
- `t()` observes `locale`; components read `locale.value` only to pick localized data or format dates. A species without a name in the interface language shows its English name with the localized mark through `SpeciesIdentity`, fed by the catalog's one `resolveDisplayNames` projection (advice).
- CSS Modules use the spacing, type, radius and transition tokens or an exact exception with a reason (`css-module-policies.test.ts`). Colour tokens instead of raw `rgba()`, and weights 400/600 only (advice).
- Signals: `useSignalEffect` in components, never `signal.value` in a `useEffect` dependency array; `.peek()` for non-dependencies; `batch()` for multi-signal writes; no per-frame unconditional signal writes (advice). Pointer gestures go through `usePointerResize` / `usePointerReorder` (`raw-pointer-listener-only-in-reviewed-owners`).
- Effects: Preact runs `useEffect` and `useSignalEffect` after paint, and since 11 the cleanups of removed components too. Focus moves in `useLayoutEffect`: the focus a surface takes as it opens, or as a control replaces the focused one (`focus-only-in-layout-effect`; each reviewed after-paint focus carries its reason comment). A cleanup that must run before its element leaves the page (a lease, a pointer capture, reading focus) goes there too (advice).
- Tests: write the failing behavioural test first at the command or interaction boundary with real focus, keyboard and pointer events. Suites live in `__tests__/` as `*.test.ts(x)`; colocated tests under `src/` also run. An unhandled error fails the run. `npm run test:coverage` enforces the floors in `vite.config.ts`.

## Do not

- Do not import Tauri, IPC or MapLibre from a component (`maplibre-gl-only-in-maplibre`, `tauri-only-in-native-host`).
- Do not weaken or exempt a policy to pass; reproduce a suspect rule failure in its planted case under `policy/fixtures/rules/<id>/` first.
- Do not route Esc to a command or add a window key listener; register an Esc layer or a key scope with the keyboard owner. A popover's layer goes through `usePopoverEscapeLayer`, live from its first painted frame (`escape-layer-only-through-popover-hook`).
- Do not mount a dialog inside an inert region, or use `window.prompt()`, `confirm()` or `alert()` (WebView blocks them).
- Do not use a native `<select>` or `<input type="date">`; use `Dropdown` and `DatePicker`, never wrapped in a native `label`.
- Do not use `title` on icon-only buttons (`ButtonTooltip` and an `aria-label`), or load fonts from a CDN (`@fontsource` through `styles/fonts.css`).
- Do not mock `i18n` without a reason (partial mocks spread `importOriginal`), or retire a locale key in fewer than all 11 files.
- Do not parse optional numeric input with `parseFloat(v) || 0`; use `Number.isFinite(x) && x >= 0`.

## Where to look

| Area | Module | Tests |
| --- | --- | --- |
| Policies | `policy/rules.json`, `policy/primitives.json` | `node policy/check.mjs --self-test` |
| Commands and menus | `commands/registry.ts`, `app/shell-commands/`, `app/workspace-commands/`, `app/canvas-commands/` | `commands-registry.test.ts`, `shell-command-catalog.test.ts`, `menu-bar-keyboard.test.tsx` |
| Keys | `app/keyboard/key-router.ts`, `keymap.ts`, `escape-chain.ts`, `app/shell-commands/shortcut-text.ts` | `key-router.test.ts`, `keymap.test.ts`, `escape-chain.test.ts` |
| Modal layer and focus | `app/shell/modal-layer.ts`, `app/keyboard/focus-owner.ts` | `modal-layer.test.tsx`, `focus-owner.test.ts` |
| Visible map area | `app/shell/visible-map-area.ts`, `components/shared/useMapChrome.ts`, `rail-fit.ts` | `visible-map-area.test.tsx`, `tool-rail.test.tsx`, `panel-rail.test.tsx` |
| Workspace frame | `components/workspace/`, `components/canvas/CanvasChrome.tsx`, `components/shared/WorkspaceTitleBar.tsx` | `web-app-shell.test.tsx`, `phone-layout.test.tsx` |
| Plant finder | `app/plant-finder/`, `components/shared/PlantFinder.tsx` | `plant-finder-*.test.ts(x)` |
| Planning panels | `app/budget/`, `app/timeline/`, `app/consortium/`, `app/planning-projection/` | `budget-*`, `calendar-*`, `consortium-*` |
| Localization | `i18n/`, `components/shared/SpeciesIdentity.tsx` | `i18n-completeness.test.ts`, `i18n-copy.test.ts`, `botanical-symbols.test.ts` |
| Styling | `styles/global.css`, `*.module.css` | `css-module-policies.test.ts` |
