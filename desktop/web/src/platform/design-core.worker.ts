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
 * type-checks and its import graph resolves. The module loads on the first call: the `.wasm` is compiled from its
 * response as it streams when the server labels it `application/wasm`, and from the whole body otherwise or when the
 * engine refuses the label (a host that serves it as octet-stream, or with a parameter, still works); a failed load
 * answers `unavailable` and the next call loads again.
 *
 * Its one call in the reader release is `read` (2.1-M477): a `.canopi` text of version 10 or later read for the
 * read-only view, answered with the module's JSON and the path the module was compiled by. A call that throws inside
 * the module answers `trapped`: a trapped instance stays dead, so the design-core adapter (platform/design-core.ts),
 * which starts this worker on the first newer file and is its one caller, terminates it and starts another.
 */
import initFormatCore, { moduleUrl as formatModuleUrl, read_newer_design } from '../../../../canopi-format-wasm/glue.js'

/** How the module was compiled: from the streamed response, or from its whole body when not labelled wasm. */
type CompilePath = 'streaming' | 'arrayBuffer'

/** A call into the module. */
interface FormatCoreRequest {
  readonly id: number
  readonly call: 'read'
  readonly text: string
}

/**
 * The answer to one call: the module's JSON string, or why it gave none: the module could not load (`unavailable`, the
 * engine's words in `detail`) or the call trapped (`trapped`; no panic hook runs in the reader release, so `detail` is
 * `trapped`, ADR 0025).
 */
type FormatCoreReply =
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
 * The module compiled from `url`'s response: streamed when it is labelled `application/wasm`, else from its body. An
 * engine whose compileStreaming refuses the header with a TypeError (Chromium refuses `application/wasm;
 * charset=binary`, a parameter the essence check lets through) gets the body of a clone taken before streaming; a
 * CompileError, the module itself refused, is never retried.
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

async function answer(request: FormatCoreRequest): Promise<FormatCoreReply> {
  let compiledBy: CompilePath
  try {
    compiledBy = await core()
  } catch (error) {
    // The engine's own words (a CompileError names the feature it refused); no Design content reaches a load.
    return { id: request.id, ok: false, error: 'unavailable', detail: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown' }
  }
  try {
    return { id: request.id, ok: true, value: read_newer_design(request.text), compiledBy }
  } catch {
    // A trap (a Rust panic, an out-of-memory abort) leaves the instance dead; the adapter replaces this worker.
    return { id: request.id, ok: false, error: 'trapped', detail: 'trapped' }
  }
}

scope.onmessage = (event) => {
  void answer(event.data).then((reply) => scope.postMessage(reply))
}
