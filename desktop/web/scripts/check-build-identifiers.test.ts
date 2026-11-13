import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { builtChunkViolations, DESKTOP_VENDOR_CHUNKS } from './check-build-identifiers.mjs'

const SCRIPT = fileURLToPath(new URL('./check-build-identifiers.mjs', import.meta.url))
const NOTICES = '# Third-party notices\n\nmaplibre-gl BSD-3-Clause\n'

interface Chunk { fileName: string; name: string; isEntry: boolean; imports?: string[]; packages: string[]; code?: string }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A written build `name` with its chunks, its chunk facts and a root notices file; null code leaves a chunk unwritten. */
function plantBuild(name: string, chunks: Chunk[], { shipped = NOTICES }: { shipped?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'canopi-built-chunks-'))
  roots.push(root)
  const dist = join(root, name)
  const factsDir = join(root, 'facts')
  const noticesPath = join(root, 'THIRD_PARTY_NOTICES.md')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  mkdirSync(factsDir)
  writeFileSync(noticesPath, NOTICES)
  if (shipped !== null) writeFileSync(join(dist, 'THIRD_PARTY_NOTICES.md'), shipped)
  for (const { fileName, code } of chunks) if (code !== undefined) writeFileSync(join(dist, fileName), code)
  const facts = chunks.map(({ code: _code, imports = [], ...chunk }) => ({ ...chunk, imports }))
  writeFileSync(join(factsDir, `${name === 'dist' ? 'desktop' : 'web'}.json`), JSON.stringify({ chunks: facts }))
  return { dist, options: { factsDir, noticesPath } }
}

/**
 * A sound Desktop build: the entry importing the four named vendor chunks with their packages, and the notices' lazy
 * chunk.
 */
function soundDesktop(): Chunk[] {
  const vendors = Object.keys(DESKTOP_VENDOR_CHUNKS).map((name) => `assets/${name}-c.js`)
  return [
    { fileName: 'assets/index-a.js', name: 'index', isEntry: true, imports: vendors, packages: ['preact'], code: 'import "./about-b.js";' },
    { fileName: 'assets/about-b.js', name: 'about', isEntry: false, packages: [], code: 'export const t="# Third-party notices";' },
    ...Object.entries(DESKTOP_VENDOR_CHUNKS).map(([name, packages]) => (
      { fileName: `assets/${name}-c.js`, name, isEntry: false, packages: [...packages], code: 'export {};' })),
  ]
}

