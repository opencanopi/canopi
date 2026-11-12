// The engine floor in one source (canopi-4kfl; 2.1-M470, 2.1-M490, 2.1-Q327): desktop/web/engine-floor.ts's
// ENGINE_FLOOR drives both editions' build (the real vite.config.ts, loaded as Vite loads it), tauri.conf.json's macOS
// minimumSystemVersion follows it, and the published floor line (README's download line, the stable release notes from
// the reader release on) states it. That a chunk too new for the floor fails is the oldest-engine check's
// (oldest-engine.test.ts); that the floor is where the engines put it is engine-floor-probe.yml's.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ENGINE_FLOOR, ENGINE_FLOOR_BROWSERS, ENGINE_FLOOR_TARGET } from '../../desktop/web/engine-floor.ts'
import { REPO_ROOT } from './planted-repo.ts'

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')

/** `a` against `b` as dotted numbers: negative, zero or positive. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The oldest macOS whose Software Update reaches a Safari at the floor: Monterey (12.0) takes Safari up to 17.6, Ventura
 * (13.0) up to 18.6 (2.1-M470). A floor past Ventura's last Safari has no row yet: add one when the floor gets there.
 */
function minimumMacOSFor(safari: string): string {
  if (compareVersions(safari, '17.6') <= 0) return '12.0'
  if (compareVersions(safari, '18.6') <= 0) return '13.0'
  throw new Error(`no macOS row for a Safari ${safari} floor: add the oldest macOS whose Software Update reaches it`)
}

/** What a published floor line (`text`) leaves out: the macOS version, and each engine at its floor. */
function floorLineGaps(text: string, minimumSystemVersion: string, floor: Readonly<Record<string, string>> = ENGINE_FLOOR): string[] {
  const major = minimumSystemVersion.replace(/\.0$/, '')
  const names: Readonly<Record<string, string>> = { safari: 'Safari', chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' }
  const wanted = [`macOS ${major} or later`, ...Object.entries(floor).map(([engine, version]) => `${names[engine] ?? engine} ${version}`)]
  return wanted.filter((phrase) => !text.includes(phrase))
}

interface TauriConfig { version: string, bundle: { macOS?: { minimumSystemVersion?: string } } }
const tauriConfig = () => JSON.parse(read('desktop/tauri.conf.json')) as TauriConfig

interface BuildConfig {
  build?: { target?: unknown, cssTarget?: unknown }
  optimizeDeps?: { rolldownOptions?: { transform?: { target?: unknown } } }
}

/** vite.config.ts's config for `mode`, as `vite build` resolves it (a variable specifier keeps tsc out of Vite's types). */
async function viteConfig(mode: string): Promise<BuildConfig> {
  const specifier = pathToFileURL(join(REPO_ROOT, 'desktop/web/vite.config.ts')).href
  const module = await import(specifier) as { default: (env: { command: string, mode: string }) => BuildConfig | Promise<BuildConfig> }
  return await module.default({ command: 'build', mode })
}

/** The stable release notes from the reader release (2.0.4) on: each publishes the floor (betas preview Desktop only). */
function stableNotesFromReaderRelease(): string[] {
  return readdirSync(join(REPO_ROOT, 'docs/release-notes'))
    .map((name) => /^v(\d+\.\d+\.\d+)\.md$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null && compareVersions(match[1]!, '2.0.4') >= 0)
    .map((match) => `docs/release-notes/${match[0]}`)
}

describe('the engine floor (canopi-4kfl)', () => {
  it('U canopi-4kfl: the floor is Safari 16.4, as U-2 measured and the user kept (2.1-Q327)', () => {
    expect(ENGINE_FLOOR.safari).toBe('16.4')
    expect(ENGINE_FLOOR_TARGET).toEqual(['es2022', ...ENGINE_FLOOR_BROWSERS])
    expect(ENGINE_FLOOR_BROWSERS).toContain('safari16.4')
  })

  it('U canopi-4kfl: the Desktop build targets the floor for its scripts, its pre-bundled dependencies and its styles', async () => {
    const config = await viteConfig('production')
    expect(config.build?.target).toEqual(ENGINE_FLOOR_TARGET)
    expect(config.optimizeDeps?.rolldownOptions?.transform?.target).toEqual(ENGINE_FLOOR_TARGET)
    expect(config.build?.cssTarget).toEqual(ENGINE_FLOOR_BROWSERS)
  })

  it('U canopi-4kfl: minimumSystemVersion follows the floor (12.0 while Safari is at most 17.6)', () => {
    expect(tauriConfig().bundle.macOS?.minimumSystemVersion).toBe(minimumMacOSFor(ENGINE_FLOOR.safari))
  })

  it('U canopi-4kfl: minimumSystemVersion and the floor disagree: a floor past Monterey\'s Safari needs 13.0, and one past Ventura\'s has no row', () => {
    expect(minimumMacOSFor('16.4')).toBe('12.0')
    expect(minimumMacOSFor('17.6')).toBe('12.0')
    expect(minimumMacOSFor('18.0')).toBe('13.0')
    expect(minimumMacOSFor('18.0')).not.toBe(tauriConfig().bundle.macOS?.minimumSystemVersion)
    expect(() => minimumMacOSFor('26.0')).toThrow('no macOS row for a Safari 26.0 floor')
  })

  it('U canopi-4kfl: a floor line that names another macOS or leaves an engine out is caught', () => {
    const line = 'for macOS 12 or later with Safari 16.4 or later; the Web Edition runs in Safari 16.4, Chrome 111, Edge 111 or Firefox 121 or later'
    expect(floorLineGaps(line, '12.0')).toEqual([])
    expect(floorLineGaps(line, '13.0')).toEqual(['macOS 13 or later'])
    expect(floorLineGaps(line.replace('Firefox 121', 'Firefox'), '12.0')).toEqual(['Firefox 121'])
    expect(floorLineGaps(line, '12.0', { ...ENGINE_FLOOR, safari: '17.0' })).toEqual(['Safari 17.0'])
  })

  // The published line is not this chunk's to write: README.md and the stable notes belong to the release (main agent).
  it.fails('U canopi-4kfl (main agent, expected fail until README and the release notes carry it): the download line and the stable release notes publish the floor', () => {
    const minimum = tauriConfig().bundle.macOS?.minimumSystemVersion ?? ''
    const download = read('README.md').split('\n').find((line) => line.includes('canopi-macos-arm64.dmg')) ?? ''
    expect(download, 'README.md has no download line').not.toBe('')
    expect(floorLineGaps(download, minimum), 'README.md download line').toEqual([])
    for (const notes of stableNotesFromReaderRelease()) expect(floorLineGaps(read(notes), minimum), notes).toEqual([])
  })
})
