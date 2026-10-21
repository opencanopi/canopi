# Editions

Covers: `desktop/web/src/web/`, `desktop/web/src/platform/`, `desktop/web/src/main.web.tsx`, `desktop/web/ui-gallery/`, `desktop/web/web.html`, `scripts/web_release.py`

## Purpose

One frontend ships as a Desktop edition (Tauri), a Web edition (static bundle) and a memory-only UI gallery for development. This guide states where the editions differ, who owns each difference and what a change must not do. The scope decision is [ADR 0005](../adr/0005-web-edition-scope.md); the shared architecture is in [architecture](../architecture.md#editions).

## Authorities and boundaries

- Entries: `desktop/web/src/main.tsx` with `index.html` (Desktop) and `main.web.tsx` with `web.html` (Web). The codec, scene runtime, workbenches, Design Edit and `components/workspace/WorkspaceComposition.tsx` are shared; `DesktopWorkspace.tsx` and `web/WebWorkspace.tsx` bind the edition's capabilities.
- Every edition difference is a compile-time alias (`desktop/web/vite.config.ts`, mirrored in `tsconfig.json`; the UI gallery maps the same aliases to its memory fixtures) or an injected capability (for example `context.edition` in `app/analyses/model.ts`). These are the only aliases:

| Alias | Desktop | Web |
| --- | --- | --- |
| `#platform` | `platform/desktop.ts` | `platform/browser.ts` |
| `#species-catalog-live` | `app/plant-browser/live.desktop.ts` (SQLite over IPC) | `app/plant-browser/live.browser.ts` (DuckDB-WASM) |
| `#geocoding-transport` | `app/geocoding/transport.desktop.ts` (native HTTP) | `app/geocoding/transport.browser.ts` (`fetch`) |
| `#canvas-pdf-platform` | `app/canvas-pdf/platform.desktop.ts` (dialog + `save_canvas_pdf`) | `app/canvas-pdf/platform.browser.ts` (download) |
| `#budget-export-platform` | `app/budget/platform.desktop.ts` | `app/budget/platform.browser.ts` |

- Commands: `app/shell-commands/index.ts` owns the neutral command ids; the Desktop command graph and `web/browser-shell-commands.ts` each declare the capabilities their edition supports. The Web set has no Recent Designs, Design Notebook, Problem Report, updater or native window controls, and drops the shortcuts a browser keeps (`BROWSER_RESERVED_SHORTCUTS`: Ctrl 1–9, Ctrl N, Ctrl Q, Ctrl W).
- Web data: `web/browser-app-data.ts` owns four independent localStorage records (Drafts, Settings, Species activity, Saved Object Stamps). Drafts are the Web Design home; a downloaded `.canopi` is an export. `web/browser-draft-persistence.ts` asks the browser to keep them, once per launch at most, nothing stored (2.1-Q82, Q191, M180): first visits by New or Open, existing users by Keep my drafts (Q198), never without a reason on screen; Desktop never reaches it. Document hosts are described in [design document](design-document.md).
- Phone layout: the Browser App Shell owns `installPhoneLayout` (`app/shell/phone-layout.ts`): `portrait` below 640 px wide, `landscape` when wider than tall, under 480 px tall and under 960 px wide, else null. `WorkspaceComposition` shows `components/shared/PhoneSheet.tsx` instead of the dock only when the edition passes `phoneTabs`; Desktop passes none. Design: [controls and shell](../../.interface-design/patterns/controls-and-shell.md).
- Web maps and catalog: the same providers and geocoding registry as Desktop; no local raster processing, so Web has no Site data panel, Profile or Data library. The catalog is the reduced Parquet artifact ([species catalog](species-catalog.md)).
- Show my location is Web only in 2.0: `WebCanvasWorkspace` passes `CanvasChrome` its `myLocation` button, shown only in a secure context with `navigator.geolocation`, and the Web map contribution adapter its `readUserLocation`; Desktop passes neither, since its WebViews' location permissions are unhandled or untested (canopi-a1n2). The rules are in the [map workspace](map-workspace.md) guide.
- Publishing: this repository owns the Web source, adapters, catalog artifact and packaging. The website repository and deployment consume only the built archive and never import app modules, generated contracts, CSS or catalog generators.

## Rules

- Shared modules never branch on the edition to choose I/O; add an alias or a capability. The Web entry graph must not reach `@tauri-apps/**` or `ipc/**`, and the alias table stays in sync with `WEB_EDITION_ALIAS_TARGETS` (`__tests__/frontend-architecture-policies.test.ts`: "Web entry stays outside the Desktop app graph", "resolves every edition alias to the Web target Vite uses").
- Web chunks carry no Tauri markers (`__TAURI__`, `__TAURI_INTERNALS__`), no raw DuckDB or Desktop raster-decoder `.wasm` and no asset over 25 MiB: `desktop/web/scripts/check-web-build-boundaries.mjs`, run by `npm run build:web` (`__tests__/web-build-configuration.test.ts`). Never weaken it.
- The Web shell renders only browser-safe commands and chrome (`__tests__/web-app-shell.test.tsx`, `web-shell-projection.test.ts`).
- A missing, corrupt or foreign browser record reads as empty; a failed write returns `{ ok: false }` and keeps the previous record. 2.0 keeps its records under `canopi:web-app-data:v3:*`; the 1.x keys (`canopi:web-app-data:v1` and every `canopi:web-app-data:v2:*`) are never read, written or deleted (ADR 0021); while any of them is there the shell says "Earlier data not opened" once, kept by a marker key that is cleared once none is left, and again if the marker cannot be written (`__tests__/browser-app-data.test.ts`, `bootstrap-shell.test.ts`).
- The persistence request runs before the click's first `await` (Firefox's prompt needs the activation); a denied permission or a missing API never calls `persist()`; no warning before a first visit's ask (`__tests__/web-draft-persistence.test.ts`).
- Phone classification and the sheet's heights and keys are pure and tested (`__tests__/phone-layout.test.tsx`).
- The Templates entry appears only when `web/static-design-templates.ts` configures one; the default set is empty (`__tests__/web-static-design-template-catalog.test.ts`).
- Web Layers' Site data row reads "N terrain or height layers in this Design · Needs Canopi Desktop", absent with none, and the `lidar` section round-trips unchanged (`__tests__/web-layers-panel.test.tsx`).
- The packaged archive is flat (`index.html`, `assets/`, `canopi-catalog/`, `canopi-web-edition-manifest.json`); the manifest records version, commit, base path, fallback, catalog metadata and every file's size and SHA-256; packaging rejects raw `duckdb-*.wasm`, symlinks and files over 25 MiB (`__tests__/web-edition-packaging.test.ts`).
- Ports are strict (`strictPort: true` in every Vite config) and each host has its own dependency cache, so all three hosts run at once (advice).

