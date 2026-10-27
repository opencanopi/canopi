import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigEnv, Plugin, PluginOption, UserConfig } from 'vite'

import viteConfig from '../../vite.config'
import galleryConfig from '../../ui-gallery/vite.config'
import { parseCssDeclarations } from './support/architecture/css-facts'
import { admitWebCatalogManifest } from '../generated/web-catalog-artifact.mjs'
import { validWebCatalogManifest } from './fixtures/web-catalog-manifest'

const SCANNER_URL = new URL('../../scripts/check-web-build-boundaries.mjs', import.meta.url)
const IDENTIFIER_SCANNER_URL = new URL('../../scripts/check-build-identifiers.mjs', import.meta.url)

interface IdentifierScanner {
  scanBuildIdentifiers(distRoot: string): string[]
  scriptViolations(name: string, source: string): string[]
}

describe('Web Edition build configuration', () => {
  it('selects shared browser and desktop adapters at build time', async () => {
    const web = await resolveConfig('web')
    const desktop = await resolveConfig('desktop')

    expect(aliasPath(web, '#platform')).toMatch(/\/src\/platform\/browser\.ts$/)
    expect(aliasPath(web, '#budget-export-platform')).toMatch(/\/src\/app\/budget\/platform\.browser\.ts$/)
    expect(aliasPath(desktop, '#platform')).toMatch(/\/src\/platform\/desktop\.ts$/)
    expect(aliasPath(desktop, '#budget-export-platform')).toMatch(/\/src\/app\/budget\/platform\.desktop\.ts$/)
    expect(aliasPath(web, '#species-catalog-live')).toMatch(/\/live\.browser\.ts$/)
    expect(aliasPath(desktop, '#species-catalog-live')).toMatch(/\/live\.desktop\.ts$/)
    for (const config of [web, desktop]) {
      for (const alias of [
        '#platform',
        '#budget-export-platform',
        '#species-catalog-live',
      ]) {
        expect(existsSync(aliasPath(config, alias)), `${alias} resolves to an existing source`).toBe(true)
      }
    }
  })

  it('builds the browser entry into its isolated artifact at the root base, whatever the environment says (2.1-Q85)', async () => {
    process.env.CANOPI_WEB_BASE_PATH = '/app/'
    const web = await resolveConfig('web').finally(() => { delete process.env.CANOPI_WEB_BASE_PATH })
    const desktop = await resolveConfig('desktop')
    const webHtml = readFileSync(new URL('../../web.html', import.meta.url), 'utf8')

    expect(web.base).toBe('/')
    expect(web.build?.outDir).toBe('dist-web')
    expect(web.build?.rolldownOptions?.input).toBe('web.html')
    expect(web.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'canopi-web-edition-dev-entry' }),
    ]))
    expect(desktop.build?.outDir).toBe('dist')
    expect(desktop.build?.rolldownOptions?.input).toBe('index.html')
    expect(webHtml).toContain('/src/main.web.tsx')
  })

  it('serves no public/ directory, so leftovers of the old catalog and font paths never reach a build (2.1-M176)', async () => {
    expect((await resolveConfig('web')).publicDir).toBe(false)
    expect((await resolveConfig('desktop')).publicDir).toBe(false)
    const ignore = readFileSync(new URL('../../../../.gitignore', import.meta.url), 'utf8').split('\n')
    expect(ignore).toContain('desktop/web/public/')
  })

  it('names every Web chunk, worker and asset <name>-<16-character hash>.<ext>, the shape web_release.py admits (2.1-M176)', async () => {
    const web = await resolveConfig('web')
    const outputs = [web.build?.rolldownOptions?.output, web.worker?.rolldownOptions?.output]
    for (const output of outputs) {
      expect(output).toMatchObject({
        entryFileNames: 'assets/[name]-[hash:16].js',
        chunkFileNames: 'assets/[name]-[hash:16].js',
        assetFileNames: 'assets/[name]-[hash:16][extname]',
      })
    }
  })

  it('configures Rolldown and Oxc under their Vite 8 names, never the deprecated rollupOptions or esbuildOptions', async () => {
    const configs = {
      web: await resolveConfig('web'),
      desktop: await resolveConfig('desktop'),
      gallery: await resolveGalleryConfig(),
    }
    for (const [name, config] of Object.entries(configs)) {
      expect(deprecatedOptionPaths(config), name).toEqual([])
      // The dependency optimizer keeps the build's target: the TIFF codecs use top-level await.
      expect(config.optimizeDeps?.rolldownOptions?.transform?.target, name).toBe('es2022')
    }
  })

  it('keeps the four named vendor chunks holding the packages they held on Rollup (Desktop build)', async () => {
    // Measured from the Vite 6 (Rollup) Desktop build: the packages with rendered code in each named chunk, dependencies
    // the group pulled in included. Chunk count and bytes are not asserted (DR5).
    expect(await namedVendorChunkPackages()).toEqual({
      'i18n': ['i18next'],
      'maplibre-gl': ['maplibre-gl'],
      'raster-display': [
        '@chunkd/middleware', '@chunkd/source', '@chunkd/source-http', '@chunkd/source-memory', '@cogeotiff/core',
        '@deck.gl/core', '@deck.gl/geo-layers', '@deck.gl/layers', '@deck.gl/mapbox', '@deck.gl/mesh-layers',
        '@developmentseed/affine', '@developmentseed/geotiff', '@developmentseed/lzw-tiff-decoder',
        '@loaders.gl/core', '@loaders.gl/images', '@loaders.gl/loader-utils', '@loaders.gl/schema', '@loaders.gl/worker-utils',
        '@luma.gl/core', '@luma.gl/engine', '@luma.gl/gpgpu', '@luma.gl/shadertools', '@luma.gl/webgl', '@mapbox/tiny-sdf',
        '@math.gl/core', '@math.gl/culling', '@math.gl/polygon', '@math.gl/types', '@math.gl/web-mercator',
        '@probe.gl/env', '@probe.gl/log', '@probe.gl/stats', 'earcut', 'fzstd', 'lerc', 'maplibre-gl-raster', 'mjolnir.js',
      ],
      'tauri': ['@tauri-apps/api', '@tauri-apps/plugin-dialog'],
    })
  }, 120_000)

  it('emits every Desktop script, workers included, ASCII-only with its non-ASCII keys quoted, as WebKitGTK parses (canopi-f47t.52.228.18)', async () => {
    // geotiff-geokeys-to-proj4 2026.8 had keys such as "\u088f"; Oxc's minifier wrote them bare, and WebKitGTK's
    // older identifier tables rejected the raster display worker whole, so an imported GeoTIFF never drew. 2026.10
    // packs that table into a string, so the real build holds no such key; the next test plants one.
    const { scriptViolations } = await import(IDENTIFIER_SCANNER_URL.href) as IdentifierScanner
    const { scripts } = await desktopBuild()
    expect(scripts.flatMap(({ fileName, code }) => scriptViolations(fileName, code))).toEqual([])
  }, 120_000)

  it('quotes the non-ASCII property names the minifier unquotes, in the app and in its workers (canopi-f47t.52.228.18)', async () => {
    const desktop = await resolveConfig('desktop')
    const { rolldown } = await import('rolldown')
    const { scriptViolations } = await import(IDENTIFIER_SCANNER_URL.href) as IdentifierScanner
    const plugin = findPlugin(desktop, 'canopi-ascii-identifier-keys')
    // Rolldown names a chunk before generateBundle rewrites it: the name carries the rewrite's digest.
    expect(callHook(plugin.augmentChunkHash, {}, {})).toMatch(/^[0-9a-f]{16}$/)
    const workerPlugins = await desktop.worker?.plugins?.()
    expect(flattenPlugins(workerPlugins ?? []).map((candidate) => candidate.name)).toContain('canopi-ascii-identifier-keys')
    for (const output of [desktop.build?.rolldownOptions?.output, desktop.worker?.rolldownOptions?.output]) {
      expect(output).toMatchObject({ charset: 'ascii' })
    }

    const source = [
      'export const table = { "\u088f": 1, "\u00e9": 2, plain: 3 }',
      'export const read = (x) => [x["\u088f"], x?.["\u00e9"], x.plain]',
      'export class Keys { "\u088f"() { return 4 } static "\u00e9" = 5 }',
      'export const { "\u088f": picked } = table',
    ].join('\n')
    const bundle = await rolldown({
      input: 'fixture',
      plugins: [
        { name: 'fixture', resolveId: (id) => (id === 'fixture' ? id : null), load: (id) => (id === 'fixture' ? source : null) },
        plugin as never,
      ],
    })
    const { output } = await bundle.generate({ format: 'es', minify: true, charset: 'ascii' })
    const code = output[0].code
    expect(scriptViolations('fixture.js', code)).toEqual([])
    expect(code).toContain('"\\u088F":')
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as {
      table: Record<string, number>; read(x: unknown): unknown[]; Keys: new () => Record<string, () => number>; picked: number
    }
    expect(module.table).toEqual({ '\u088f': 1, '\u00e9': 2, plain: 3 })
    expect(module.read(module.table)).toEqual([1, 2, 3])
    expect(new module.Keys()['\u088f']!()).toBe(4)
    expect((module.Keys as unknown as Record<string, number>)['\u00e9']).toBe(5)
    expect(module.picked).toBe(1)
  })

  it('names every non-ASCII character and identifier, raw or escaped, in a built script (canopi-f47t.52.228.18)', async () => {
    const { scanBuildIdentifiers } = await import(IDENTIFIER_SCANNER_URL.href) as IdentifierScanner
    const dist = mkdtempSync(join(tmpdir(), 'canopi-build-identifiers-'))
    try {
      mkdirSync(join(dist, 'assets'), { recursive: true })
      writeFileSync(join(dist, 'assets', 'quoted.js'), 'export const t={"\\u088F":1},u=t["\\u088F"];\n')
      writeFileSync(join(dist, 'index.html'), '<p>\u00e9</p>\n')
      expect(scanBuildIdentifiers(dist)).toEqual([])

      writeFileSync(join(dist, 'assets', 'escaped.js'), 'export const t={\\u088F:1},u=t.\\u00E9;\n')
      writeFileSync(join(dist, 'assets', 'worker.mjs'), 'self.x={\u088f:1};\n')
      writeFileSync(join(dist, 'assets', 'string.js'), 'export const s="\u00e9";\n')
      writeFileSync(join(dist, 'assets', 'broken.js'), 'export const = \\u;\n')
      expect(scanBuildIdentifiers(dist).sort()).toEqual([
        'assets/broken.js does not parse: Unexpected token',
        'assets/escaped.js has the non-ASCII identifier "\u00e9" (U+00E9)',
        'assets/escaped.js has the non-ASCII identifier "\u088f" (U+088F)',
        'assets/string.js has the non-ASCII character "\u00e9" (U+00E9) at offset 16',
        'assets/worker.mjs has the non-ASCII character "\u088f" (U+088F) at offset 8',
        'assets/worker.mjs has the non-ASCII identifier "\u088f" (U+088F)',
      ])
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })

  it('installs the Web development rewrite and leaves Desktop requests alone', async () => {
    const webMiddleware = installDevEntryMiddleware(await resolveConfig('web'))
    const desktopMiddleware = installDevEntryMiddleware(await resolveConfig('desktop'))
    const request = { url: '/index.html?from=test' }
    const next = vi.fn()

    expect(webMiddleware).toBeTypeOf('function')
    webMiddleware?.(request, {}, next)
    expect(request.url).toBe('/web.html?from=test')
    expect(next).toHaveBeenCalledOnce()
    expect(desktopMiddleware).toBeUndefined()
  })

  it('runs the artifact boundary scanner after every Web build', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }

    expect(packageJson.scripts?.['build:web']).toContain('npm run build:web:bundle')
    expect(packageJson.scripts?.['build:web:bundle']).toContain(
      'vite build --mode web && node scripts/check-web-build-boundaries.mjs',
    )
  })

  it('checks every Desktop and Web build for non-ASCII scripts and identifiers (canopi-f47t.52.228.18)', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }

    expect(packageJson.scripts?.['build']).toContain('npm run build:desktop:bundle')
    expect(packageJson.scripts?.['build:desktop:bundle']).toBe('vite build && node scripts/check-build-identifiers.mjs dist')
    expect(packageJson.scripts?.['build:web:bundle']).toMatch(/&& node scripts\/check-build-identifiers\.mjs dist-web$/)
  })

  it('passes a browser-only build and names every Desktop leak and Desktop-only asset', async () => {
    const { scanWebBuild } = await import(SCANNER_URL.href) as { scanWebBuild(distRoot: string): string[] }
    const dist = mkdtempSync(join(tmpdir(), 'canopi-web-boundaries-'))
    try {
      mkdirSync(join(dist, 'assets'), { recursive: true })
      writeFileSync(join(dist, 'index.html'), '<script type="module" src="/assets/web-1.js"></script>\n')
      writeFileSync(join(dist, 'assets', 'web-1.js'), 'console.log("browser only")\n')
      writeFileSync(join(dist, 'assets', 'shared.css'), '.root{color:red}\n')
      expect(scanWebBuild(dist)).toEqual([])

      // The markers a minified Tauri chunk keeps (globals, plugin command names) and the
      // chunk name vite.config.ts gives @tauri-apps, and a Desktop-only raster decoder. The Pages limits and raw
      // DuckDB wasm are web_release.py package's (test_web_release_package.py).
      writeFileSync(join(dist, 'assets', 'web-1.js'), 'window.__TAURI_INTERNALS__.invoke("plugin:dialog|open")\n')
      writeFileSync(join(dist, 'assets', 'tauri-2f3a.js'), 'export{}\n')
      writeFileSync(join(dist, 'assets', 'cog_tiler_wasm_bg-1.wasm'), '\0asm')
      expect(scanWebBuild(dist).sort()).toEqual([
        'assets/cog_tiler_wasm_bg-1.wasm is a Desktop-only raster decoder',
        'assets/tauri-2f3a.js is the Tauri API chunk; the Web entry graph reached @tauri-apps',
        'assets/web-1.js contains __TAURI_INTERNALS__',
        'assets/web-1.js contains plugin:dialog|',
      ])
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })

  it('keeps the browser shell and optional sidebar inside the workspace', () => {
    const webAppCss = readFileSync(new URL('../web/WebApp.module.css', import.meta.url), 'utf8')
    const workspaceCss = readFileSync(
      new URL('../components/workspace/WorkspaceComposition.module.css', import.meta.url),
      'utf8',
    )
    const shellCss = readFileSync(
      new URL('../web/BrowserAppShell.module.css', import.meta.url),
      'utf8',
    )

    expect(cssValue(webAppCss, '.root', 'height')).toBe('100%')
    expect(cssValue(workspaceCss, '.root', 'display')).toBe('flex')
    expect(cssValue(workspaceCss, '.primary', 'display')).toBe('flex')
    expect(cssValue(workspaceCss, '.sidePanel', 'display')).toBe('flex')
    expect(cssValue(workspaceCss, '.sidePanel', 'flex-direction')).toBe('column')
    expect(cssValue(workspaceCss, '.root', 'position')).toBe('relative')
    const dockCss = readFileSync(new URL('../components/shared/SidePanelDock.module.css', import.meta.url), 'utf8')
    expect(cssValue(dockCss, '.dock', 'position')).toBe('absolute')
    expect(cssValue(dockCss, '.dock', 'width')).toBe('var(--side-panel-width)')
    expect(cssValue(dockCss, '.dock', 'min-width')).toBe('320px')
    expect(cssValue(shellCss, '.shell', 'height')).toBe('100%')
    expect(cssValue(shellCss, '.shell', 'overflow')).toBe('hidden')
    expect(cssValue(shellCss, '.workspace', 'display')).toBe('flex')
  })

  it('places the Web catalog under assets/catalog/<content id>/ and gives the bundle that path (2.1-M176)', async () => {
    const input = mkdtempSync(join(tmpdir(), 'canopi-catalog-input-'))
    const previous = process.env.CANOPI_WEB_CATALOG_INPUT
    try {
      const catalog = admitWebCatalogManifest(validWebCatalogManifest())
      const manifest = `${JSON.stringify(validWebCatalogManifest())}\n`
      writeFileSync(join(input, 'manifest.json'), manifest)
      for (const asset of catalog.files) {
        mkdirSync(join(input, dirname(asset.path)), { recursive: true })
        writeFileSync(join(input, asset.path), 'PAR1 rows PAR1')
      }
      // Leftovers of an earlier generation: never emitted, never served (review S10).
      const listed = catalog.files[0]!.path
      writeFileSync(join(input, dirname(listed), 'species-stale.parquet'), 'PAR1 old PAR1')
      writeFileSync(join(input, 'notes.txt'), 'scratch')
      process.env.CANOPI_WEB_CATALOG_INPUT = input
      const id = createHash('sha256').update(manifest).digest('hex').slice(0, 16)
      const web = await resolveConfig('web')
      expect(web.define?.__CANOPI_WEB_CATALOG_PATH__).toBe(JSON.stringify(`assets/catalog/${id}/`))

      const plugin = findPlugin(web, 'canopi-web-catalog')
      const emitted: { fileName?: string; source?: unknown }[] = []
      callHook(plugin.configResolved, {}, { command: 'build', base: '/' })
      callHook(plugin.buildStart, { emitFile: (file: { fileName?: string; source?: unknown }) => emitted.push(file) }, {})
      expect(emitted.map((file) => file.fileName).sort()).toEqual(
        [`assets/catalog/${id}/manifest.json`, ...catalog.files.map((asset) => `assets/catalog/${id}/${asset.path}`)].sort(),
      )
      expect(Buffer.from(emitted.find((file) => file.fileName?.endsWith(listed))!.source as Uint8Array).toString())
        .toBe('PAR1 rows PAR1')

      // Development serves the same layout, ranges included, as DuckDB-WASM reads it from Pages.
      callHook(plugin.configResolved, {}, { command: 'serve', base: '/' })
      const serve = installMiddleware(plugin)!
      const url = `/assets/catalog/${id}/${listed}`
      const ranged = await answer(serve, url, { range: 'bytes=0-3' })
      expect(ranged).toMatchObject({ status: 206, body: 'PAR1' })
      expect(ranged.headers['content-range']).toBe('bytes 0-3/14')
      expect(await answer(serve, url, { range: 'bytes=-4' })).toMatchObject({ status: 206, body: 'PAR1' })
      expect(await answer(serve, url, {})).toMatchObject({ status: 200, body: 'PAR1 rows PAR1' })
      expect((await answer(serve, `/assets/catalog/${id}/manifest.json`, {})).headers['content-type'])
        .toContain('application/json')
      expect(await answer(serve, `/assets/catalog/${id}/notes.txt`, {})).toMatchObject({ status: 'next' })
      expect(await answer(serve, `/assets/catalog/${id}/../../../package.json`, {})).toMatchObject({ status: 'next' })
      expect(await answer(serve, '/assets/catalog/0000000000000000/manifest.json', {})).toMatchObject({ status: 'next' })

      const desktop = await resolveConfig('desktop')
      const desktopEmitted: unknown[] = []
      const desktopPlugin = findPlugin(desktop, 'canopi-web-catalog')
      callHook(desktopPlugin.configResolved, {}, { command: 'build', base: './' })
      callHook(desktopPlugin.buildStart, { emitFile: (file: unknown) => desktopEmitted.push(file) }, {})
      expect(desktopEmitted).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.CANOPI_WEB_CATALOG_INPUT
      else process.env.CANOPI_WEB_CATALOG_INPUT = previous
      rmSync(input, { recursive: true, force: true })
    }
  })

  it('reads a stale generated catalog only in the Web build, and names where it lies (review F1)', async () => {
    const input = mkdtempSync(join(tmpdir(), 'canopi-stale-catalog-'))
    const previous = process.env.CANOPI_WEB_CATALOG_INPUT
    try {
      writeFileSync(join(input, 'manifest.json'), '{"version":"from an older contract"}\n')
      process.env.CANOPI_WEB_CATALOG_INPUT = input
      for (const mode of ['desktop', 'test', 'development']) {
        const config = await resolveConfig(mode)
        expect(config.define?.__CANOPI_WEB_CATALOG_PATH__, mode).toBe(JSON.stringify('assets/catalog/none/'))
      }
      await expect(resolveConfig('web')).rejects.toThrow(/manifest\.json.*npm run generate:web-catalog/s)
    } finally {
      if (previous === undefined) delete process.env.CANOPI_WEB_CATALOG_INPUT
      else process.env.CANOPI_WEB_CATALOG_INPUT = previous
      rmSync(input, { recursive: true, force: true })
    }
  })

  it('points the bundle at an absent catalog when none was generated', async () => {
    const previous = process.env.CANOPI_WEB_CATALOG_INPUT
    try {
      process.env.CANOPI_WEB_CATALOG_INPUT = join(tmpdir(), 'canopi-no-catalog-input')
      expect((await resolveConfig('web')).define?.__CANOPI_WEB_CATALOG_PATH__).toBe(JSON.stringify('assets/catalog/none/'))
    } finally {
      if (previous === undefined) delete process.env.CANOPI_WEB_CATALOG_INPUT
      else process.env.CANOPI_WEB_CATALOG_INPUT = previous
    }
  })
})

