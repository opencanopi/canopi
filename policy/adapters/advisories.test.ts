// advisories.ts over planted exception tables and a fake osv-scanner, through the real CLI and the real adapter
// (2.1-M204; ported from scripts/test_advisories.py, 2.1-Q261, 2.1-M349). The fake scanner replays JSON, an exit status
// and stderr from the environment and counts its runs, so the retry and offline rules are seen without a network or a
// database.
import { spawnSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCKFILES } from './osv-scanner.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CLI = join(REPO_ROOT, 'policy/adapters/advisories.ts')
const ACTION = join(REPO_ROOT, '.github/actions/osv-advisories/action.yml')

const FAKE_SCANNER = `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(process.env.FAKE_OSV_CALLS, process.argv.slice(2).join(' ') + '\\n')
const count = fs.readFileSync(process.env.FAKE_OSV_CALLS, 'utf8').split('\\n').filter(Boolean).length
if (count <= Number(process.env.FAKE_OSV_FAILURES ?? '0')) {
  process.stderr.write('query failed: dial tcp: lookup api.osv.dev: no such host\\n')
  process.stdout.write('{"results": []}\\n')
  process.exit(127)
}
process.stdout.write(fs.readFileSync(process.env.FAKE_OSV_JSON, 'utf8'))
process.exit(Number(process.env.FAKE_OSV_STATUS ?? '1'))
`

interface Group { readonly ids: readonly string[], readonly aliases: readonly string[] }
const GLIB: Group = { ids: ['GHSA-wrw7-89jp-8q8g', 'RUSTSEC-2024-0429'], aliases: ['GHSA-wrw7-89jp-8q8g', 'RUSTSEC-2024-0429'] }
const TOKIO: Group = { ids: ['RUSTSEC-2026-0386'], aliases: ['RUSTSEC-2026-0386'] }
const ENTRY: Readonly<Record<string, string>> = { id: 'RUSTSEC-2024-0429', package: 'glib', reason: "Tauri 2's GTK3 webview chain",
  until: '2027-04-27', upstream: 'W17' }
const STALE = { ...ENTRY, id: 'RUSTSEC-2024-0370', package: 'proc-macro-error' }
const without = (field: string) => Object.fromEntries(Object.entries(ENTRY).filter(([key]) => key !== field))

/** osv-scanner JSON naming every lockfile: Cargo.lock holds each [package, groups]; the npm lockfiles are clean. */
function report(...groupsByPackage: (readonly [string, readonly Group[]])[]) {
  const cargo: object[] = groupsByPackage.map(([name, groups]) => ({ package: { name, version: '1.0.0', ecosystem: 'crates.io' },
    groups, vulnerabilities: groups.map((group) => ({ id: group.ids[0] })) }))
  cargo.push({ package: { name: 'serde', version: '1.0.228', ecosystem: 'crates.io' } })
  return { results: [
    { source: { path: '/work/Cargo.lock', type: 'lockfile' }, packages: cargo },
    { source: { path: '/work/desktop/web/package-lock.json', type: 'lockfile' },
      packages: [{ package: { name: 'preact', version: '11.0.1', ecosystem: 'npm' } }] },
    { source: { path: '/work/desktop/web/e2e/platform/phones/ios/appium/package-lock.json', type: 'lockfile' },
      packages: [{ package: { name: 'appium', version: '3.8.0', ecosystem: 'npm' } }] },
  ] }
}

let dir = ''
let root = ''
let env: Record<string, string> = {}
const calls = () => join(dir, 'calls')
const summary = () => join(dir, 'summary.md')
const table = (entries: readonly object[]) => writeFileSync(join(root, 'policy/advisories.json'), JSON.stringify({ version: 1, advisories: entries }))
const scan = (data: object, status = 1) => {
  writeFileSync(join(dir, 'scan.json'), JSON.stringify(data))
  env['FAKE_OSV_STATUS'] = String(status)
}
const run = (...args: string[]) => {
  const result = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8', env: { ...process.env,
    OSV_SCANNER: join(dir, 'osv-scanner'), FAKE_OSV_JSON: join(dir, 'scan.json'), FAKE_OSV_CALLS: calls(), ...env } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
