// The Mac bundle's ad-hoc seal (canopi-3cu2; design check U-7; 2.1-M472, Q305: never a Developer ID). The signing
// probe (macos-signing-probe.yml, PR #96 on macOS 15 arm64 with Gatekeeper on) read today's linker-signed bundle as
// "damaged" with no Open Anyway, and the signingIdentity '-' bundle as "could not verify" with Open Anyway; so
// desktop/tauri.macos.conf.json signs ad hoc, the Release Candidate's Mac build fails unless its .app is sealed ad hoc
// with its resources, the probe keeps comparing against 2.0.3's unsigned bundle, and the install text users read is
// the probe's for the shipped decision. Each failure state is planted here: a linker-signed candidate that would pass,
// a probe whose unsigned row silently turns ad hoc, and install text naming a step the shipped bundle never shows. The
// workflow steps run for real in bash, with codesign stubbed and the probe's rows planted.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { cleanEnv, REPO_ROOT } from './planted-repo.ts'
import { TABLE } from './table.ts'

const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')

interface Step {
  readonly name?: string, readonly uses?: string, readonly if?: string, readonly run?: string, readonly shell?: string
  readonly 'timeout-minutes'?: number, readonly env?: Readonly<Record<string, string>>
}
interface Job {
  readonly steps?: readonly Step[]
  readonly strategy?: { readonly matrix?: { readonly include?: readonly Record<string, unknown>[] } }
}
interface Workflow { readonly jobs?: Readonly<Record<string, Job>> }
interface MacConfig { readonly bundle?: { readonly macOS?: { readonly signingIdentity?: unknown } } }

const MAC_CONFIG = 'desktop/tauri.macos.conf.json'
const RC = '.github/workflows/release-candidate.yml'
const SEAL_STEP = 'The Mac app is sealed ad hoc with its resources'
const PACKAGE_STEP = 'Package the desktop app'

const macConfig = JSON.parse(read(MAC_CONFIG)) as MacConfig
const rc = parse(read(RC)) as Workflow

/** Why the shipped Mac config and the Release Candidate's seal check no longer hold together, empty when they do. */
function signingFaults(config: MacConfig, workflow: Workflow): string[] {
  const faults: string[] = []
  if (config.bundle?.macOS?.signingIdentity !== '-') faults.push(`${MAC_CONFIG} does not sign ad hoc (bundle.macOS.signingIdentity '-')`)
  const build = workflow.jobs?.['build'] ?? {}
  const macRows = (build.strategy?.matrix?.include ?? []).filter((row) => String(row['os']).startsWith('macos-'))
  if (macRows.map((row) => row['target']).sort().join(' ') !== 'aarch64-apple-darwin x86_64-apple-darwin') {
    faults.push(`${RC} build packages no Mac target pair (aarch64 and x86_64)`)
  }
  return [...faults, ...sealStepFaults(build.steps ?? [])]
}

/** Why the build job's seal check would not read the packaged Mac app, empty when it does. */
function sealStepFaults(steps: readonly Step[]): string[] {
  const names = steps.map((step) => step.name ?? '')
  const seal = steps.find((step) => step.name === SEAL_STEP)
  if (seal === undefined) return [`${RC} build has no step "${SEAL_STEP}"`]
  const faults: string[] = []
  if (names.indexOf(SEAL_STEP) < names.indexOf(PACKAGE_STEP) || !names.includes(PACKAGE_STEP)) faults.push(`${RC} build checks the seal before packaging`)
  if (seal.if !== "runner.os == 'macOS'") faults.push(`${RC} build's seal check runs on ${seal.if ?? 'every runner'}, not on macOS alone`)
  if (typeof seal['timeout-minutes'] !== 'number') faults.push(`${RC} build's seal check sets no timeout-minutes`)
  for (const reading of ['codesign --verify --deep --strict', 'codesign -dv', 'linker-signed']) {
    if (!(seal.run ?? '').includes(reading)) faults.push(`${RC} build's seal check never reads ${reading}`)
  }
  return faults
}