function findPlugin(config: UserConfig, name: string): Plugin {
  const plugin = flattenPlugins(config.plugins ?? []).find((candidate) => candidate.name === name)
  if (!plugin) throw new Error(`Missing Vite plugin ${name}`)
  return plugin
}

function callHook(hook: unknown, context: unknown, ...args: unknown[]): unknown {
  const handler = typeof hook === 'function' ? hook : (hook as { handler?: unknown } | undefined)?.handler
  if (typeof handler !== 'function') throw new Error('Missing plugin hook')
  return (handler as (...values: unknown[]) => unknown).call(context, ...args)
}

type Middleware = (request: { url?: string; headers: Record<string, string> }, response: unknown, next: () => void) => void

function installMiddleware(plugin: Plugin): Middleware | undefined {
  let middleware: Middleware | undefined
  callHook(plugin.configureServer, {}, { middlewares: { use(candidate: Middleware) { middleware = candidate } } })
  return middleware
}

async function answer(middleware: Middleware, url: string, headers: Record<string, string>) {
  return new Promise<{ status: number | 'next'; headers: Record<string, string>; body: string }>((resolve) => {
    const response = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value) },
      end(body?: Uint8Array | string) {
        resolve({ status: this.statusCode, headers: this.headers, body: body === undefined ? '' : Buffer.from(body).toString() })
      },
    }
    middleware({ url, headers }, response, () => resolve({ status: 'next', headers: {}, body: '' }))
  })
}

