import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { checkCssCascade } from './check-css-cascade.mjs'

const SCRIPT = fileURLToPath(new URL('./check-css-cascade.mjs', import.meta.url))
const MAPLIBRE = '.maplibregl-map{overflow:hidden}'
const GLOBAL = ':root{--z-canvas-tool-card:30}[role=menuitemradio]:focus-visible{outline:0}[inert] *{cursor:default}[data-design-chrome] *{margin:0}'
const MODULE = '._panel_a1b2c_3{color:red}'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A synthetic build directory named `name` holding `page`, linking each stylesheet in order and writing its CSS. */
function plantDist(name: string, page: string, sheets: [string, string | null][]): string {
  const root = mkdtempSync(join(tmpdir(), 'canopi-css-cascade-'))
  roots.push(root)
  const dist = join(root, name)
  mkdirSync(join(dist, 'assets'), { recursive: true })
  const links = sheets.map(([file]) => `<link rel="stylesheet" crossorigin href="/assets/${file}">`).join('')
  writeFileSync(join(dist, page), `<!doctype html><html><head>${links}</head><body></body></html>`)
  for (const [file, css] of sheets) if (css !== null) writeFileSync(join(dist, 'assets', file), css)
  return dist
}

describe('the built stylesheet cascade check', () => {
  // A sound build passes however Rolldown splits its stylesheets, and a sheet holding no anchor changes nothing.
  const VENDOR = '.picker{display:block}'
  it.each([
    ['Desktop', 'dist', 'index.html'],
    ['Web', 'dist-web', 'web.html'],
  ])('passes MapLibre, then global.css, then every CSS Module rule, in a %s build', (_edition, name, page) => {
    expect(checkCssCascade(plantDist(name, page, [['maplibre-gl.css', MAPLIBRE], ['global-styles.css', GLOBAL], ['Panel.css', MODULE]]))).toEqual([])
    expect(checkCssCascade(plantDist(name, page, [['a.css', MAPLIBRE + GLOBAL + MODULE]]))).toEqual([])
    expect(checkCssCascade(plantDist(name, page, [['vendor.css', VENDOR], ['maplibre-gl.css', MAPLIBRE], ['index.css', GLOBAL + MODULE]]))).toEqual([])
    expect(checkCssCascade(plantDist(name, page, [['a.css', MAPLIBRE + GLOBAL], ['Panel.css', MODULE], ['vendor.css', VENDOR]]))).toEqual([])
  })

  it('names a CSS Module rule linked before global.css, and global.css linked before MapLibre', () => {
    expect(checkCssCascade(plantDist('dist', 'index.html', [['maplibre-gl.css', MAPLIBRE], ['Panel.css', MODULE], ['global-styles.css', GLOBAL]])))
      .toContain('dist/index.html links a CSS Module rule before global.css\'s "--z-canvas-tool-card:"')
    expect(checkCssCascade(plantDist('dist', 'index.html', [['global-styles.css', GLOBAL], ['maplibre-gl.css', MAPLIBRE], ['Panel.css', MODULE]])))
      .toContain('dist/index.html links global.css\'s "[inert] *" before MapLibre\'s stylesheet')
  })

  it('names global.css split across two stylesheets, and a stylesheet anchor no build holds', () => {
    const split = checkCssCascade(plantDist('dist', 'index.html', [['maplibre-gl.css', MAPLIBRE], ['g1.css', GLOBAL.slice(0, 30)], ['g2.css', GLOBAL.slice(30)], ['Panel.css', MODULE]]))
    expect(split).toContain('dist/index.html holds global.css in more than one stylesheet')
    expect(checkCssCascade(plantDist('dist', 'index.html', [['global-styles.css', GLOBAL], ['Panel.css', MODULE]])))
      .toEqual(['dist/index.html links no stylesheet holding MapLibre\'s stylesheet (.maplibregl-map)'])
  })

  it('refuses a missing build directory, naming the build to run', () => {
    const root = mkdtempSync(join(tmpdir(), 'canopi-css-cascade-'))
    roots.push(root)
    expect(checkCssCascade(join(root, 'dist'))).toEqual([`${join(root, 'dist')} is missing: run npm run build:desktop:bundle`])
    expect(checkCssCascade(join(root, 'dist-web'))).toEqual([`${join(root, 'dist-web')} is missing: run npm run build:web:bundle`])
  })

  it('refuses an interrupted build: no page, or a linked stylesheet that was never written', () => {
    const noPage = plantDist('dist', 'other.html', [['a.css', MAPLIBRE + GLOBAL + MODULE]])
    expect(checkCssCascade(noPage)).toEqual([`${noPage} has no index.html: run npm run build:desktop:bundle`])
    const partial = plantDist('dist-web', 'web.html', [['maplibre-gl.css', MAPLIBRE], ['global-styles.css', null], ['Panel.css', MODULE]])
    expect(checkCssCascade(partial)).toEqual([`${partial} links /assets/global-styles.css, which it does not hold: run npm run build:web:bundle`])
  })

  it('gives the same findings when run again on the same build', () => {
    const dist = plantDist('dist', 'index.html', [['Panel.css', MODULE], ['global-styles.css', GLOBAL], ['maplibre-gl.css', MAPLIBRE]])
    const first = checkCssCascade(dist)
    expect(first.length).toBeGreaterThan(0)
    expect(checkCssCascade(dist)).toEqual(first)
  })

  it('exits non-zero with each finding from the command line, and zero on a sound build', () => {
    const bad = plantDist('dist', 'index.html', [['global-styles.css', GLOBAL], ['Panel.css', MODULE]])
    const failed = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('links no stylesheet holding MapLibre')
    const good = plantDist('dist', 'index.html', [['a.css', MAPLIBRE + GLOBAL + MODULE]])
    expect(spawnSync(process.execPath, [SCRIPT, good], { encoding: 'utf8' }).status).toBe(0)
    expect(spawnSync(process.execPath, [SCRIPT, join(good, 'nowhere')], { encoding: 'utf8' }).stderr).toContain('build directory dist or dist-web')
  })

  it('runs after the Desktop and the Web bundle builds, before the identifier scanner', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    expect(scripts['build:desktop:bundle']).toMatch(/^vite build && node scripts\/check-css-cascade\.mjs dist && /)
    expect(scripts['build:web:bundle']).toMatch(/^npm run build:format-wasm && vite build --mode web && .*node scripts\/check-css-cascade\.mjs dist-web && /)
  })
})
