# Components

What Canopi is made of at C4 levels 1 to 3, and which way each part may depend. The rules are in ADRs 0005, 0022, 0023, 0024, 0029 and 0030; the ADR wins on conflict.

## Level 1: system context

### System context

Model: target
Source: ADR 0005, ADR 0029, ADR 0030, 2.1-M8, 2.1-M91

```mermaid
flowchart LR
  classDef target stroke-dasharray: 4 3
  user(("Designer"))
  desk["Canopi Desktop: canopi-desktop and its webview"]
  web["Canopi Web: the static app in a browser tab"]
  ofm["OpenFreeMap basemap tiles"]
  goog["Google Map Tiles, key held by settings"]
  nom["Nominatim geocoder"]
  commons["Wikimedia Commons plant photos"]
  pages["Cloudflare Pages: app files and catalog Parquet"]
  r2["R2 bucket: DuckDB binaries (2.1)"]:::target
  chan["Update channel files, stable and beta (2.1)"]:::target
  gh["GitHub releases: installers and checksums"]
  side["GeoLibre CLI sidecar, a Desktop oracle after N0"]
  fs["OS file system: Design files, exports, reports"]
  user --> desk
  user --> web
  desk --> ofm
  desk --> goog
  desk --> nom
  desk --> commons
  web --> ofm
  web --> goog
  web --> nom
  web --> commons
  web -->|"app, catalog ranges"| pages
  web -->|"wasm, CORS"| r2
  desk -->|"signed updates"| chan
  user -->|"downloads"| gh
  desk -->|"process"| side
  desk -->|"file grants"| fs
  web -->|"file input, download"| fs
```

- No backend (2.1-Q71): every external system is a static host or a public service, and a problem report is a zip the user saves and sends; nothing leaves without a user action (2.1-Q74).
- The Google key and the location reading never reach a Design, export, report or log (`map-error-redaction.test.ts`, `problem-report-diagnostics.test.ts`, `my-location-trust.test.ts`).
- Both editions reach the same services; any difference is a row of the edition-capabilities table (ADR 0030, `edition-root-parity`, Phase 2a).

## Level 2: containers

### Desktop containers

Model: target
Source: ADR 0022, ADR 0023, ADR 0029 Release safety

```mermaid
flowchart TB
  classDef target stroke-dasharray: 4 3
  subgraph shell["Tauri shell process, owner host"]
    host["canopi-desktop: commands, host, composition"]
    svc["service crates (2.1): library, catalog, store, support, format"]:::target
    upd["Updater in the Rust host (2.1)"]:::target
  end
  subgraph webview["Webview, owner edition root"]
    root["editions/desktop/ (2.1)"]:::target
    app["Shared app, desktop/web/src/"]
    rw["maplibre/raster-display/worker.ts"]
    pw["app/canvas-pdf/worker.ts"]
    fw["Format worker: platform/design-core.worker.ts (2.1)"]:::target
  end
  userdb[("User DB: settings, favourites, stamps, Notebook, Recent Designs")]
  plantdb[("canopi-core.db plant catalog, read only")]
  files[("Drafts folder and Design files")]
  lib[("Data library folder and catalogue")]
  cache[("Image cache and display COGs")]
  side["GeoLibre CLI sidecar process"]
  root --> app
  app -->|"ipc/ invoke"| host
  app --> rw
  app --> pw
  app --> fw
  rw -->|"asset protocol"| cache
  host --> svc
  svc --> userdb
  svc --> plantdb
  svc --> files
  svc --> lib
  svc --> cache
  svc --> side
```

- `canopi-desktop` is the only crate with Tauri, and `ipc/` the only frontend caller of `invoke` (cargo-deny, dependency-cruiser `tauri-only-in-native-host` and `ipc-only-in-desktop-adapters`, ast-grep `invoke-only-in-ipc`).
- Every published file goes through `publish_durably` in `canopi-support` (2.1), behind the `DurableFs` fault seam (ADR 0023).
- The updater runs in the host; the webview holds no `updater:*` permission (2.1-M54).