const NAMED_VENDOR_CHUNKS = ['i18n', 'maplibre-gl', 'raster-display', 'tauri']

/** Each named chunk's packages with rendered code, from the real Desktop build. */
async function namedVendorChunkPackages(): Promise<Record<string, string[]>> {
  const packages: Record<string, Set<string>> = {}
  for (const chunk of (await desktopBuild()).chunks) {
    if (!NAMED_VENDOR_CHUNKS.includes(chunk.name)) continue
    for (const [id, module] of Object.entries(chunk.modules)) {
      const name = module.renderedLength > 0 ? packageName(id) : undefined
      if (name) (packages[chunk.name] ??= new Set()).add(name)
    }
  }
  return Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)).map(([chunk, names]) => [chunk, [...names].sort()]))
}

interface DesktopBuild {
  readonly chunks: readonly { name: string; modules: Record<string, { renderedLength: number }> }[]
  /** Every emitted script as written: the chunks, and the workers Vite emits into the bundle as assets. */
  readonly scripts: readonly { fileName: string; code: string }[]
}

let desktopBuildOnce: Promise<DesktopBuild> | undefined

/** Builds the Desktop bundle in memory with the real vite.config.ts, once per file. */
function desktopBuild(): Promise<DesktopBuild> {
  desktopBuildOnce ??= (async () => {
    const { build } = await import('vite')
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const result = await build({ root, configFile: join(root, 'vite.config.ts'), mode: 'production', logLevel: 'silent', build: { write: false } })
      const output = (Array.isArray(result) ? result : [result]).flatMap((entry) => 'output' in entry ? entry.output : [])
      const chunks = output.flatMap((file) => file.type === 'chunk' ? [file] : [])
      const scripts = output.flatMap((file) => {
        if (file.type === 'chunk') return [{ fileName: file.fileName, code: file.code }]
        if (!/\.m?js$/.test(file.fileName)) return []
        return [{ fileName: file.fileName, code: typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8') }]
      })
      return { chunks, scripts }
    } finally {
      process.env.NODE_ENV = nodeEnv
    }
  })()
  return desktopBuildOnce
}

/** The package a module id belongs to (the innermost node_modules entry), or undefined for app and virtual modules. */
function packageName(id: string): string | undefined {
  const parts = id.replace(/\\/g, '/').split('/node_modules/')
  if (parts.length < 2) return undefined
  const segments = parts.at(-1)!.split('/')
  return segments[0]!.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]
}