const generate = () => expect(run('generate').status).toBe(0)
const check = (...args: string[]) => run('check', '--today', '2026-10-27', '--summary', summary(), ...args)
const passes = (...args: string[]) => {
  const result = check(...args)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  return result
}
const fails = (message: string, ...args: string[]) => {
  const result = check(...args)
  expect(result.status, result.stdout + result.stderr).toBe(1)
  expect(result.stderr).toContain(message)
  return result
}
const scans = () => readFileSync(calls(), 'utf8').split('\n').filter((line) => line !== '').length

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'advisories-'))
  root = join(dir, 'repo')
  mkdirSync(join(root, 'policy'), { recursive: true })
  writeFileSync(join(dir, 'osv-scanner'), FAKE_SCANNER)
  chmodSync(join(dir, 'osv-scanner'), 0o755)
  writeFileSync(calls(), '')
  env = {}
  table([ENTRY])
  scan(report(['glib', [GLIB]]))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('generation', () => {
  it('generation is byte-identical and replaces the file whole', () => {
    generate()
    const toml = join(root, 'osv-scanner.toml')
    const first = readFileSync(toml, 'utf8')
    linkSync(toml, join(dir, 'linked.toml'))
    generate()
    expect(readFileSync(toml, 'utf8')).toBe(first)
    // Temp plus rename: the old inode (a hard link to it) is never written in place.
    expect(statSync(toml).ino).not.toBe(statSync(join(dir, 'linked.toml')).ino)
    expect(first).toContain('id = "RUSTSEC-2024-0429"')
    expect(first).toContain('ignoreUntil = 2027-04-27T00:00:00Z')
  })

  it('a hand-edited config fails and check never writes', () => {
    generate()
    const toml = join(root, 'osv-scanner.toml')
    const edited = readFileSync(toml, 'utf8').replace('2027-04-27', '2099-01-01')
    writeFileSync(toml, edited)
    fails('osv-scanner.toml differs from what policy/advisories.json generates')
    expect(readFileSync(toml, 'utf8')).toBe(edited)
  })

  it("the repository's config is what its table generates", () => {
    const result = spawnSync(process.execPath, [CLI, 'generate', '--stdout'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(readFileSync(join(REPO_ROOT, 'osv-scanner.toml'), 'utf8'))
  })

  it('unreadable: a malformed table fails naming the file, before any scan', () => {
    writeFileSync(join(root, 'policy/advisories.json'), '{ "advisories": [ ')
    fails('ERROR: policy/advisories.json cannot be read')
    writeFileSync(join(root, 'policy/advisories.json'), '{ "version": 1 }')
    fails('ERROR: policy/advisories.json has no top-level advisories array')
    expect(scans()).toBe(0)
  })
})

describe('the table', () => {
  it('a clean run passes', () => {
    generate()
    passes()
  })

  it('an entry with no W tag fails', () => {
    table([without('upstream')])
    generate()
    fails('RUSTSEC-2024-0429 has no upstream W tag')
  })

  it('an expired entry fails', () => {
    table([{ ...ENTRY, until: '2026-10-01' }])
    generate()
    fails('RUSTSEC-2024-0429 expired on 2026-10-01')
  })

  it('a stale entry fails', () => {
    table([ENTRY, STALE])
    generate()
    fails('RUSTSEC-2024-0370 is no longer reported: delete its entry')
  })

  it('a non-lockfile PR reports expired and stale entries and passes; the database or the calendar moved, not the PR', () => {
    table([{ ...ENTRY, until: '2026-10-01' }, STALE])
    generate()
    const result = passes('--event', 'pull_request', '--changed', 'renovate.json')
    expect(result.stdout).toContain('RUSTSEC-2024-0429 expired on 2026-10-01')
    expect(result.stdout).toContain('RUSTSEC-2024-0370 is no longer reported')
    fails('RUSTSEC-2024-0429 expired on 2026-10-01', '--event', 'pull_request', '--changed', 'desktop/web/package-lock.json')
    fails('RUSTSEC-2024-0370 is no longer reported', '--event', 'schedule')
  })

  it('a PR editing the table or its config fails on expired and stale entries, its own fault', () => {
    table([{ ...ENTRY, until: '2026-10-01' }, STALE])
    generate()
    for (const changed of [['policy/advisories.json', 'osv-scanner.toml'], ['osv-scanner.toml']]) {
      fails('RUSTSEC-2024-0429 expired on 2026-10-01', '--event', 'pull_request', '--changed', ...changed)
      fails('RUSTSEC-2024-0370 is no longer reported', '--event', 'pull_request', '--changed', ...changed)
    }
  })

  it('a non-lockfile PR still fails on the table it can fix', () => {
    table([without('upstream')])
    generate()
    fails('RUSTSEC-2024-0429 has no upstream W tag', '--event', 'pull_request', '--changed', 'renovate.json')
  })

  it('an entry listed by an alias matches its group', () => {
    table([{ ...ENTRY, id: 'GHSA-wrw7-89jp-8q8g' }])
    generate()
    passes()
  })
})

describe('a new advisory', () => {
  beforeEach(() => {
    generate()
    scan(report(['glib', [GLIB]], ['tokio', [TOKIO]]))
  })

  it('an unlisted advisory fails with a ready bead line', () => {
    fails('RUSTSEC-2026-0386 (tokio@1.0.0 in Cargo.lock) is not in policy/advisories.json', '--event', 'schedule')
    expect(readFileSync(summary(), 'utf8')).toMatch(/^bd create .*RUSTSEC-2026-0386.*tokio@1\.0\.0/mu)
  })

  it('main fails and a lockfile or table PR fails', () => {
    fails('RUSTSEC-2026-0386', '--event', 'push')
    fails('RUSTSEC-2026-0386', '--event', 'pull_request', '--changed', 'Cargo.lock')
    fails('RUSTSEC-2026-0386', '--event', 'pull_request', '--changed', 'policy/advisories.json')
  })

  it('a PR changing no lockfile or table reports the bead line and passes', () => {
    expect(passes('--event', 'pull_request', '--changed', 'renovate.json').stdout).toContain('RUSTSEC-2026-0386')
    expect(readFileSync(summary(), 'utf8')).toMatch(/^bd create .*RUSTSEC-2026-0386/mu)
  })
})

describe('scanner failures', () => {
  beforeEach(generate)

  it('retried: an unreachable API fails after one retry', () => {
    env['FAKE_OSV_FAILURES'] = '5'
    fails('after one retry')
    expect(scans()).toBe(2)
  })

  it('retried: one failure is retried once', () => {
    env['FAKE_OSV_FAILURES'] = '1'
    passes()
    expect(scans()).toBe(2)
  })

  it('offline without a cached database fails at once', () => {
    env['FAKE_OSV_FAILURES'] = '5'
    fails('no cached advisory database', '--offline')
    expect(scans()).toBe(1)
    expect(readFileSync(calls(), 'utf8')).toContain('--offline')
  })
})

describe('the workflow', () => {
  it('CI holds no bd call and runs this check (2.1-M197)', () => {
    const text = readFileSync(ACTION, 'utf8')
    expect(text).not.toMatch(/^\s*(?:-\s*)?(?:run:\s*)?bd\s/mu)
    expect(text).toContain('node policy/adapters/advisories.ts check')
  })

  it('canopi-f47t.52.228.14: every tracked lockfile is scanned, and Renovate sees each', () => {
    // The iOS lane's Appium lockfile (2.1-Q247) is scanned like the app's: a lockfile the lane skips is never checked
    // against the exception table (supply-chain.test.ts holds that a PR changing it runs the lane).
    const tracked = spawnSync('git', ['ls-files', 'Cargo.lock', '*package-lock.json'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout
      .split('\n').filter((path) => path !== '' && !path.startsWith('policy/fixtures/'))
    expect(tracked).toContain('desktop/web/e2e/platform/phones/ios/appium/package-lock.json')
    for (const lockfile of tracked) expect(LOCKFILES).toContain(lockfile)
    // Renovate's npm manager finds every package.json its ignorePaths leave, under the 14-day age (2.1-Q245).
    const renovate = JSON.parse(readFileSync(join(REPO_ROOT, 'renovate.json'), 'utf8')) as { minimumReleaseAge: string, ignorePaths?: string[] }
    expect(renovate.minimumReleaseAge).toBe('14 days')
    for (const lockfile of tracked) {
      for (const ignored of renovate.ignorePaths ?? []) {
        const glob = ignored.replace(/[.+^${}()|[\]\\?]/gu, '\\$&').replace(/\*\*\//gu, '\0').replace(/\*\*/gu, '\u0001')
          .replace(/\*/gu, '[^/]*').replace(/\0/gu, '(?:.*/)?').replace(/\u0001/gu, '.*')
        expect(new RegExp(`^${glob}$`, 'u').test(lockfile), `${ignored} hides ${lockfile} from Renovate`).toBe(false)
      }
    }
  })
})