describe('the Mac bundle is sealed ad hoc (canopi-3cu2)', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  /** A step's script run by bash in a planted tree, with `codesign` stubbed as `stub` says and `env` set. */
  function runStep(script: string, files: Readonly<Record<string, string>>, env: Readonly<Record<string, string>>) {
    dir = mkdtempSync(join(tmpdir(), 'canopi-macos-signing-'))
    const bin = join(dir, 'bin')
    const work = join(dir, 'work')
    mkdirSync(bin)
    mkdirSync(work)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(work, path, '..'), { recursive: true })
      if (path.endsWith('/')) mkdirSync(join(work, path), { recursive: true })
      else writeFileSync(join(work, path), content)
    }
    writeFileSync(join(bin, 'codesign'), `#!/bin/sh
case " $* " in
  *" --verify "*) printf '%s\\n' "$STUB_VERIFY_MSG" >&2; exit "$STUB_VERIFY_EXIT" ;;
  *" -dv "*) printf '%s\\n' "$STUB_DV_MSG" >&2; exit 0 ;;
esac
exit 64
`)
    chmodSync(join(bin, 'codesign'), 0o755)
    writeFileSync(join(dir, 'step.sh'), script)
    return spawnSync('bash', [join(dir, 'step.sh')], {
      cwd: work, encoding: 'utf8', timeout: 30_000,
      env: { ...cleanEnv(), ...env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
    })
  }

  it('canopi-3cu2: the shipped Mac config signs ad hoc and the Release Candidate checks the seal on both Mac targets', () => {
    expect(signingFaults(macConfig, rc)).toEqual([])
    // Planted removals: the config's identity, then the step.
    expect(signingFaults({ bundle: {} }, rc)).toEqual([`${MAC_CONFIG} does not sign ad hoc (bundle.macOS.signingIdentity '-')`])
    const build = rc.jobs?.['build'] ?? {}
    const withoutSeal: Workflow = { jobs: { build: { ...build, steps: (build.steps ?? []).filter((step) => step.name !== SEAL_STEP) } } }
    expect(signingFaults(macConfig, withoutSeal)).toEqual([`${RC} build has no step "${SEAL_STEP}"`])
    // Codesign's identity only: the updater artifacts and their key stay the release overlay's, off on macOS (2.1-Q135).
    expect(macConfig).toEqual({ bundle: { fileAssociations: null, macOS: { signingIdentity: '-' } } })
    const macRows = (build.strategy?.matrix?.include ?? []).filter((row) => String(row['os']).startsWith('macos-'))
    expect(macRows.map((row) => row['updater'])).toEqual([false, false])
    // A change to the Mac config runs the release dry run, whose seal check reads it.
    expect(TABLE.areas.filter((area) => area.patterns.some((pattern) => new RegExp(pattern).test(MAC_CONFIG))).map((area) => area.name))
      .toContain('release-build')
  })

  const sealScript = () => (rc.jobs?.['build']?.steps ?? []).find((step) => step.name === SEAL_STEP)?.run ?? ''
  const APP = 'target/aarch64-apple-darwin/release/bundle/macos/Canopi.app/'
  const seal = (verifyExit: number, verifyMsg: string, dv: string, files: Readonly<Record<string, string>> = { [APP]: '' }) =>
    runStep(sealScript(), files, { TARGET: 'aarch64-apple-darwin', STUB_VERIFY_EXIT: String(verifyExit), STUB_VERIFY_MSG: verifyMsg, STUB_DV_MSG: dv })

  it('canopi-3cu2: a release candidate fails on a linker-signed bundle, the one macOS calls damaged', () => {
    // The probe's reading of 2.0.3's bundle (PR #96).
    const today = seal(1, 'Canopi.app: code has no resources but signature indicates they must be present',
      'Executable=Canopi.app/Contents/MacOS/canopi-desktop\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded\nSignature=adhoc')
    expect(today.status, today.stdout + today.stderr).toBe(1)
    expect(today.stdout).toContain('codesign --verify --deep --strict failed')
    // A linker signature that verifies is still no sealed resources.
    const linker = seal(0, 'Canopi.app: valid on disk', 'CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0')
    expect(linker.status, linker.stdout + linker.stderr).toBe(1)
    expect(linker.stdout).toContain('is linker-signed (adhoc,linker-signed)')
    const unsigned = seal(0, 'valid on disk', 'Canopi.app: code object is not signed at all')
    expect(unsigned.status).toBe(1)
    expect(unsigned.stdout).toContain('is not signed ad hoc (flags: none)')
    const none = seal(0, '', '', {})
    expect(none.status).toBe(1)
    expect(none.stdout).toContain('no .app under target/aarch64-apple-darwin/release/bundle/macos')
    // The signingIdentity '-' bundle's reading passes.
    const sealed = seal(0, 'Canopi.app: valid on disk\nCanopi.app: satisfies its Designated Requirement',
      'CodeDirectory v=20400 size=1 flags=0x10002(adhoc,runtime) hashes=1+3 location=embedded\nSignature=adhoc\nSealed Resources version=2 rules=13 files=40')
    expect(sealed.status, sealed.stdout + sealed.stderr).toBe(0)
    expect(sealed.stdout).toContain('is sealed ad hoc (adhoc,runtime)')
  })
})