async function resolveGalleryConfig(): Promise<UserConfig> {
  if (typeof galleryConfig !== 'function') return galleryConfig
  return Promise.resolve(galleryConfig({ command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false }))
}

/** Every `rollupOptions` or `esbuildOptions` key in a config, by its dotted path (plugins are not config). */
function deprecatedOptionPaths(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key
    if (key === 'plugins') return []
    return [
      ...(key === 'rollupOptions' || key === 'esbuildOptions' ? [childPath] : []),
      ...deprecatedOptionPaths(child, childPath),
    ]
  })
}

async function resolveConfig(mode: string): Promise<UserConfig> {
  if (typeof viteConfig !== 'function') return viteConfig
  const environment: ConfigEnv = {
    command: 'serve',
    mode,
    isSsrBuild: false,
    isPreview: false,
  }
  return Promise.resolve(viteConfig(environment))
}

function aliasPath(config: UserConfig, alias: string): string {
  const aliases = config.resolve?.alias
  if (!aliases || Array.isArray(aliases)) throw new Error('Expected object-form Vite aliases')
  const path = Object.entries(aliases).find(([name]) => name === alias)?.[1]
  if (typeof path !== 'string') throw new Error(`Missing Vite alias ${alias}`)
  return path.replace(/\\/g, '/')
}