## Do not

- Do not branch on `isWeb` / `isTauri`; there is no such flag, and a policy test would reject the platform import you would need.
- Do not accept another port when 1420, 1421 or 1422 is busy; stop the existing owner.
- Do not deploy the `/app/` artifact at a domain root or rewrite its URLs after packaging; build the root artifact instead.
- Do not let a missing asset return the shell: static files are served before the SPA fallback.
- Do not point an isolated session at a real user Design; on Linux isolate Desktop with fresh `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` (a separate Cargo target does not isolate app data).
- Do not report a jsdom click as proof of WebView behaviour; say which host was driven (gallery, Web, `cargo tauri dev` or a packaged app).
- Do not copy production markup into the gallery; add a fixture.

## Development hosts

Toolchain: Node `^22.13.0` (`engines` in `desktop/web/package.json`), Python 3, the Rust version in `rust-toolchain.toml`. Install with `npm ci --prefix desktop/web`. The first dev, test or build run downloads the pinned PDF fonts into ignored `desktop/web/public/pdf-fonts/`.

| Host | Command | Address | Data |
| --- | --- | --- | --- |
| Desktop | repository root: `cargo tauri dev` | native window; Vite on `http://localhost:1420/` | real app data and files; needs `desktop/resources/canopi-core.db` (`python3 scripts/prepare-db.py`) for the catalog |
| Web | `desktop/web/`: `npm run dev:web` | `http://localhost:1421/app/` | browser profile storage; catalog needs `npm run generate:web-catalog` (ignored `public/canopi-catalog/`) |
| UI gallery | `desktop/web/`: `npm run dev:ui` | `http://127.0.0.1:1422/` | memory fixtures; reload resets ([gallery README](../../desktop/web/ui-gallery/README.md)) |

