# UI gallery

From `desktop/web/`, run `npm run dev:ui` and open http://127.0.0.1:1422/. Typecheck it with `npm run check:ui`.

## What it is

The gallery mounts production workspace and panel components over memory fixtures (`fixtures.ts`, `memory-backend.ts`, `memory-dialogs.ts`). No user database, Design, settings store or file is read or written; a reload resets the session. It lives outside `src` and the normal build inputs, its Vite config rejects builds, and it owns a separate dependency cache so it runs beside Desktop Vite (1420) and the Web edition (1421). The port is strict: stop the existing owner instead of accepting another port.

The canvas is the production shared workspace (MapLibre and its Pixi scene layer, `gallery-workspace-runtime.ts`) with at most one live runtime. It works offline and deterministically because Basemap and Satellite stay hidden, whatever the Layers panel shows; the map draws only its local background and fetches no tiles. It needs WebGL2; without it the map is unavailable and the status line says so. A map that stops drawing shows the production map notice with Retry, which rebuilds it as the app does.

## Surfaces

`?surface=` (`surface-routing.ts`; an unknown value falls back to a known surface):

- `workspace` (the real edition command projection and shared workspace composition), `start`
- `color`, `symbol`, `symbols` (the plant symbol sheet), `key`, `menu-plant`, `menu-mixed`, `menu-empty`
- `layers`, `site-data` (Desktop), `library`, `import`, `analyze` (the data workflow dialogs)
- `calendar`, `calendar-expanded`, `budget`, `consortium`, `favorites`, `notebook` (Desktop only)
- `stories` (the Stories panel on its third step; `state=empty` has no story, `state=long` a long step title; `present=1` presents the story from that step, flying there unless the browser prefers reduced motion, so captures emulate `prefers-reduced-motion: reduce`)
- `lens`, `snapshots` (off-screen saved-view snapshots with their timings, flags and attribution; offline unless `tiles=1`)
- `location` (Location button: the Web zoom group's Show my location in one state, drawn without a device location)

## Parameters

- `state=populated|empty|mixed|long|located|dense|planting|zone|overview|max-zoom`. `surface=start&state=empty` is the first run; `long` gives long names and a 40-item Data library; `dense` is for Inspection Lens review; `planting` shows every plant symbol in a dense planting; `zone` shows the selection chip on one unnamed rectangle zone.
- Site data states: `lidar-progress` shows imports and calculations in the library and in Site data; `lidar-failure` a failed attachment; `lidar-missing` two entries no library here has; `lidar-long` twelve entries (the filter shows above 8); `lidar-raster` places the Design on the Rust engine's elevation COG, inside the relief it wrote around the same source (`src/maplibre/raster-display/fixtures/`): the ground elevation draws its relief on Relief through Desktop's raster renderer, and its elevation once a Colours ramp is picked; `no-design` opens no Design.
- `open=<id>`: on `site-data`, the Site data item opened under its row; on `library`, the selected item.
- `sampleDelay=<ms>`: each `lidar_sample_points` answer waits this long. The memory backend samples an analytic site (ground elevation 140 + 30·sin, the surface 6 m above, a canopy 6 ± 4 m, slope from the ground's gradient; no data outside an item's bounds, which cover the west of the fixture Design) and throws on a request over `LIDAR_SAMPLE_MAX_TARGETS` or `LIDAR_SAMPLE_MAX_POINTS`, so the test that sent it fails; Rust's refusal is tested in Rust.
- `bearing=<degrees>` turns the map clockwise from north once the Design is fitted (the compass, a turned grid); absent, 0 or not a number keeps north up.
- `location=off|following|moved-away|blocked|stale` on `location` (default `following`); `stale` is Following with the position unavailable.
- `plantDb=corrupt|missing` (the plant database notice), `theme=dark`, `locale=fr`, `panelWidth=320|352|480|800`.
- `platform=mac|linux`: F1's gesture rows as on a Mac with trackpad gestures (Control-click, the twist), or on Linux with Desktop's pinch note (Desktop only). Only F1 reads it; press F1 on the workspace.
- `edition=web` uses browser-safe registrations. In a phone-sized window (390×844 or 844×390) it shows the phone layout; between 640 and 760 px the stacked dock. Edition links reload the page so two canvas owners never mount together.

Calendar fixtures use September 2026 so visual reviews are deterministic. Settings › Files and data shows memory folder paths; Show in folder and the Recent Designs More menu only report in the activity line. Export and import use memory fixtures; the Web catalog is memory data. File › Export › Planting plan (PDF) opens the real print workspace, which imports the prepared fonts (`npm run prepare:pdf-fonts`) as the app does; the memory backend supplies catalog habits, so the key shows its habit groups.

## Browser checks

`e2e/gallery/*.spec.ts` drive the gallery in Chromium and WebKit (Playwright projects `gallery-chromium` and `gallery-webkit`; `playwright.config.ts` starts only this server for them, so the lane needs no `npm run build:web`). Specs import `test` from `e2e/support/gallery.ts`, which keeps the page offline, fails on console errors and stubs the clipboard; `openGallery` waits for `data-gallery-ready`.

WebKit runs in the pinned image: from the worktree root, `docker run --rm --ipc=host -v "$PWD":/work -w /work/desktop/web --user $(id -u):$(id -g) -e HOME=/tmp mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test e2e/gallery --project=gallery-chromium --project=gallery-webkit`.

## Limits

The gallery proves neither Tauri IPC, WebView behaviour, browser persistence, DuckDB catalog loading, native dialogs, downloads nor packaged-app behaviour; the [editions guide](../../../docs/guides/editions.md) says how to check those. Add fixtures for new reusable states; never copy production markup into the gallery (`edition-roots`: no `src/` module imports the gallery).
