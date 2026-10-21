import { afterEach, expect, it, vi } from 'vitest'
import assets from '../app/canvas-pdf/font-assets.json'
import { pdfFontUrls } from '../app/canvas-pdf/font-urls'
import { loadPdfFonts } from '../app/canvas-pdf/text'
const urls = Object.fromEntries(assets.map((asset) => [asset.file, `https://app.test/assets/${asset.file}`]))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it.each([404, 200])('rejects missing or corrupt packaged font assets (HTTP %s)', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status })))
  await expect(loadPdfFonts(['Apple'], 'en', urls)).rejects.toThrow(status === 404 ? 'font-load' : 'font-integrity')
})
it('rejects a font the build gave no URL, before any request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(loadPdfFonts(['Apple'], 'en', {})).rejects.toThrow('font-load')
  expect(fetch).not.toHaveBeenCalled()
})
it('aborts a stalled font request and releases its timeout', async () => {
  vi.useFakeTimers()
  let requestSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', (_url: URL, options: RequestInit) => new Promise((_resolve, reject) => {
    requestSignal = options.signal ?? undefined
    requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  }))
  const result = loadPdfFonts(['Apple'], 'en', urls).catch((error: Error) => error.name)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await result).toBe('AbortError')
  expect(requestSignal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
// 2.1-M176: the fonts are build assets Vite names by content, never a fixed pdf-fonts/ path. The PDF worker runs
// from a blob: URL, where a relative URL cannot resolve, so the main thread hands it absolute URLs.
it('gives every pinned font an absolute URL from the build, resolved on the main thread', () => {
  const resolved = pdfFontUrls('https://app.test/app/designs/1')
  for (const asset of assets) {
    expect(resolved[asset.file], asset.file).toMatch(/^https:\/\/app\.test\//)
    expect(resolved[asset.file]).not.toContain('pdf-fonts/')
  }
})