### Web containers

Model: target
Source: ADR 0022 Canopi Rust on Web, ADR 0029 Static Web serving, contracts §11

```mermaid
flowchart TB
  classDef target stroke-dasharray: 4 3
  subgraph page["Page, owner edition root"]
    root["editions/web/ (2.1)"]:::target
    app["Shared app, desktop/web/src/"]
    st["platform/page-rules.ts (2.1): page-rules wasm in the page"]:::target
  end
  fw["Format worker: platform/design-core.worker.ts (2.1)"]:::target
  lw["Library worker: catalogue in SQLite on OPFS, engine child, Web Lock (2.1)"]:::target
  dw["DuckDB worker over the catalog Parquet, species reader (E1 outcome A: one reader, both editions)"]
  rw["maplibre/raster-display/worker.ts"]
  pw["app/canvas-pdf/worker.ts"]
  sw["Service worker sw.js (2.1)"]:::target
  ls[("localStorage: settings, species lists; stamps and Notebook (2.1)")]
  idb[("IndexedDB: Drafts, stamps and Notebook (2.1)")]:::target
  opfs[("Private file storage: Site data files and library catalogue (2.1)")]:::target
  caches[("Cache API: app shell, DuckDB, catalog blocks (2.1)")]:::target
  host["Pages and R2"]
  root --> app
  app --> st
  app --> fw
  app --> lw
  app --> dw
  app --> rw
  app --> pw
  app --> ls
  app --> idb
  lw --> opfs
  dw -->|"Range requests"| sw
  sw --> caches
  sw --> host
```

- Decoders of untrusted input (`canopi-format-wasm` (2.1), the library readers) run in workers; only the page rules run in the page (2.1-M48).
- One wasm adapter per `-wasm` crate, the only importer of its glue (`wasm-glue-only-in-adapter`, created with each crate). No cross-origin isolation, so wasm is single-threaded.
- DuckDB runs from a same-origin worker URL so its requests pass the service worker (2.1-M45); at HEAD its bundles still come from jsDelivr, deleted by W1.

## Level 3: components

### Frontend layers

Model: target
Source: ADR 0022 Layers, 2.1-Q1, 2.1-M20

```mermaid
flowchart TB
  classDef target stroke-dasharray: 4 3
  subgraph L5["L5 edition roots"]
    ed["editions/desktop/ (2.1)"]:::target
    ew["editions/web/ (2.1)"]:::target
    eg["editions/gallery/ (2.1)"]:::target
  end
  subgraph L4["L4 surfaces, an error boundary each"]
    comp["components/"]
    shellc["components/shell/ (2.1)"]:::target
  end
  subgraph L3["L3 features, acyclic, panels never import each other"]
    feat["other app/ features"]
    dedit["app/design-edit/ Document writers"]
    dlib["app/data-library/ (2.1)"]:::target
    sc["app/shell-commands/"]
  end
  subgraph L2["L2 runtimes, ranked"]
    set["1 app/settings/, owner settings"]
    cmd["2 app/command-table/ (2.1)"]:::target
    can["3 canvas/, owner Scene"]
    doc["4 app/design-edit/document/ (2.1), owner Document"]:::target
    core["5 app/document-session/core/ (2.1), owner Session core"]:::target
  end
  subgraph L1["L1 adapters, ranked"]
    fail["1 failures/ (2.1)"]:::target
    ipc["2 ipc/, owner native host commands"]
    ml["3 maplibre/, owner MapLibre (L7)"]
    plat["3 platform/"]
  end
  subgraph L0["L0 pure, only the signals package"]
    gen["generated/"]
    types["types/"]
    i18n["i18n/, owner active locale"]
    utils["utils/"]
    sty["styles/ and assets/"]
    geo["geo/ (2.1)"]:::target
    plan["planning/ (2.1)"]:::target
  end
  L5 --> L4
  L4 --> L3
  L3 --> L2
  L2 --> L1
  L1 --> L0
  core --> doc
  doc --> can
  can --> cmd
  cmd --> set
  ml --> ipc
  plat --> ipc
  ipc --> fail
```

