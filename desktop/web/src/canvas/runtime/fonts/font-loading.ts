// canvas/runtime/fonts/font-loading.ts: the one loader of the canvas's web fonts (D11). Invariant: canvas text drawn while its
// web font is still loading keeps the fallback's glyphs and widths, and nothing in Pixi or a 2D context listens for
// fonts; so whatever draws canvas text asks here for its font and text, and redraws when the epoch moves. The epoch
// moves once per load that brought a face that had not loaded; a failed load moves nothing and is never asked
// for again (no retry loop).

type Fonts = Pick<FontFaceSet, 'load' | 'forEach'>

interface FontLoaderState {
  /** Held strongly so WebKit/JSC never collects the document.fonts wrapper out from under active listeners. */
  readonly fonts: Fonts
  /** Font and text loads in flight. */
  readonly pending: Set<string>
  /** Loads that settled, loaded or failed: never asked for again. */
  readonly settled: Set<string>
  epoch: number
  readonly listeners: Set<() => void>
}

/** How many settled requests a face set remembers; past it, a request may be asked for once more. */
const SETTLED_LIMIT = 1024

/** Per Document (never WeakMap-keyed on document.fonts, which WebKit/JSC can collect when unreferenced). */
const stateByDocument = new WeakMap<Document, FontLoaderState>()

function currentDocumentAndFonts(): { readonly doc: Document; readonly fonts: Fonts } | undefined {
  const doc = globalThis.document
  const fonts = doc?.fonts
  return doc && fonts ? { doc, fonts } : undefined
}

function stateOf(doc: Document, fonts: Fonts): FontLoaderState {
  let state = stateByDocument.get(doc)
  if (!state || state.fonts !== fonts) {
    state = { fonts, pending: new Set(), settled: new Set(), epoch: 0, listeners: new Set() }
    stateByDocument.set(doc, state)
  }
  return state
}

/**
 * Asks the browser for `font` (CSS shorthand) and the faces `text` needs, once at a time for each, while any face has
 * not loaded. The request names the text because a font's faces cover character ranges (fonts.css): a Latin label's
 * load brings back only the Latin face. `fonts.check()` cannot tell: WebKit reports a face still loading under
 * font-display: swap as failed, so check() is true, and only `load()` waits for the face to arrive.
 */
function request(font: string, text = ''): void {
  const current = currentDocumentAndFonts()
  if (!current) return
  const { doc, fonts } = current
  const state = stateOf(doc, fonts)
  const key = `${font}\n${text}`
  if (state.pending.has(key) || state.settled.has(key)) return
  const unloaded = new Set<FontFace>()
  fonts.forEach((face) => { if (face.status !== 'loaded') unloaded.add(face) })
  if (unloaded.size === 0) return
  state.pending.add(key)
  const settle = () => {
    state.pending.delete(key)
    if (state.settled.size >= SETTLED_LIMIT) state.settled.clear()
    state.settled.add(key)
  }
  const loading = text ? fonts.load(font, text) : fonts.load(font)
  loading.then((faces) => {
    settle()
    if (!faces.some((face) => unloaded.has(face) && face.status === 'loaded')) return
    state.epoch += 1
    for (const listener of [...state.listeners]) listener()
  }, () => {
    settle()
    // The text keeps the fallback font for good: the browser logs the failed request, and asking again would loop.
  })
}

/** The distinct characters of `texts`, sorted: the text a request names for labels whose faces it needs. */
export function distinctCharacters(texts: Iterable<string>): string {
  const characters = new Set<string>()
  for (const text of texts) for (const character of text) characters.add(character)
  return [...characters].sort().join('')
}

export const canvasFonts = {
  request,
  /** Counts the loads that brought a face; a memo of anything sized by canvas text keeps it in its key. */
  epoch: (): number => {
    const current = currentDocumentAndFonts()
    return current ? stateOf(current.doc, current.fonts).epoch : 0
  },
  /** Calls `listener` after each epoch move; returns the unsubscribe, which a disposed drawer calls. */
  subscribe(listener: () => void): () => void {
    const current = currentDocumentAndFonts()
    if (!current) return () => {}
    const { listeners } = stateOf(current.doc, current.fonts)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