type DevMiddleware = (
  request: { url?: string },
  response: unknown,
  next: () => void,
) => void

function installDevEntryMiddleware(config: UserConfig): DevMiddleware | undefined {
  const plugin = flattenPlugins(config.plugins ?? []).find(
    (candidate) => candidate.name === 'canopi-web-edition-dev-entry',
  )
  if (!plugin || typeof plugin.configureServer !== 'function') {
    throw new Error('Missing Web Edition development-entry plugin hook')
  }

  let middleware: DevMiddleware | undefined
  // Vite 8 types the hook's `this` as a minimal plugin context; the plugin under test never reads it.
  plugin.configureServer.call({} as never, {
    middlewares: {
      use(candidate: DevMiddleware) {
        middleware = candidate
      },
    },
  } as never)
  return middleware
}

function flattenPlugins(options: readonly PluginOption[]): Plugin[] {
  return options.flatMap((option): Plugin[] => {
    if (!option) return []
    if (Array.isArray(option)) return flattenPlugins(option)
    if (typeof (option as PromiseLike<unknown>).then === 'function') {
      throw new Error('Unexpected async Vite plugin in raw test configuration')
    }
    return [option as Plugin]
  })
}

function cssValue(source: string, rule: string, property: string): string | undefined {
  return parseCssDeclarations('fixture.module.css', source).find(
    (declaration) => declaration.rule === rule && declaration.property === property,
  )?.value
}
