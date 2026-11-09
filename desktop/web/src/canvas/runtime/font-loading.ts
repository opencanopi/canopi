// canvas/runtime/font-loading.ts: Owner of the canvas's web-font loads (D11). Invariant: canvas text drawn while its
// web font is still loading keeps the fallback's glyphs and widths, and nothing in Pixi or a 2D context listens for
// fonts; so whatever draws canvas text asks here for its font and text, and redraws when the epoch moves. The epoch
// moves once per load that brought a face that had not loaded; a failed load moves nothing and is never asked
// for again (no retry loop).

type Fonts = Pick<FontFaceSet, 'load' | 'forEach'>

interface FontRequests {
  /** Font and text loads in flight. */
  readonly pending: Set<string>
  /** Loads that settled, loaded or failed: never asked for again. */
  readonly settled: Set<string>
}

/** How many settled requests a face set remembers; past it, a request may be asked for once more. */
const SETTLED_LIMIT = 1024

/** Per font face set, so a page (or a test) that swaps `document.fonts` starts afresh. */
const requestsByFonts = new WeakMap<Fonts, FontRequests>()
const listeners = new Set<() => void>()
let fontEpoch = 0

function requestsOf(fonts: Fonts): FontRequests {
  let requests = requestsByFonts.get(fonts)
  if (!requests) {
    requests = { pending: new Set(), settled: new Set() }
    requestsByFonts.set(fonts, requests)
  }
  return requests
}

/**
 * Asks the browser for `font` (CSS shorthand) and the faces `text` needs, once at a time for each, while any face has
 * not loaded. The request names the text because a font's faces cover character ranges (fonts.css): a Latin label's
 * load brings back only the Latin face. `fonts.check()` cannot tell: WebKit reports a face still loading under
 * font-display: swap as failed, so check() is true, and only `load()` waits for the face to arrive.
 */
function request(font: string, text = ''): void {
  const fonts = globalThis.document?.fonts as Fonts | undefined
  if (!fonts) return
  const requests = requestsOf(fonts)
  const key = `${font}\n${text}`
  if (requests.pending.has(key) || requests.settled.has(key)) return
  const unloaded = new Set<FontFace>()
  fonts.forEach((face) => { if (face.status !== 'loaded') unloaded.add(face) })
  if (unloaded.size === 0) return
  requests.pending.add(key)
  const settle = () => {
    requests.pending.delete(key)
    if (requests.settled.size >= SETTLED_LIMIT) requests.settled.clear()
    requests.settled.add(key)
  }
  const loading = text ? fonts.load(font, text) : fonts.load(font)
  loading.then((faces) => {
    settle()
    if (!faces.some((face) => unloaded.has(face) && face.status === 'loaded')) return
    fontEpoch += 1
    for (const listener of [...listeners]) listener()
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
  epoch: (): number => fontEpoch,
  /** Calls `listener` after each epoch move; returns the unsubscribe, which a disposed drawer calls. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
