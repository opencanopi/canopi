import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Plugin, PluginOption, UserConfig } from 'vite'

import viteConfig from '../../vite.config'
import galleryConfig from '../../ui-gallery/vite.config'

// .52.33 TST-01: no npm pre-hook prepares the PDF fonts; the Vite plugin and Vitest's global setup do, from one script.
describe('PDF fonts plugin', () => {
  const FONTS_URL = new URL('../../scripts/prepare-pdf-fonts.mjs', import.meta.url)
  interface Fonts {
    PDF_FONTS_DIR: URL
    preparePdfFonts(options: { root: string; fetch: typeof globalThis.fetch; assets: readonly object[]; log(line: string): void }): Promise<void>
  }
  const bytes = new TextEncoder().encode('font bytes')
  const asset = { id: 'latin', file: 'Font.ttf', url: 'https://fonts.test/Font.ttf', sha256: createHash('sha256').update(bytes).digest('hex') }
  const offline = vi.fn(async () => { throw new TypeError('fetch failed') })
  const prepare = async (root: string, fetch: typeof globalThis.fetch) =>
    ((await import(FONTS_URL.href)) as Fonts).preparePdfFonts({ root, fetch, assets: [asset], log: () => {} })
  const fontDir = () => mkdtempSync(join(tmpdir(), 'canopi-pdf-fonts-'))

  it('passes offline with a verified font present, and fails with none naming npm run prepare:pdf-fonts', async () => {
    const root = fontDir()
    writeFileSync(join(root, asset.file), bytes)
    await expect(prepare(root, offline)).resolves.toBeUndefined()
    rmSync(join(root, asset.file))
    await expect(prepare(root, offline)).rejects.toThrow(/latin.*npm run prepare:pdf-fonts/s)
    rmSync(root, { recursive: true })
  })

  it('fetches a corrupt font again, writing through a per-process temporary name and a rename', async () => {
    const root = fontDir()
    writeFileSync(join(root, asset.file), 'corrupt')
    const fetch = vi.fn(async () => new Response(bytes))
    await Promise.all([prepare(root, fetch), prepare(root, fetch)])
    expect(fetch).toHaveBeenCalledWith(asset.url, expect.anything())
    expect(readFileSync(join(root, asset.file))).toEqual(Buffer.from(bytes))
    expect(readdirSync(root)).toEqual([asset.file])
    rmSync(root, { recursive: true })
  })

  it('keeps each checkout\'s fonts in its own source tree, where font-urls.ts globs them', async () => {
    const fonts = (await import(FONTS_URL.href)) as Fonts
    expect(fileURLToPath(fonts.PDF_FONTS_DIR)).toBe(fileURLToPath(new URL('../app/canvas-pdf/fonts/', import.meta.url)))
  })

  it('prepares the fonts in every Vite config that builds the PDF export and in Vitest\'s global setup, never in an npm hook', async () => {
    for (const config of [await resolveConfig('desktop'), await resolveConfig('web'), galleryConfig]) {
      expect(flattenPlugins(config.plugins ?? []).map((plugin) => plugin.name)).toContain('canopi-pdf-fonts')
    }
    const validation = readFileSync(new URL('../../scripts/pdf-validation/vite.config.mjs', import.meta.url), 'utf8')
    expect(validation).toMatch(/pdfFontsPlugin\(\)/)
    const tests = (await resolveConfig('test')) as UserConfig & { test?: { globalSetup?: string[] } }
    expect(tests.test?.globalSetup).toEqual(['./scripts/prepare-pdf-fonts.mjs'])
    const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    expect(Object.entries(scripts).filter(([name, script]) => name !== 'prepare:pdf-fonts' && script.includes('pdf-fonts'))).toEqual([])
  })
})

async function resolveConfig(mode: string): Promise<UserConfig> {
  if (typeof viteConfig !== 'function') return viteConfig
  return Promise.resolve(viteConfig({ command: 'serve', mode, isSsrBuild: false, isPreview: false }))
}

function flattenPlugins(options: readonly PluginOption[]): Plugin[] {
  return options.flatMap((option): Plugin[] => {
    if (!option) return []
    if (Array.isArray(option)) return flattenPlugins(option)
    return [option as Plugin]
  })
}