- A layer imports only layers below; inside L1 and L2 a directory imports only lower ranks, and equal ranks import none of each other. One owner: `policy/layers.json`, which generates the dependency-cruiser `layer-order` and `edition-roots` rules.
- `maplibre/` imports nothing from `canvas/`; it hosts a scene through `maplibre/scene-host-layer.ts` (2.1). `app/command-table/` (2.1) imports no feature.
- Every top-level path has one layer or a named destination in `policy/layers.json`; `target/` is L3: it imports `canvas/` (L2), and its importers in `canvas/` and `maplibre/` are `layer-order` entries (finding COMP-F01, 2.1-M244).

### Edition selection at HEAD

Model: current
Source: ADR 0022 Context; replaced by the edition roots in Phase 2a

```mermaid
flowchart LR
  vite["desktop/web/vite.config.ts: five aliases"]
  md["main.tsx"]
  mw["main.web.tsx"]
  pd["platform/desktop.ts"]
  pb["platform/browser.ts"]
  wa["web/WebApp.tsx"]
  ds["app/document-session/state-machine.ts"]
  bs["web/browser-design-session.ts"]
  kd["commands/registry.ts: Desktop key router"]
  kw["web/browser-shell-commands.ts: Web key router"]
  al["Four feature aliases: species catalog, PDF, budget CSV, geocoding"]
  lp["components/panels/LayersPanel.tsx: edition prop"]
  wl["web/WebLayersPanel.tsx: edition prop"]
  vite --> pd
  vite --> pb
  vite --> al
  md --> pd
  mw --> pb
  mw --> wa
  mw --> kw
  pd --> ds
  pd --> kd
  pb --> bs
  wa --> bs
  wa --> wl
```

- Three edition mechanisms (aliases, `web/` composition, edition props), two Session controllers and two command catalogs; Phase 2a deletes them, and this diagram goes in that change.

### Rust crates at HEAD

Model: current
Graph: cargo

```mermaid
flowchart LR
  canopi_desktop["canopi-desktop: shell, commands, services, stores, catalog, LiDAR"]
  common_types["common-types: contract shapes"]
  bindings_gen["bindings-gen: TS emitter"]
  canopi_desktop --> common_types
  bindings_gen --> common_types
```

- One crate holds the shell and every service; the split below replaces it from Phase 1a to Phase 3 N2.

### Rust crates

Model: target
Source: ADR 0023, 2.1-Q9, 2.1-Q34, 2.1-Q122, 2.1-M4

```mermaid
flowchart BT
  classDef target stroke-dasharray: 4 3
  types["canopi-types (2.1): shapes, DESIGN_FILE_FIELDS, failure, settings and quantity tables"]:::target
  fmt["canopi-format (2.1): stored user work"]:::target
  st["canopi-search-text (2.1): search normalisation"]:::target
  sup["canopi-support (2.1): executor, durable files, http, process"]:::target
  veg["canopi-vegetation (2.1): crown algorithms, roadmap"]:::target
  lib["canopi-library (2.1): Data library, owner library repository"]:::target
  cat["canopi-catalog (2.1): plant DB and search (E1 outcome B)"]:::target
  store["canopi-store (2.1): user DB, Drafts, Design files"]:::target
  desk["canopi-desktop: shell, commands table, host, composition"]
  bg["bindings-gen: TS from the shared shapes"]
  fw["canopi-format-wasm (2.1)"]:::target
  sw["canopi-page-rules-wasm (2.1)"]:::target
  rd["canopi-redact (2.1): Redactor, RedactedText"]:::target
  lw["canopi-library-wasm (2.1): catalogue feature, no native"]:::target
  fmt --> types
  st --> types
  sup --> types
  lib --> sup
  lib --> veg
  cat --> sup
  cat --> st
  store --> sup
  store --> fmt
  desk --> lib
  desk --> cat
  desk --> store
  desk --> fmt
  bg --> types
  fw --> fmt
  sw --> st
  lw --> lib
  sup --> rd
  fw --> rd
  sw --> rd
  lw --> rd
```

