<p align="center">
  <img src="desktop/web/src/assets/canopi-logo.svg" width="80" height="80" alt="Canopi logo" />
</p>

<h1 align="center">Canopi</h1>

<p align="center">
  <strong>Agroecological design for permaculture, syntropic agriculture, and food forests</strong>
</p>

<p align="center">
  <a href="https://github.com/opencanopi/canopi/releases/latest"><img src="https://img.shields.io/github/v/release/opencanopi/canopi?style=flat-square&color=A06B1F&label=release" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-A06B1F?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-A06B1F?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/languages-11-A06B1F?style=flat-square" alt="Languages" />
</p>

Canopi combines a Plant catalog with a design canvas that is the map itself: every Design is geolocated and drawn over a basemap, satellite imagery, LiDAR and terrain. The desktop app runs on Linux, macOS and Windows. The Web Edition shares the canvas, planning panels, stories, PDF export and `.canopi` format with a reduced catalog and browser-local drafts; desktop adds the full catalog, the Data library with terrain analyses, the Design notebook and native file management.

## Features

- **Plant catalog**: ecological, morphological and agronomic data with search, filters, detail cards and favourites in 11 languages.
- **Map canvas**: plants, zones, text notes, groups, measurements, stamps, undo/redo and a grid on a MapLibre map with OpenFreeMap basemaps, satellite imagery, contours, hillshade and place search.
- **Planning**: Calendar, Budget (per-species pricing, CSV export), Consortium planning across strata and succession phases, saved views and stories.
- **Files**: `.canopi` Designs (WGS84 positions), continuous save, GeoJSON import/export and a planting-plan PDF with field sheets.
- **Field-notebook look**: parchment, ink and ochre; light and dark themes.

## Tech stack

Rust (Tauri v2, rusqlite) · Preact, @preact/signals, TypeScript, Vite · MapLibre GL JS with a PixiJS custom layer · i18next · CSS Modules with design tokens.

## Install

Download Canopi from the [latest release](https://github.com/opencanopi/canopi/releases/latest): `canopi-linux-x64.deb` or `canopi-linux-x64.AppImage`; `canopi-macos-arm64.dmg` (Apple silicon) or `canopi-macos-x64.dmg` (Intel), for macOS 12 or later; `canopi-windows-x64.exe` or `canopi-windows-x64.msi`. `RELEASE-SHA256SUMS.txt` lists their checksums. The [Web Edition](https://web.projectcanopi.com) runs in the browser with nothing to install.

The installers are not signed yet, so the first open takes one more step. macOS: open Canopi once, then go to **System Settings › Privacy & Security** and click **Open Anyway** (since macOS 15, right-click › Open no longer does this). If macOS says the app is damaged, run `xattr -dr com.apple.quarantine /Applications/Canopi.app` in Terminal. Windows: when SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.

## Building from source

Install Rust through rustup (pinned in [rust-toolchain.toml](rust-toolchain.toml)), Node.js 24.13+ and Python 3.

```bash
# Linux system dependencies
sudo apt-get install pkg-config libcairo2-dev libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev patchelf

npm ci --prefix desktop/web
cargo install tauri-cli --version '^2' --locked
python3 scripts/prepare-db.py   # plant DB from the pinned canopi-data export
cargo tauri dev
```

Database preparation needs the exact pinned source export; see the [species catalog guide](docs/guides/species-catalog.md). Web Edition, UI gallery, ports and fixtures are in the [editions guide](docs/guides/editions.md); build, check and release commands are in the [native and release guide](docs/guides/native-and-release.md). The MCP automation bridge is off by default and only compiled in when asked for: `cargo tauri dev -f mcp-bridge` (debug builds only, unauthenticated localhost WebSocket, see the [native and release guide](docs/guides/native-and-release.md#do-not)).

```bash
cd desktop/web && npm run dev:web   # Web Edition, http://localhost:1421/
cd desktop/web && npm run dev:ui    # memory-only UI gallery, http://127.0.0.1:1422/
cd desktop/web && npm run typecheck && npm test
```

## Project structure

```
desktop/src/        Rust backend (IPC, services, DB)
desktop/web/        Preact frontend
common-types/       authored cross-language contracts
bindings-gen/       TypeScript transport codegen
scripts/            DB preparation, docs check, release tooling
docs/               architecture, ADRs, guides, release notes
.interface-design/  design system
```

## Documentation

Start at the [documentation map](docs/README.md). Agents follow [AGENTS.md](AGENTS.md); domain vocabulary is in [CONTEXT.md](CONTEXT.md); the architecture is in [docs/architecture.md](docs/architecture.md).

## License

[AGPL-3.0-or-later](LICENSE) -- Copyright 2026 Canopi contributors