describe('the built chunk check', () => {
  it('passes a Desktop build whose named vendor chunks hold their packages and whose notices ship in a lazy chunk', () => {
    const { dist, options } = plantBuild('dist', soundDesktop())
    expect(builtChunkViolations(dist, options)).toEqual([])
    const web = plantBuild('dist-web', soundDesktop().filter(({ name }) => name !== 'tauri'))
    expect(builtChunkViolations(web.dist, web.options)).toEqual([])
  })

  it('names a Desktop vendor chunk holding other packages than it held on Rollup, and a named chunk gone', () => {
    const chunks = soundDesktop().filter(({ name }) => name !== 'tauri')
      .map((chunk) => (chunk.name === 'i18n' ? { ...chunk, packages: [...chunk.packages, 'preact'] } : chunk))
    const { dist, options } = plantBuild('dist', chunks)
    expect(builtChunkViolations(dist, options)).toEqual([
      'dist: the vendor chunk i18n holds i18next, preact; it held i18next',
      'dist: the vendor chunk tauri holds nothing; it held @tauri-apps/api, @tauri-apps/plugin-dialog',
    ])
  })

  it('names notices that differ from the root file, are missing, or ship in the entry chunk', () => {
    const differ = plantBuild('dist', soundDesktop(), { shipped: '# Third-party notices\n' })
    expect(builtChunkViolations(differ.dist, differ.options)).toEqual(['dist: THIRD_PARTY_NOTICES.md differs from the root THIRD_PARTY_NOTICES.md'])
    const missing = plantBuild('dist-web', soundDesktop(), { shipped: null })
    expect(builtChunkViolations(missing.dist, missing.options)).toEqual(['dist-web: THIRD_PARTY_NOTICES.md is not at the build root'])
    const inEntry = soundDesktop().map((chunk) => (
      chunk.name === 'index' ? { ...chunk, code: 'const t="# Third-party notices";' } : chunk.name === 'about' ? { ...chunk, code: 'export {};' } : chunk))
    const entry = plantBuild('dist', inEntry)
    expect(builtChunkViolations(entry.dist, entry.options)).toEqual(['dist: the notices ship in assets/index-a.js, not in one lazy chunk'])
  })

  it('refuses a build with no chunk list, or one listing a chunk the build never wrote, naming the build to run', () => {
    const { dist, options } = plantBuild('dist', soundDesktop())
    rmSync(join(options.factsDir, 'desktop.json'))
    expect(builtChunkViolations(dist, options)).toEqual([`${join(options.factsDir, 'desktop.json')} is missing: run npm run build:desktop:bundle`])
    const chunks = soundDesktop().map(({ code, ...chunk }) => (chunk.name === 'i18n' ? chunk : { ...chunk, code }))
    const partial = plantBuild('dist-web', chunks)
    expect(builtChunkViolations(partial.dist, partial.options))
      .toEqual(['dist-web: assets/i18n-c.js is in the chunk list but not written: run npm run build:web:bundle'])
  })

  it('canopi-72fm: names a top-level await on the entry\'s static graph, in either edition, and passes one only loaded on demand', () => {
    // A top-level await anywhere the entry imports statically delays the app's mount past the load event, where the
    // start-up guard shows over a working app (canopi-72fm: the LZW codec's WASM init rode in raster-display).
    const awaiting = (code: string) => soundDesktop().map((chunk) => (chunk.name === 'raster-display' ? { ...chunk, code } : chunk))
    const desktop = plantBuild('dist', awaiting('await async function(){}();export const d=1;'))
    expect(builtChunkViolations(desktop.dist, desktop.options))
      .toEqual(['dist: assets/raster-display-c.js runs a top-level await on the entry\'s static graph, so the app would mount after the load event'])
    const forAwait = plantBuild('dist-web', awaiting('for await (const x of []) {}'))
    expect(builtChunkViolations(forAwait.dist, forAwait.options))
      .toEqual(['dist-web: assets/raster-display-c.js runs a top-level await on the entry\'s static graph, so the app would mount after the load event'])
    const inFunctions = plantBuild('dist', awaiting('export async function f(){await 1}const g=async()=>{for await (const x of []);};class C{async m(){await 1}}'))
    expect(builtChunkViolations(inFunctions.dist, inFunctions.options)).toEqual([])
    const lazy = plantBuild('dist', [...soundDesktop(), { fileName: 'assets/lzw-d.js', name: 'lzw', isEntry: false, packages: [], code: 'await 1;' }])
    expect(builtChunkViolations(lazy.dist, lazy.options)).toEqual([])
  })

  it('refuses a chunk list without static imports, an older build, naming the build to run', () => {
    const { dist, options } = plantBuild('dist', soundDesktop())
    const factsPath = join(options.factsDir, 'desktop.json')
    const facts = JSON.parse(readFileSync(factsPath, 'utf8')) as { chunks: Record<string, unknown>[] }
    writeFileSync(factsPath, JSON.stringify({ chunks: facts.chunks.map(({ imports: _imports, ...chunk }) => chunk) }))
    expect(builtChunkViolations(dist, options)).toEqual(['dist: the chunk list names no static imports: run npm run build:desktop:bundle'])
  })

  it('exits non-zero naming a non-ASCII script of a written build, every Desktop and Web script and worker scanned', () => {
    const { dist } = plantBuild('dist', [{ fileName: 'assets/worker.mjs', name: 'worker', isEntry: false, packages: [], code: 'self.x={࢏:1};\n' }])
    const run = spawnSync(process.execPath, [SCRIPT, dist], { encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('assets/worker.mjs has the non-ASCII identifier "࢏" (U+088F)')
    expect(run.stderr).toContain('assets/worker.mjs has the non-ASCII character')
  })
})
