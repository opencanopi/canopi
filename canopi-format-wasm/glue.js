// The format module as the Web build imports it (Step 2.0.4 R1-1): build-wasm.mjs writes the wasm-bindgen glue and the
// .wasm into dist/ (never committed), and desktop/web/src/platform/design-core.worker.ts, its one importer
// (`wasm-glue-only-in-adapter`), imports both through this file, whose types (glue.d.ts) hold in a checkout that has not
// built the module, so the app type-checks and its import graph resolves without the Rust toolchain. Vite bundles the
// glue into the worker's chunk and emits the .wasm as a hashed asset whose URL `moduleUrl` is.
export { default, probe } from './dist/canopi_format_wasm.js';
export { default as moduleUrl } from './dist/canopi_format_wasm_bg.wasm?url';
