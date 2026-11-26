// The types of glue.js: the parts of the generated wasm-bindgen glue (`--target web`, dist/canopi_format_wasm.js) the
// format worker calls, and the built .wasm's URL. They follow canopi-format-wasm/src/lib.rs's exports; e2e/canvas/format-core-probe.spec.ts calls
// each through the built module, so a drifted line fails there.

/** Instantiates the module from a compiled `WebAssembly.Module` (the worker compiles it, streamed or from its body). */
export default function init(input: { module_or_path: WebAssembly.Module }): Promise<unknown>;

/** The built `.wasm`'s URL (a Vite `?url` asset), which the worker fetches and compiles. */
export const moduleUrl: string;

/** Reports the `canopi-format` crate version (contracts §10). */
export function format_core_version(): string;

/** Decodes a `.canopi` Design (v9 or v10) through Format Core v10: `{"ok": OpenedDesign}` or `{"err": FormatRefusal}`. */
export function decode_design(text: string): string;

/** Validates and canonically encodes a v10 Design: `{"ok": "<canonical-json>"}` or `{"err": FormatRefusal}`. */
export function encode_design(design_json: string): string;

/** Constructs a canonical v10 Design from a JSON-encoded `NewDesignInput`. */
export function new_design(input_json: string): string;

/** Derives a Draft summary from raw `.canopi` text and its stored `updated_at` timestamp. */
export function draft_summary(text: string, updated_at: string): string;

/** Decodes and migrates (v2 → v3) a saved-stamp payload: `{"ok": SavedObjectStampPayload}` or `{"err": StampPayloadRefusal}`. */
export function decode_stamp_payload(text: string): string;

/** Validates and canonically encodes a v3 saved-stamp payload: `{"ok": "<canonical-json>"}` or `{"err": StampPayloadRefusal}`. */
export function encode_stamp_payload(payload_json: string): string;
