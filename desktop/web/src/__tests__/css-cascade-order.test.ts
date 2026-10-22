import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Rolldown } from 'vite'

/**
 * The cascade 2.0.3 shipped (Vite 6, Rollup): MapLibre's stylesheet, then global.css, then every CSS Module rule, so a
 * module wins each specificity tie with global.css and global.css wins each tie with MapLibre. Rolldown splits the
 * entry's shared dependencies into chunks whose stylesheets Vite links before the entry's; these tests build the real
 * configs and read the emitted page, whatever the chunks are.
 */
describe('initial stylesheet cascade order', () => {
  it.each([
    ['Desktop', 'production', 'index.html'],
    ['Web', 'web', 'web.html'],
  ])('%s build applies MapLibre, then global.css, then every CSS Module rule', async (_name, mode, page) => {
    const { links, css } = await buildInitialStylesheets(mode, page)
    const positions = (needle: string | RegExp) => links.flatMap((href, link) => {
      const source = css.get(href) ?? ''
      const offset = typeof needle === 'string' ? source.indexOf(needle) : source.search(needle)
      return offset < 0 ? [] : [[link, offset] as const]
    })
    const first = (needle: string | RegExp) => {
      const found = positions(needle)
      expect(found.length, `${String(needle)} in an initial stylesheet of ${links.join(', ')}`).toBeGreaterThan(0)
      return found[0]!
    }
    const before = (a: readonly [number, number], b: readonly [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])

    const mapLibre = first('.maplibregl-map')
    // global.css from its first token to its last rule, with the two rules whose ties flipped under Rolldown.
    const globalAnchors = ['--z-canvas-tool-card:', '[role=menuitemradio]:focus-visible', '[inert] *', '[data-design-chrome] *']
      .map((anchor) => first(anchor))
    // A CSS Module class: `_<local>_<hash>_<line>`.
    const firstModuleRule = first(/\._[A-Za-z][\w-]*_[a-z0-9]{5}_\d+/)

    for (const anchor of globalAnchors) {
      expect(before(mapLibre, anchor), `MapLibre before global.css in ${links.join(', ')}`).toBe(true)
      expect(before(anchor, firstModuleRule), `global.css before every module rule in ${links.join(', ')}`).toBe(true)
    }
    expect(new Set(globalAnchors.map(([link]) => link)).size, 'global.css lies in one stylesheet').toBe(1)
  }, 180_000)
})

/** Builds a page in memory with the real vite.config.ts; its initial stylesheet links in order, and each one's CSS. */
async function buildInitialStylesheets(mode: string, page: string): Promise<{ links: string[]; css: Map<string, string> }> {
  const { build } = await import('vite')
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const nodeEnv = process.env.NODE_ENV
  const catalogInput = process.env.CANOPI_WEB_CATALOG_INPUT
  process.env.NODE_ENV = 'production'
  process.env.CANOPI_WEB_CATALOG_INPUT = join(tmpdir(), 'canopi-no-catalog-input')
  try {
    const result = await build({ root, configFile: join(root, 'vite.config.ts'), mode, logLevel: 'silent', build: { write: false } })
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
    const files = outputs.flatMap((output) => output.output)
    const html = files.find((file) => file.fileName === page)
    if (!html || html.type !== 'asset') throw new Error(`The ${mode} build emitted no ${page}`)
    const links = [...String(html.source).matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => match[1]!)
    const css = new Map<string, string>()
    for (const href of links) {
      const file = files.find((candidate) => href.endsWith(`/${candidate.fileName}`))
      if (!file || file.type !== 'asset') throw new Error(`${href} is not an emitted stylesheet`)
      css.set(href, String(file.source))
    }
    return { links, css }
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
    if (catalogInput === undefined) delete process.env.CANOPI_WEB_CATALOG_INPUT
    else process.env.CANOPI_WEB_CATALOG_INPUT = catalogInput
  }
}
