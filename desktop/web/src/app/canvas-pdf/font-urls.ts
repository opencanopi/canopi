import type { PdfFontUrls } from './text'

// The pinned fonts (`npm run prepare:pdf-fonts`, git-ignored) are build assets, so Vite names each by its content
// (2.1-M176): a release never rewrites a font URL an open tab of an older release asks for. Their licences ship
// beside them. `no-inline` keeps every file a file.
const built = import.meta.glob<string>('./fonts/*', { query: '?url&no-inline', import: 'default', eager: true })

/** Absolute URL of each prepared font file by its `font-assets.json` name. Called on the main thread: the PDF
 * worker runs from a blob: URL, against which a relative URL cannot resolve. */
export function pdfFontUrls(base: string = document.baseURI): PdfFontUrls {
  return Object.fromEntries(Object.entries(built).map(([path, url]) => [path.slice('./fonts/'.length), new URL(url, base).href]))
}
