/// <reference types="vite/client" />

interface ImportMetaEnv {
}

/** The Web catalog directory relative to the base, `assets/catalog/<content id>/` (vite.config.ts `define`). */
declare const __CANOPI_WEB_CATALOG_PATH__: string

/** The Cargo workspace version (`Cargo.toml [workspace.package]`, .52.75, vite.config.ts `define`). */
declare const __CANOPI_APP_VERSION__: string
