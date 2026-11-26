declare module '*canopi_format_wasm.js' {
  export function initSync(input: { module: BufferSource | WebAssembly.Module }): unknown
  export function decode_design(text: string): string
  export function encode_design(designJson: string): string
  export function new_design(inputJson: string): string
  export function draft_summary(text: string, updatedAt: string): string
  export function decode_stamp_payload(text: string): string
  export function encode_stamp_payload(payloadJson: string): string
  export function format_core_version(): string
}
