// The types of glue.js: the parts of the generated wasm-bindgen glue (`--target web`, dist/canopi_format_wasm.js) the
// format worker calls, and the built .wasm's URL. They follow canopi-format-wasm/src/lib.rs's exports; e2e/canvas/format-core-probe.spec.ts calls
// each through the built module, so a drifted line fails there.

/** Instantiates the module from a compiled `WebAssembly.Module` (the worker compiles it, streamed or from its body). */
export default function init(input: { module_or_path: WebAssembly.Module }): Promise<unknown>;

/** The built `.wasm`'s URL (a Vite `?url` asset), which the worker fetches and compiles. */
export const moduleUrl: string;

/**
 * The read call: a `.canopi` text of version 10 or later read for the read-only view, as JSON:
 * `{"read":{"view":…,"saved_by_version":<n>}}` or `{"refused":{"kind":…,"message":…,"field_path":…}}`.
 */
export function read_newer_design(text: string): string;
