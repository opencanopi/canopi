import type { PdfFontUrls } from './text'

// The pinned fonts (scripts/prepare-pdf-fonts.mjs, git-ignored) are build assets, so Vite names each by its content
// (2.1-M176): a release never rewrites a font URL an open tab of an older release asks for. Their licences are rows of
// THIRD_PARTY_NOTICES.md; only the font files ship (a checkout's leftover *-LICENSE.txt never does). `no-inline`
// keeps every file a file.
// Stryker disable next-line all: Vite's glob plugin reads these arguments as literals
const built = import.meta.glob<string>('./fonts/*.{ttf,otf}', { query: '?url&no-inline', import: 'default', eager: true })

/** Absolute URL of each prepared font file by its `font-assets.json` name. Called on the main thread: the PDF
 * worker runs from a blob: URL, against which a relative URL cannot resolve. */
export function pdfFontUrls(base: string = document.baseURI): PdfFontUrls {
  return Object.fromEntries(Object.entries(built).map(([path, url]) => [path.slice('./fonts/'.length), new URL(url, base).href]))
}
