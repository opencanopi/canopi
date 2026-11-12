// Planted (wasm-glue-only-in-adapter): an app module imports the format module's wasm-bindgen glue itself, outside the
// format worker.
import initFormatCore, { probe } from '../../../../canopi-format-wasm/glue.js'

export async function plantedProbe(module: WebAssembly.Module, text: string): Promise<string> {
  await initFormatCore({ module_or_path: module })
  return probe(text)
}
