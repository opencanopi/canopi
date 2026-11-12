// The format module's glue as the Web build imports it (Step 2.0.4 R1-1): build-wasm.mjs writes the wasm-bindgen glue
// into dist/ (never committed), and desktop/web/src/platform/design-core.worker.ts, its one importer
// (`wasm-glue-only-in-adapter`), imports it through this file, whose types (glue.d.ts) hold in a checkout that has not
// built the module, so the app type-checks without the Rust toolchain. Vite bundles the glue into the worker's chunk.
export { default, probe } from './dist/canopi_format_wasm.js';
