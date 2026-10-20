# Web Edition scope

Status: Accepted (2026-09-25, Canopi v2); amended 2026-10-16 (canopi-afru: every release deploys the Web Edition; 2.1 target: exports are the FileDelivery rows, edition roots, no Templates) and 2026-10-17 (2.1 target: the format core worker, Q34; aligned with Desktop by default, ledger 2.1-Q60, 2.1-Q65, 2.1-Q82, 2.1-Q84, 2.1-Q85, 2.1-Q111 to 2.1-Q116, 2.1-Q122, 2.1-E5, 2.1-M8, 2.1-M47)

## Context

The Web Edition is a browser build of the real Canopi app. It must stay deployable as static files without a backend while sharing the Design format, codec, runtime and workbenches with Desktop. The user decided that Web and Desktop are aligned by default (2.1-Q111); this ADR lists what is specific to serving Canopi from a browser, and [ADR 0030](0030-edition-parity.md) owns every difference.

## Decision

- **Static app.** The Canopi repository builds a versioned static artifact with a manifest (app version, commit, asset inventory, SHA-256 checksums). Every release builds that artifact and deploys it (`scripts/publish-web-release.sh`); website repositories never import app source. The one stable host is `web.projectcanopi.com` at the root, and betas deploy to a beta-only origin with its own storage (2.1-M22, 2.1-M47); the `/app/` subpath build and the root and non-root split are deleted (2.1-Q85). No backend, tile proxy or account; serving rules are in [ADR 0029](0029-system-qualities.md).
- **Offline** (2.1-Q116). A service worker caches the app and the DuckDB binaries, self-hosted on a Canopi-owned R2 bucket because they exceed the Pages file cap (no jsDelivr or other third-party host); it caches catalog pieces as they are read, as fixed-size blocks, and answers range requests from them, and offers "Keep the catalog for offline use" (mechanism in [ADR 0029](0029-system-qualities.md) Static Web serving). No PWA install prompt, bundled tile pyramids, bulk download or offline map archive.
- **Browsers.** Chromium, WebKit and Firefox are supported and each runs in CI (2.1-Q84).
- **Real Designs.** Web creates, opens, edits and downloads real `.canopi` files through the normal Design Session seams. The only Design save format is a `.canopi` download. Exports are the FileDelivery rows ([ADR 0027](0027-extension-points-and-exports.md)).
- **Browser-local data.** Design Drafts (the home of every Web Design, one IndexedDB record each, saved continuously per [ADR 0009](0009-continuous-save.md) and listed on the welcome screen), settings, favourites and activity, saved stamps and the Design Notebook ([ADR 0007](0007-design-objects-and-personal-libraries.md)) live in independent browser-local records, migrated per [ADR 0026](0026-stored-data-after-2-0.md). Persistence is requested on the first Draft (2.1-Q82). No accounts or sync; clearing site data loses them, and a downloaded `.canopi` file is the portable copy.
- **Catalog.** Web reads the full catalog, every field, filter, photo and fact, on demand by range requests (2.1-Q113, [ADR 0006](0006-species-catalog-storage.md)).
- **Geocoding allowed.** Web uses the shared geocoding provider registry from the browser, under the rules both editions share ([ADR 0001](0001-geolocated-map-canvas.md) Geocoding). No proxy.
- **Maps.** Web shows the same basemap, Google satellite imagery and terrain as Desktop, with their attribution. Google uses its public tiles without a key and the official Map Tiles API with the user's own device key.
- **Site data on Web** (2.1-Q114, 2.1-Q65), in 2.1 (2.1-Q122, plan N5). Rasters and bring-your-own vectors, the kinds 2.1 imports, go into the browser's private file storage at Desktop's behaviour up to a stated, measured size limit, with display, pin, Profile and the slope, aspect and frost-pocket analyses run by the same Rust engine in a worker. Over the limit and hydrology stay Desktop, a genuine row of ADR 0030; until N5 lands, ADR 0030 carries the rest as a pending row. Point clouds come to both editions with the point-cloud release (2.1-Q79), under the same limit rule (2.1-Q114).
- **Problem reports** (2.1-Q60). Web offers Report a problem as a downloaded bundle with Desktop's contents and redaction ([ADR 0025](0025-failure-model-and-native-scheduling.md)). Nothing is uploaded; the user chooses how to share it.
- **Shell.** A browser app shell wraps the shared workspace composition. It shows no native window controls, Recent Design paths, reveal actions or updater.
- **Compile-time adapters.** Desktop and Web have separate build entries; each edition root imports its own adapters ([ADR 0022](0022-module-map-and-dependency-direction.md)). Build checks reject Tauri and other desktop imports in Web chunks.
- **Deleted on Web.** Design Templates (user, 2026-10-16) and the World map with them (2.1-E5).
- **One format core worker** (Q34, 2.1-M154, [ADR 0026](0026-stored-data-after-2-0.md)). Both editions run `canopi-format` as wasm in one dedicated worker owned by `platform/design-core.worker.ts`, loaded at boot; Desktop links it natively only for data on disk. Its states are loading, ready, load-failed and poisoned then respawned ([ADR 0025](0025-failure-model-and-native-scheduling.md)). Linear memory never shrinks (a 64 MiB Design peaks the web process near 1.5 GiB), so the worker is recycled after a large open.
  - The `.wasm` is built from source in `build`, `build:web` and CI and never committed. A CI check matches the wasm-bindgen crate in `Cargo.lock` with the CLI, one Renovate group bumps both, and a test checks that the adapter's reported core version equals the crate version.

## Consequences

- One codec and runtime serve both editions, so format support cannot drift.
- Web has no durable storage beyond browser records, its private file storage and downloaded files.
- Third-party tile and geocoding outages remove only that background or search; editing continues.
- The Web build boundary check enforces this scope and must not be weakened.
