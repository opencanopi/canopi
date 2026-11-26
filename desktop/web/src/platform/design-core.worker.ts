/**
 * Owner of the format module's fetch (fetch-only-in-owners, ADR 0028; §18 F15). Invariant: the worker fetches only its
 * own `.wasm`, from the page's origin.
 *
 * The format worker (ADR 0025 format worker; contracts §10, §18 F28; 2b-5, 2.1-M476, 2.1-M539): the Web edition's
 * one runner of `canopi-format-wasm`, and the one importer of its wasm-bindgen glue (`wasm-glue-only-in-adapter`).
 * Desktop reads `.canopi` natively and never starts it.
 */
import initFormatCore, {
  decode_design,
  decode_stamp_payload,
  draft_summary,
  encode_design,
  encode_stamp_payload,
  format_core_version,
  moduleUrl as formatModuleUrl,
  new_design,
  read_newer_design,
} from '../../../../canopi-format-wasm/glue.js'

/** How the module was compiled: from the streamed response, or from its whole body when not labelled wasm. */
type CompilePath = 'streaming' | 'arrayBuffer'

/** A call into the module. */
export type FormatCoreRequest =
  | { readonly id: number, readonly call: 'version' }
  | { readonly id: number, readonly call: 'read', readonly text: string }
  | { readonly id: number, readonly call: 'decode', readonly text: string }
  | { readonly id: number, readonly call: 'encode', readonly designJson: string }
  | { readonly id: number, readonly call: 'new_design', readonly inputJson: string }
  | { readonly id: number, readonly call: 'draft_summary', readonly text: string, readonly updatedAt: string }
  | { readonly id: number, readonly call: 'decode_stamp', readonly text: string }
  | { readonly id: number, readonly call: 'encode_stamp', readonly payloadJson: string }

/**
 * The answer to one call: the module's JSON string, or why it gave none: the module could not load (`unavailable`, the
 * engine's words in `detail`) or the call trapped (`trapped`, ADR 0025).
 */
export type FormatCoreReply =
  | { readonly id: number, readonly ok: true, readonly value: string, readonly compiledBy: CompilePath }
  | { readonly id: number, readonly ok: false, readonly error: 'unavailable' | 'trapped', readonly detail: string }

/** The dedicated worker scope, typed narrowly so the DOM program stays unchanged. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FormatCoreRequest>) => void) | null
  postMessage(message: FormatCoreReply): void
}

const WASM_CONTENT_TYPE = 'application/wasm'

let loading: Promise<CompilePath> | undefined

/**
 * The module compiled from `url`'s response: streamed when it is labelled `application/wasm`, else from its body.
 */
async function compileModule(url: string): Promise<{ module: WebAssembly.Module, compiledBy: CompilePath }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`the format module answered HTTP ${response.status}`)
  const essence = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  let body: Response = response
  if (essence === WASM_CONTENT_TYPE && typeof WebAssembly.compileStreaming === 'function') {
    body = response.clone()
    try {
      return { module: await WebAssembly.compileStreaming(response), compiledBy: 'streaming' }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
  }
  return { module: await WebAssembly.compile(await body.arrayBuffer()), compiledBy: 'arrayBuffer' }
}

async function loadCore(): Promise<CompilePath> {
  const compiled = await compileModule(formatModuleUrl)
  await initFormatCore({ module_or_path: compiled.module })
  return compiled.compiledBy
}

/** The loaded module's compile path; a failed load is forgotten, so the next call loads again. */
function core(): Promise<CompilePath> {
  loading ??= loadCore().catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

function dispatch(request: FormatCoreRequest): string {
  switch (request.call) {
    case 'version':
      return format_core_version()
    case 'read':
      return read_newer_design(request.text)
    case 'decode':
      return decode_design(request.text)
    case 'encode':
      return encode_design(request.designJson)
    case 'new_design':
      return new_design(request.inputJson)
    case 'draft_summary':
      return draft_summary(request.text, request.updatedAt)
    case 'decode_stamp':
      return decode_stamp_payload(request.text)
    case 'encode_stamp':
      return encode_stamp_payload(request.payloadJson)
  }
}

async function answer(request: FormatCoreRequest): Promise<FormatCoreReply> {
  let compiledBy: CompilePath
  try {
    compiledBy = await core()
  } catch (error) {
    // The engine's own words (a CompileError names the feature it refused); no Design content reaches a load.
    return { id: request.id, ok: false, error: 'unavailable', detail: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown' }
  }
  try {
    return { id: request.id, ok: true, value: dispatch(request), compiledBy }
  } catch {
    // A trap (a Rust panic, an out-of-memory abort) leaves the instance dead; the adapter replaces this worker.
    return { id: request.id, ok: false, error: 'trapped', detail: 'trapped' }
  }
}

scope.onmessage = (event) => {
  void answer(event.data).then((reply) => scope.postMessage(reply))
}