- No edge between `canopi-catalog` (2.1) and `canopi-store` (2.1); only `canopi-desktop` depends on both and composes favourites with the catalog.
- Tauri only in `canopi-desktop`; tauri, tokio and sqlite never under `canopi-format` (2.1); wasm-bindgen only in the `-wasm` crates (cargo-deny, Phase 0). Rust SCC count 0 (`rust-scc` ratchet).
- Inside `canopi-library` (2.1): leaves < engines < repository < extensions < jobs < facade, and no extension imports another (`module_layering.rs`, narrowed by N1).

### Ports and edition roots

Model: target
Source: ADR 0022 Ports, ADR 0024, ADR 0030, contracts §4, §13, §16

```mermaid
flowchart LR
  classDef target stroke-dasharray: 4 3
  ed["editions/desktop/ (2.1)"]:::target
  ew["editions/web/ (2.1)"]:::target
  da["Desktop adapters in platform/ over ipc/ (2.1)"]:::target
  wa["Browser adapters in platform/: storage and workers (2.1)"]:::target
  gal["editions/gallery (2.1): browser adapters over memory, fakes, transcript library"]:::target
  cap["generated/edition-capabilities.ts from canopi-types/edition-capabilities.json (2.1)"]:::target
  ep["platform/edition-ports.ts (2.1): EditionPorts, installed once"]:::target
  host["canvas-host.ts (2.1): one mountCanvasHost"]:::target
  core["app/document-session/core/ (2.1), owner Session core"]:::target
  feat["L3 features and L4 surfaces"]
  ed --> da
  ew --> wa
  ed -->|build, install| ep
  ew -->|build, install| ep
  gal -->|build, install| ep
  ed --> host
  ew --> host
  gal --> host
  cap --> ep
  ep --> core
  ep --> feat
```

| Port | Declared in | Desktop adapter | Web adapter | Protects |
|---|---|---|---|---|
| DesignHomeStore | `platform/design-home.ts` (2.1) | native files, file grants | IndexedDB Draft store, file input, download | L10, L17, L21 |
| DesignCore | `platform/design-core.ts` (2.1) | format worker, bytes through `ipc/bytes.ts` (2.1) | format worker over `canopi-format-wasm` (2.1) | L5 |
| FileDelivery | `platform/file-delivery.ts` (2.1) | dialog and native write | download | L12 |
| File access | `platform/file-access.ts` (2.1) | host dialogs with `pickOpen`, `pickHomeTarget`, `convertFileSrc` | file input | L9 |
| App lifecycle | not named | close and exit requests, update install | visibility, page hide and show, version change | ADR 0024 |
| Settings store | `platform/settings.ts` (2.1) | user DB settings row | localStorage record | L16 |
| Data library | `platform/library.ts` (2.1) | library commands (N3) | library worker over SQLite on OPFS (N5) | L21 |
| Species reader | not named | native catalog commands | DuckDB reader | L20, while two remain (2.1-E1) |
| Saved stamps, Design Notebook | not named | user DB | browser record | L21 |
| Scene host layer | `maplibre/scene-host-layer.ts` (2.1) | the Pixi layer on both | the same | L8; the caller hands the factory |

- Only the roots build and install `EditionPorts` (2.1); feature code reads a capability from its set, never the edition (`edition-ports-installed-only-by-roots`, `no-edition-check`). Fields and their files: contracts §22.
- Every port's contract suite runs against both editions' adapters (ADR 0028, contracts §13).
- One implementation, no port: MapPorts as `Pick<maplibregl.Map>`, the Pixi kit, the geocoder in `app/geocoding/`, Desktop window control and the clipboard adapter; a Session question is core state, never a callback a root binds (2.1-M162).
