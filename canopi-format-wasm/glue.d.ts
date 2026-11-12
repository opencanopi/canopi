// The types of glue.js: the parts of the generated wasm-bindgen glue (`--target web`, dist/canopi_format_wasm.js) the
// format worker calls, and the built .wasm's URL. They follow canopi-format-wasm/src/lib.rs's exports; e2e/canvas/format-core-probe.spec.ts calls
// each through the built module, so a drifted line fails there.

/** Instantiates the module from a compiled `WebAssembly.Module` (the worker compiles it, streamed or from its body). */
export default function init(input: { module_or_path: WebAssembly.Module }): Promise<unknown>;

/** The built `.wasm`'s URL (a Vite `?url` asset), which the worker fetches and compiles. */
export const moduleUrl: string;

/** The probe call: `{"current_version":<n>,"redacted":<text redacted>}` as JSON. */
export function probe(text: string): string;
