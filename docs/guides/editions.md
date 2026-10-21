# Editions

Covers: `desktop/web/src/web/`, `desktop/web/src/platform/`, `desktop/web/src/main.web.tsx`, `desktop/web/ui-gallery/`, `desktop/web/web.html`, `scripts/web_release.py`

## Purpose

One frontend ships as a Desktop edition (Tauri), a Web edition (static bundle) and a memory-only UI gallery for development. Scope: [ADR 0005](../adr/0005-web-edition-scope.md); shared architecture: [architecture](../architecture.md#editions).

## Authorities and boundaries

- Entries: `main.tsx` with `index.html` (Desktop) and `main.web.tsx` with `web.html` (Web). The codec, scene runtime, workbenches, Design Edit and `WorkspaceComposition` are shared; `DesktopWorkspace.tsx` and `web/WebWorkspace.tsx` bind the edition's capabilities.
- Every edition difference is a compile-time alias (`vite.config.ts`, mirrored in `tsconfig.json` and the gallery's fixtures) or an injected capability (for example `context.edition` in `app/analyses/model.ts`). These are the only aliases:

| Alias | Desktop | Web |
| --- | --- | --- |
| `#platform` | `platform/desktop.ts` | `platform/browser.ts` |
| `#species-catalog-live` | `live.desktop.ts` | `live.browser.ts` |
| `#geocoding-transport` | `transport.desktop.ts` | `transport.browser.ts` |
| `#canvas-pdf-platform` | `platform.desktop.ts` | `platform.browser.ts` |
| `#budget-export-platform` | `app/budget/platform.desktop.ts` | `app/budget/platform.browser.ts` |

- Commands: `app/shell-commands/index.ts` owns the neutral ids; the Desktop graph and `web/browser-shell-commands.ts` declare what their edition supports. Web has no Recent Designs, Design Notebook, Problem Report, updater or native window controls, and drops the shortcuts a browser keeps (`BROWSER_RESERVED_SHORTCUTS`).
- Web data: `web/browser-app-data.ts` owns four localStorage records (Drafts, Settings, Species activity, Saved Object Stamps) and one per-tab sessionStorage record, what the tab had open at a release reload, its Draft or none (2.1-Q189; session state, not user work). Drafts are the Web Design home; a downloaded `.canopi` is an export. `web/browser-draft-persistence.ts` asks the browser to keep them, at most once per launch (2.1-Q82, Q191, M180): first visits by New or Open, existing users by Keep my drafts (Q198), never without a reason on screen.
- Release watch: `web/browser-release-watch.ts` reads the edition manifest on focus and on becoming visible (each at most once a minute) and on every `vite:preloadError`. Any release other than the tab's own, older included, shows one dismissible New version: Reload notice (2.1-Q83, Q186, Q187, M179); after a dismissal reads compare against the dismissed release, and a failed lazy import shows it again.
- Reload saves first through the session's flush loop (Retry, Download a copy, Reload without saving, Cancel; Q188), then reopens what this tab had, its Draft or the start screen, never the newest Draft; Dismiss is off while it saves.
- Shell notices share one row under the title bar; any shell notice, whatever its tone, holds it over a waiting release, which returns once it is dismissed (2.1-M182). Desktop reaches neither the persistence request nor the release watch (its assets ship in the binary).
- Phone layout: the Browser App Shell owns `installPhoneLayout` (`portrait` below 640 px wide; `landscape` when wider than tall, under 480 px tall and 960 px wide). `WorkspaceComposition` shows `PhoneSheet` instead of the dock only when the edition passes `phoneTabs`. Design: [controls and shell](../../.interface-design/patterns/controls-and-shell.md).
- Web maps and catalog: Desktop's providers and geocoding; no local raster processing, so no Site data panel, Profile or Data library. The catalog is the reduced Parquet artifact ([species catalog](species-catalog.md)).
- Show my location is Web only in 2.0, in a secure context with `navigator.geolocation`; Desktop WebViews' location permissions are unhandled (canopi-a1n2). Rules: [map workspace](map-workspace.md).
- Publishing: this repository owns the Web source, adapters, catalog artifact and packaging. The website repository consumes only the built archive and never imports app modules, contracts, CSS or generators.

## Rules

- Shared modules never branch on the edition to choose I/O; add an alias or a capability. The Web entry graph never reaches `@tauri-apps/**` or `ipc/**`, and the alias table matches `WEB_EDITION_ALIAS_TARGETS`.
- Web chunks carry no Tauri markers, no raw DuckDB or Desktop raster-decoder `.wasm` and no asset over 25 MiB (`npm run build:web` checks). Never weaken it.
- The Web shell renders only browser-safe commands and chrome.
- A missing, corrupt or foreign browser record reads as empty; a failed write returns `{ ok: false }` and keeps the previous record. 2.0's records are `canopi:web-app-data:v3:*`; the 1.x keys (`canopi:web-app-data:v1`, every `canopi:web-app-data:v2:*`) are never read, written or deleted (ADR 0021); while one exists the shell says "Earlier data not opened" once, kept by a marker key cleared once none is left, and again if the marker cannot be written.
- The persistence request runs before the click's first `await` (Firefox's prompt needs the activation); a denied permission or missing API never calls `persist()`; no warning before a first visit's ask.
- Only the release watch listens for `vite:preloadError`, and it never prevents it: the import error proceeds as before. A manifest it cannot read (offline, missing, malformed; dev and `vite preview` have none) is silent and logs nothing.
- Phone classification and the sheet's heights and keys are pure and tested.
- The Templates entry appears only when `web/static-design-templates.ts` configures one; the default set is empty.
- Web Layers' Site data row reads "N terrain or height layers in this Design · Needs Canopi Desktop", absent with none; the `lidar` section round-trips unchanged.
- The packaged archive is flat (`index.html`, `assets/`, the catalog under `assets/catalog/<id>/`, `canopi-web-edition-manifest.json` with version, commit, base path, fallback, catalog metadata and every file's size and SHA-256); packaging rejects raw `duckdb-*.wasm`, symlinks and files over 25 MiB.
- Ports are strict and each host has its own dependency cache, so all three run at once (advice).

## Do not

- Do not branch on `isWeb` / `isTauri`; there is no such flag.
- Do not accept another port when 1420, 1421 or 1422 is busy; stop the existing owner.
- Do not deploy the `/app/` artifact at a domain root or rewrite its URLs; build the root artifact.
- Do not let a missing asset return the shell: static files are served before the SPA fallback.
- Do not point an isolated session at a real user Design; on Linux isolate Desktop with fresh `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME`.
- Do not report a jsdom click as proof of WebView behaviour; name the host driven.
- Do not copy production markup into the gallery; use a fixture.

## Development hosts

Toolchain: Node `^22.13.0`, Python 3, `rust-toolchain.toml`; `npm ci --prefix desktop/web`.

| Host | Command | Address | Data |
| --- | --- | --- | --- |
| Desktop | root: `cargo tauri dev` | Vite on `localhost:1420` | real app data; catalog from `scripts/prepare-db.py` |
| Web | `desktop/web/`: `npm run dev:web` | `localhost:1421/app/` | browser profile; the catalog needs `npm run generate:web-catalog` |
| UI gallery | `desktop/web/`: `npm run dev:ui` | `127.0.0.1:1422` | memory fixtures ([README](../../desktop/web/ui-gallery/README.md)) |

`npm run check:editions` typechecks and builds both editions; no tests. Clearing site data for `localhost:1421` resets all Web records.

## Web publishing

```bash
cd desktop/web && npm run package:web        # /app/ base
cd desktop/web && npm run package:web:root   # CANOPI_WEB_BASE_PATH=/ for web.projectcanopi.com
scripts/publish-web-release.sh --tag v<version> [--artifact <archive>] [--verify-only]
```

Both packagers need the generated catalog; the `/app/` artifact serves local review ([review checklist](../review-checklist.md)). Every release ships the Web Edition:

- `publish-db-release.sh` puts the Web catalog on `canopi-core-db` under its identity name; the Release Candidate's `web` job packages the root artifact with it; promotion attaches the archive with `WEB-RELEASE-SHA256SUMS.txt`.
- `publish-web-release.sh` deploys it to Cloudflare Pages project `canopi-web` (branch `production`, `web.projectcanopi.com`, ADR 0005) with the operator's logged-in wrangler; GitHub holds no Cloudflare secret.
- Before any deploy, `web_release.py` verifies the archive and finds N-1, the greatest published stable release below N with a Web archive (`--previous-tag` overrides; production must serve N-1 or N; `--no-previous` only while production serves no manifest), admits it by its checksums and manifest, and merges its files into N: N wins a shared path, any other differing collision fails, and the Pages limits (20,000 files, 25 MiB each, no raw DuckDB WASM) apply to the merged set.
- Only stable `vX.Y.Z` tags publish; a Web beta needs its own origin (ADR 0029). Each deploy names its tag's full commit.
- Deploy skew (2.1-Q83): the run fails unless N-1's PDF job chunk is one N lacks (`--allow-unchanged-pdf-chunk` waives that proof alone). On `canopi-web-preview` (`web-preview.projectcanopi.com`) it deploys N-1, opens an N-1 tab (`e2e-release/deploy-skew.spec.ts`), deploys merged N, and checks that the tab loads the chunk, reads the catalog and saves. Failed browser checks keep their traces beside the run's log. A 2.0.2 tab has no notice; until a real N-1 carries it, the notice and Reload are proven against a routed manifest (`e2e/canvas/release-notice.spec.ts`, Q197).
- It then checks the preview, deploys production, waits for its manifest and checks it; a production already serving the release is only checked.

Hosting rules (ADR 0029):

- Every file a release writes except `index.html`, the manifest and `sw.js` sits under `assets/`, as `<name>-<16-character hash>.<ext>` or in `assets/catalog/<first 16 hex of its manifest's SHA-256>/` with only the manifest's files (2.1-M176). `web_release.py verify` refuses other names among this release's files, never among carried ones.
- The deploy owns `_headers`, generated from the deployed set, and an empty `404.html` per top-level directory, so a missing file is a 404 while other routes fall back to `index.html`. The manifest is `no-cache`, `assets/*` immutable, a carried fixed-name directory (2.0.2's `canopi-catalog/`, `pdf-fonts/`) `no-cache` while carried; the shell keeps Pages' revalidation. Every response sends `nosniff` and `strict-origin-when-cross-origin`.
- The zone Cache Rule `Canopi Web catalog Parquet ranges` (hosts `web` and `web-preview`, `/assets/*.parquet`) makes the custom domains answer ranges with 206; DuckDB-WASM reads the catalog only by range. `*.pages.dev` answers no range, so checks run on custom domains.
- Rollback is "Rollback to this deployment" on `canopi-web`: it serves that deployment's merged set, and open tabs of the newer release see another release in the manifest and offer Reload (Q186).

Any CSP allows `cdn.jsdelivr.net` (DuckDB's WASM: script, worker and connect), `tiles.openfreemap.org`, `mt1.google.com`, `tile.googleapis.com`, `s3.amazonaws.com` (terrain), `nominatim.openstreetmap.org` and the catalog's photo hosts `inaturalist-open-data.s3.amazonaws.com`, `commons.wikimedia.org` and `upload.wikimedia.org`.

Release checks (`web_release.py`, `e2e-release/`):

- HTTP: manifest identity, never immutable; deep routes serve the shell and revalidate; one asset per extension with checksum, type and immutability; 206 with Content-Range on a catalog Parquet; one carried file per carried directory byte-exact; missing files 404; TLS. HTML is compared by its module entry (Cloudflare injects a link on custom domains).
- Browser: a new Design, place search, catalog search and filter (every Parquet response a 206), a drawn zone and undo, a `.canopi` download free of the key and location, reload and a deep route, with no page or console error or failed response.
