import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// One generated file at the repository root (2.1-Q221, 2.1-M216): scripts/generate_notices.mjs merges the npm
// packages both editions bundle (rollup-plugin-license, written by each build), the crates the Desktop binary links
// (cargo-about) and the hand rows of scripts/notices-hand-rows.json. Keyed by name and licence, never by version
// (2.1-M239): a bump passes, a new package or a changed licence fails until the file is regenerated.
// Tests run from desktop/web.
const root = resolve(process.cwd(), '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const notices = read('THIRD_PARTY_NOTICES.md')
const handRows = JSON.parse(read('scripts/notices-hand-rows.json')) as HandRows

interface Row { readonly name: string; readonly license: string | null; readonly version?: string }
interface HandRows { readonly clarifications: { readonly npm: Record<string, { license: string; reason: string }> } }
interface Generator {
  renderNotices(input: { handRows: unknown; npm: readonly Row[]; crates: readonly Row[] }): string
  parseNotices(text: string): { npm: Row[]; crates: Row[] }
  missingFromNotices(text: string, bundled: readonly Row[]): string[]
  writeNotices(target: string, text: string, options: { check: boolean }): boolean
  bundledPackages(options: { dir: string; run(edition: string): void }): Row[]
  CARGO_ABOUT_VERSION: string
  cargoAboutVersionProblem(versionOutput: string): string | null
}
const generator = (await import(pathToFileURL(resolve(root, 'scripts/generate_notices.mjs')).href)) as Generator

const npmFixture: Row[] = [
  { name: 'preact', license: 'MIT', version: '11.0.1' },
  { name: '@duckdb/duckdb-wasm', license: 'MIT', version: '1.33.1' },
  { name: 'png-js', license: null, version: '1.0.0' },
]
const crateFixture: Row[] = [
  { name: 'serde', license: 'MIT OR Apache-2.0', version: '1.0.0' },
  { name: 'proj4rs', license: 'MIT OR Apache-2.0', version: '0.2.0' },
]

describe('the notices generator', () => {
  it('lists every bundled npm package and every linked crate with its licence, in no version', () => {
    const text = generator.renderNotices({ handRows, npm: npmFixture, crates: crateFixture })
    expect(text).toContain('| `preact` | MIT |')
    expect(text).toContain('| `@duckdb/duckdb-wasm` | MIT |')
    expect(text).toContain(`| \`png-js\` | ${handRows.clarifications.npm['png-js']!.license} |`)
    expect(text).toContain('| `serde` | MIT OR Apache-2.0 |')
    for (const row of [...npmFixture, ...crateFixture]) expect(text).not.toContain(row.version)
    expect(generator.parseNotices(text).npm.map((row) => row.name)).toEqual(['@duckdb/duckdb-wasm', 'png-js', 'preact'])
  })

  it('refuses a package with no licence and no clarification, and a clarification for a package not bundled', () => {
    expect(() => generator.renderNotices({ handRows, npm: [{ name: 'mystery', license: null }], crates: [] })).toThrow(/mystery/)
    expect(() => generator.renderNotices({ handRows, npm: [], crates: [] })).toThrow(/png-js.*not bundled/)
  })

  it('--check fails, never writing, on an added package or a changed licence, and passes a version bump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopi-notices-'))
    const target = join(dir, 'THIRD_PARTY_NOTICES.md')
    const render = (npm: Row[], crates = crateFixture) => generator.renderNotices({ handRows, npm, crates })
    expect(generator.writeNotices(target, render(npmFixture), { check: false })).toBe(true)
    const written = readFileSync(target, 'utf8')
    const bumped = npmFixture.map((row) => ({ ...row, version: '99.0.0' }))
    expect(generator.writeNotices(target, render(bumped), { check: true })).toBe(true)
    expect(generator.writeNotices(target, render([...npmFixture, { name: 'left-pad', license: 'WTFPL' }]), { check: true })).toBe(false)
    expect(generator.writeNotices(target, render(npmFixture, [{ ...crateFixture[0]!, license: 'GPL-3.0-only' }, crateFixture[1]!]), { check: true })).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe(written)
    rmSync(dir, { recursive: true })
  })

  it('writes the file through a temporary name and a rename, byte-identical on a rerun', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopi-notices-'))
    const target = join(dir, 'THIRD_PARTY_NOTICES.md')
    writeFileSync(target, 'old')
    const text = generator.renderNotices({ handRows, npm: npmFixture, crates: crateFixture })
    expect(generator.writeNotices(target, text, { check: false })).toBe(true)
    expect(generator.writeNotices(target, generator.renderNotices({ handRows, npm: npmFixture, crates: crateFixture }), { check: true })).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(text)
    rmSync(dir, { recursive: true })
  })

  // A build that refuses a package the file does not name still writes its list first, so regenerating goes on past
  // that refusal; a list the build did not write this run (an earlier run's, or none) is never read.
  it('builds both editions for their lists, reading only lists this run wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopi-notices-'))
    const list = (edition: string, rows: Row[]) => writeFileSync(join(dir, `${edition}.json`), JSON.stringify(rows))
    const built: string[] = []
    expect(generator.bundledPackages({ dir, run: (edition) => { built.push(edition); list(edition, [{ name: edition, license: 'MIT' }]) } }))
      .toEqual([{ name: 'desktop', license: 'MIT' }, { name: 'web', license: 'MIT' }])
    expect(built).toEqual(['desktop', 'web'])
    // The web build stops before its bundle: the desktop list and the earlier web list are both left.
    expect(() => generator.bundledPackages({ dir, run: (edition) => { if (edition === 'desktop') list(edition, []) } }))
      .toThrow(/web\.json.*not written/)
    rmSync(dir, { recursive: true })
  })

  // A crate table from another cargo-about differs from CI's for a reason the line diff never names.
  it('refuses a cargo-about other than the pinned one, naming both versions', () => {
    const pinned = generator.CARGO_ABOUT_VERSION
    expect(generator.cargoAboutVersionProblem(`cargo-about ${pinned}\n`)).toBeNull()
    const problem = generator.cargoAboutVersionProblem('cargo-about 0.8.1\n')
    expect(problem).toContain('0.8.1')
    expect(problem).toContain(`cargo install --locked --version ${pinned} --features cli cargo-about`)
    expect(generator.cargoAboutVersionProblem(`cargo-about ${pinned}1\n`)).not.toBeNull()
    expect(read('.github/workflows/build.yml')).toContain(`tool: cargo-about@${pinned}\n`)
  })

  // Both edition builds take over a minute; a wrong local cargo-about fails before the first one starts.
  // Fake cargo and npm on PATH: the real script runs, and npm leaves a mark if a build was started.
  it.skipIf(process.platform === 'win32')('refuses a wrong cargo-about before it builds either edition', () => {
    const bin = mkdtempSync(join(tmpdir(), 'notices-bin-'))
    try {
      const built = join(bin, 'built')
      writeFileSync(join(bin, 'cargo'), '#!/bin/sh\necho "cargo-about 0.8.1"\n', { mode: 0o755 })
      writeFileSync(join(bin, 'npm'), `#!/bin/sh\ntouch '${built}'\n`, { mode: 0o755 })
      const run = spawnSync(process.execPath, [resolve(root, 'scripts/generate_notices.mjs'), '--check'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      })
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain(`The notices need cargo-about ${generator.CARGO_ABOUT_VERSION}, found "cargo-about 0.8.1"`)
      expect(existsSync(built)).toBe(false)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('fails a build that bundles a package the file does not name with that licence', () => {
    expect(generator.missingFromNotices(notices, [{ name: 'preact', license: 'MIT' }])).toEqual([])
    expect(generator.missingFromNotices(notices, [{ name: 'left-pad', license: 'WTFPL' }, { name: 'preact', license: 'GPL-3.0-only' }]))
      .toEqual(['left-pad (WTFPL)', 'preact (GPL-3.0-only)'])
  })
})

describe('THIRD_PARTY_NOTICES.md', () => {
  const rows = generator.parseNotices(notices)

  it('is the one file, exactly as the generator renders it from its hand rows and lists', () => {
    expect(existsSync(resolve(root, 'desktop/THIRD_PARTY_NOTICES.md'))).toBe(false)
    expect(generator.renderNotices({ handRows, npm: rows.npm, crates: rows.crates })).toBe(notices)
  })

  // The lockfile is the pin: a licence change there without a regenerated file fails here, without a build.
  it('names each npm package with the licence package-lock.json records, and every runtime dependency', () => {
    const lock = JSON.parse(read('desktop/web/package-lock.json')) as { packages: Record<string, { license?: string; dev?: boolean }> }
    const locked = Object.entries(lock.packages).filter(([path, entry]) => path !== '' && !entry.dev)
      .map(([path, entry]) => ({ name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), license: entry.license ?? null }))
    for (const row of rows.npm) {
      const licenses = locked.filter((entry) => entry.name === row.name).map((entry) => entry.license ?? handRows.clarifications.npm[row.name]?.license)
      expect(licenses, row.name).toContain(row.license)
    }
    const { dependencies } = JSON.parse(read('desktop/web/package.json')) as { dependencies: Record<string, string> }
    for (const name of Object.keys(dependencies)) {
      expect(rows.npm.some((row) => row.name === name) || notices.includes(`\`${name}\``), name).toBe(true)
    }
  })

  it('names only crates Cargo.lock pins, and every runtime dependency of the Desktop crate', () => {
    const lock = new Set([...read('Cargo.lock').matchAll(/\[\[package\]\]\nname = "([^"]+)"/g)].map((match) => match[1]))
    for (const row of rows.crates) expect(lock, row.name).toContain(row.name)
    const manifest = read('desktop/Cargo.toml')
    const runtime = [...manifest.matchAll(/^\[(?:target\.[^\]]+\.)?dependencies\]\n([\s\S]*?)(?=^\[)/gm)].flatMap((section) =>
      section[1]!.split('\n').filter((line) => /^[\w-]+ = /.test(line) && !/optional = true|path = /.test(line)).map((line) => line.split(' ')[0]!))
    expect(runtime).toContain('wbgeotiff')
    for (const name of runtime) expect(rows.crates.map((row) => row.name), name).toContain(name)
  })

  it('carries the hand rows: copied code, the GeoLibre CLI sidecar, the CRS data, fonts and map data', () => {
    const revision = /GEOLIBRE_REVISION: &str = "([0-9a-f]{40})"/.exec(read('desktop/src/services/lidar/geolibre.rs'))?.[1]
    expect(revision).toBeDefined()
    expect(notices).toContain(revision!)
    // wbspatialstats declares AGPL-3.0-or-later; it ships in the sidecar and the whitebox-wasm module, not the binary.
    expect(notices).toMatch(/\| wbspatialstats \| [^|]+not the Canopi binary \| https:\/\/github\.com\/opengeos\/whitebox-wasm \| AGPL-3\.0-or-later \|/)
    expect(notices).toMatch(/Corresponding Source/)
    expect(notices).toMatch(/EPSG Geodetic Parameter Dataset[\s\S]*IOGP/)
    expect(notices).toMatch(/crs_table\.rs[\s\S]*proj4rs/)
    // Every copied file the GeoLibre table names still exists.
    const geolibre = notices.slice(notices.indexOf('## GeoLibre'), notices.indexOf('\n## ', notices.indexOf('## GeoLibre') + 1))
    const copied = [...geolibre.matchAll(/^\| `(desktop\/[^`]+)`/gm)].map((match) => match[1]!)
    expect(copied.length).toBeGreaterThan(4)
    for (const path of copied) expect(existsSync(resolve(root, path)), path).toBe(true)
    // Each pinned PDF font's upstream revision, and the licence of every bundled font.
    const fonts = JSON.parse(read('desktop/web/src/app/canvas-pdf/font-assets.json')) as { url: string }[]
    for (const { url } of fonts) {
      const [, repo, commit] = /^https:\/\/raw\.githubusercontent\.com\/notofonts\/([\w-]+)\/([0-9a-f]{40})\//.exec(url)!
      expect(notices, url).toContain(`https://github.com/notofonts/${repo}/tree/${commit}`)
    }
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(notices).toContain('OpenFreeMap')
  })

  // A new transitive crate or a removed package shows only in the full regeneration, so one package script runs the
  // lane and CI's notices job runs that same script. Its gate row (AGENTS.md, scripts/gate.py) is the merge agent's.
  it('is regenerated and checked by package scripts, the check being the one CI runs', () => {
    const { scripts } = JSON.parse(read('desktop/web/package.json')) as { scripts: Record<string, string> }
    expect(scripts['generate:notices']).toBe('node ../../scripts/generate_notices.mjs')
    expect(scripts['check:notices']).toBe('node ../../scripts/generate_notices.mjs --check')
    const workflow = read('.github/workflows/build.yml')
    expect(workflow).toContain('run: npm run check:notices --prefix desktop/web\n')
    expect(workflow).not.toMatch(/node \S*generate_notices\.mjs|build:(desktop|web):bundle --prefix/)
  })

  // Desktop ships it as a Tauri resource from the root, with or without the bundled plant DB; Web as a build file.
  it('ships in both editions from the root file', () => {
    const resources = (JSON.parse(read('desktop/tauri.conf.json')) as { bundle: { resources: Record<string, string> } }).bundle.resources
    expect(resources['../THIRD_PARTY_NOTICES.md']).toBe('THIRD_PARTY_NOTICES.md')
    const buildScript = read('desktop/build.rs')
    expect(buildScript).toContain('"../THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md"')
    expect(buildScript).toContain('cargo:rerun-if-changed=../THIRD_PARTY_NOTICES.md')
  })
})
