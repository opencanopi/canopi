/**
 * Owner of the format module's fetch (fetch-only-in-owners, ADR 0028; §18 F15). Invariant: the worker fetches only its
 * own `.wasm`, from the page's origin.
 *
 * The format worker (ADR 0025 format worker; contracts §18 F28; Step 2.0.4, 2.1-M476, 2.1-M477): the Web edition's
 * one runner of `canopi-format-wasm`, and the one importer of its wasm-bindgen glue (`wasm-glue-only-in-adapter`).
 * Desktop reads `.canopi` natively and never starts it.
 *
 * The glue and the `.wasm` come from `npm run build:format-wasm` (canopi-format-wasm/build-wasm.mjs, never committed);
 * both are imported through canopi-format-wasm/glue.js, typed there, so a checkout that has not built them still
 * type-checks and its import graph resolves. The module loads on the first call: the `.wasm` is compiled from its response as it streams when the
 * server labels it `application/wasm`, and from the whole body otherwise (a host that serves it as octet-stream still
 * works); a failed load answers `unavailable` and the next call loads again.
 *
 * R1-1 is the skeleton: one `probe` call, answered with the path the module was compiled by. R1-6's design-core adapter
 * starts it lazily and adds the read calls, Retry and the trap respawn.
 */
import initFormatCore, { moduleUrl as formatModuleUrl, probe } from '../../../../canopi-format-wasm/glue.js'

/** How the module was compiled: from the streamed response, or from its whole body when not labelled wasm. */
type CompilePath = 'streaming' | 'arrayBuffer'

/** A call into the module. */
interface FormatCoreRequest {
  readonly id: number
  readonly call: 'probe'
  readonly text: string
}

/** The answer to one call: the module's JSON string, or why the module could not load. */
type FormatCoreReply =
  | { readonly id: number, readonly ok: true, readonly value: string, readonly compiledBy: CompilePath }
  | { readonly id: number, readonly ok: false, readonly error: 'unavailable', readonly detail: string }

/** The dedicated worker scope, typed narrowly so the DOM program stays unchanged. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FormatCoreRequest>) => void) | null
  postMessage(message: FormatCoreReply): void
}

const WASM_CONTENT_TYPE = 'application/wasm'

let loading: Promise<CompilePath> | undefined

/**
 * The module compiled from `url`'s response: streamed when it is labelled exactly `application/wasm`, else from its
 * body. compileStreaming refuses any other header, `application/wasm; charset=binary` included, so a parameter sends
 * the response to the fallback too.
 */
async function compileModule(url: string): Promise<{ module: WebAssembly.Module, compiledBy: CompilePath }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`the format module answered HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')?.trim().toLowerCase()
  if (contentType === WASM_CONTENT_TYPE && typeof WebAssembly.compileStreaming === 'function') {
    return { module: await WebAssembly.compileStreaming(response), compiledBy: 'streaming' }
  }
  return { module: await WebAssembly.compile(await response.arrayBuffer()), compiledBy: 'arrayBuffer' }
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

async function answer(request: FormatCoreRequest): Promise<FormatCoreReply> {
  let compiledBy: CompilePath
  try {
    compiledBy = await core()
  } catch (error) {
    // The engine's own words (a CompileError names the feature it refused); no Design content reaches a load.
    return { id: request.id, ok: false, error: 'unavailable', detail: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown' }
  }
  return { id: request.id, ok: true, value: probe(request.text), compiledBy }
}

scope.onmessage = (event) => {
  void answer(event.data).then((reply) => scope.postMessage(reply))
}