`npm run check:editions` typechecks the app and the gallery and builds both bundles (with the boundary scan); it runs no tests. Clearing site data for `localhost:1421` resets every Web record. With `edition=web` the gallery shows the phone layout in a phone-sized window (390×844, 844×390).

## Web publishing

```bash
cd desktop/web && npm run package:web        # /app/ base, SPA fallback /app/* -> /app/index.html
cd desktop/web && npm run package:web:root   # CANOPI_WEB_BASE_PATH=/ for web.projectcanopi.com
scripts/publish-web-release.sh --tag v<version> [--artifact <archive>] [--verify-only]
```

Both packagers need the generated catalog (`npm run generate:web-catalog`) and write to ignored `desktop/web/dist-web-artifacts/`; the `/app/` artifact serves local review ([review checklist](../review-checklist.md)). Every release ships the Web Edition:

- `publish-db-release.sh` puts the Web catalog, generated from the DB's export, on `canopi-core-db` under its identity name; the Release Candidate's `web` job packages the root artifact with it at the release commit; promotion attaches the archive with `WEB-RELEASE-SHA256SUMS.txt`.
- After publishing, `publish-web-release.sh` deploys the release's archive to Cloudflare Pages project `canopi-web` (production branch `production`, `web.projectcanopi.com`, ADR 0005) with the operator's logged-in wrangler; GitHub holds no Cloudflare secret.
- It verifies the archive (`scripts/web_release.py`), deploys and checks the preview branch `release-<version>`, then deploys production, waits for its manifest and checks it; a production that already serves the release and passes its HTTP checks is only checked. Deploys name the exact commit.

Hosting rules: the deploy owns `_headers` and an empty `404.html` in `assets/`, `canopi-catalog/` and `pdf-fonts/`, so a missing file there is a 404 while other routes fall back to `index.html` (Pages' own SPA fallback: no top-level `404.html`, no `_redirects`). `index.html`, the manifest, `canopi-catalog/**` and `pdf-fonts/**` are not content-hashed, so the host revalidates them; only `assets/*` is cached immutably. Every response carries `nosniff` and `strict-origin-when-cross-origin`.

Any CSP allows `cdn.jsdelivr.net` (DuckDB loads its WASM from there: script, worker and connect), `tiles.openfreemap.org`, `mt1.google.com`, `tile.googleapis.com`, `s3.amazonaws.com` (terrain), `nominatim.openstreetmap.org` and the catalog's photo hosts `inaturalist-open-data.s3.amazonaws.com`, `commons.wikimedia.org` and `upload.wikimedia.org`.

Release checks (`web_release.py`; `desktop/web/e2e-release/` in the pinned Playwright image, Chromium and WebKit): manifest identity and no-cache; `/`, `/designs` and `/a/b/c` serve the shell; one asset per extension with its checksum and content type; missing assets answer 404; TLS on the custom domain. Cloudflare injects a hidden link into HTML on the custom domain, so HTML is compared byte for byte only on the preview.

The browser smoke walks a new Design, place search, catalog search (a cold DuckDB-WASM load takes 15-20 s) and filter, a drawn zone and undo, a `.canopi` download free of the key and location, reload and a deep route, with no page or console error or failed response.

## Where to look

| Area | Module | Tests |
| --- | --- | --- |
| Aliases and entries | `desktop/web/vite.config.ts`, `tsconfig.json`, `src/platform/` | `frontend-architecture-policies.test.ts`, `web-dev-entry.test.ts` |
| Web shell and commands | `src/web/BrowserAppShell.tsx`, `src/web/browser-shell-commands.ts` | `web-app-shell.test.tsx`, `web-shell-projection.test.ts` |
| Web document host | `src/web/WebCanvasWorkspace.tsx`, `src/web/browser-design-session.ts` | `web-canvas-workspace.test.tsx`, `web-design-session.test.ts` |
| Browser records | `src/web/browser-app-data.ts` | `browser-app-data.test.ts` |
| Phone layout | `src/app/shell/phone-layout.ts`, `src/components/shared/PhoneSheet.tsx` | `phone-layout.test.tsx` |
| Web packaging | `desktop/web/scripts/package-web-edition.mjs`, `check-web-build-boundaries.mjs` | `web-edition-packaging.test.ts`, `web-build-configuration.test.ts` |
| UI gallery | `desktop/web/ui-gallery/` | `ui-gallery-*.test.ts(x)` |
