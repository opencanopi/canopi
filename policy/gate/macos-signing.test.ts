// The Mac bundle's ad-hoc seal (canopi-3cu2; design check U-7; 2.1-M472, Q305: never a Developer ID). The signing
// probe (macos-signing-probe.yml, PR #96 on macOS 15 arm64 with Gatekeeper on) read today's linker-signed bundle as
// "damaged" with no Open Anyway, and the signingIdentity '-' bundle as "could not verify" with Open Anyway; so
// desktop/tauri.macos.conf.json signs ad hoc, the Release Candidate's Mac build fails unless its .app is sealed ad hoc
// with its resources, the probe keeps comparing against 2.0.3's unsigned bundle, and the install text users read is
// the probe's for the shipped decision. Each failure state is planted here: a linker-signed candidate that would pass,
// a probe whose unsigned row silently turns ad hoc, and install text naming a step the shipped bundle never shows. The
// workflow steps run for real in bash, with codesign stubbed and the probe's rows planted.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const PROBE = '.github/workflows/macos-signing-probe.yml'
const INSTALL_DOCS = ['README.md', 'docs/release-notes/v2.1.0.md']
const SEAL_STEP = 'The Mac app is sealed ad hoc with its resources'
const PACKAGE_STEP = 'Package the desktop app'
const VERDICT_STEP = 'Read the verdict'

const macConfig = JSON.parse(read(MAC_CONFIG)) as MacConfig
const rc = parse(read(RC)) as Workflow
const probe = parse(read(PROBE)) as Workflow

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

const probeRun = (name: string) => (probe.jobs?.['verdict']?.steps ?? []).find((step) => step.name === name)?.run ?? ''
/** One of the probe's install texts, by its variable in the verdict step: the SIGNING-INSTALL-TEXT it prints. */
function probeText(variable: 'open_anyway_steps' | 'xattr_steps'): string {
  const text = new RegExp(`^\\s*${variable}='([^']+)'$`, 'm').exec(probeRun(VERDICT_STEP))?.[1]
  if (text === undefined) throw new Error(`${PROBE} sets no ${variable}`)
  return text
}
/** A user's reading of Markdown: no code or bold marks, the house menu arrow as the probe's '>', one space, any case. */
const prose = (text: string) => text.replace(/\*\*|`/g, '').replace(/›/g, '>').replace(/\s+/g, ' ').toLowerCase()

/** Why a document's Mac install text names a step the shipped bundle does not show, empty when it is the probe's. */
function installFaults(identity: unknown, docs: ReadonlyMap<string, string>): string[] {
  const adhoc = identity === '-'
  const wanted = prose(probeText(adhoc ? 'open_anyway_steps' : 'xattr_steps'))
  const faults: string[] = []
  for (const [file, text] of docs) {
    const said = prose(text)
    if (!said.includes(wanted)) faults.push(`${file} lacks the probe's install text for the ${adhoc ? 'ad-hoc' : 'unsigned'} bundle`)
    // The unsigned bundle's dialog says damaged and offers no Open Anyway (the probe, PR #96).
    if (!adhoc && said.includes('open anyway')) faults.push(`${file} names Open Anyway, which macOS shows only for an ad-hoc sealed bundle`)
    // The ad-hoc bundle's first dialog is "could not verify": damaged is only the fallback.
    if (adhoc && said.includes('macos then says canopi is damaged')) faults.push(`${file} says macOS calls Canopi damaged, which the ad-hoc bundle's first open does not`)
  }
  return faults
}

/** Why the ad-hoc install text matches only macOS 15's dialog, empty when macOS 12 to 14 users find their step in it.
 * The probe ran on macOS 15 alone ("could not verify", Done); macOS 12 to 14 say Apple cannot check it for malicious
 * software or cannot verify the developer, offer Cancel or OK, and macOS 12 names the settings app differently. */
function openAnywayFaults(text: string): string[] {
  const said = prose(text)
  return [
    ...(said.includes('check it for malware') ? [] : ['the install text never names the dialog of macOS 12 to 14 (cannot check it for malware)']),
    ...(said.includes('cancel') ? [] : ['the install text never names the Cancel button of macOS 12 to 14']),
    ...(said.includes('system preferences > security & privacy') ? [] : ['the install text never names macOS 12\'s System Preferences > Security & Privacy']),
  ]
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

  /** The probe's two rows as PR #96 read them, with `signatures` as each row's codesign -dvvv reading. */
  function probeRows(signatures: { readonly unsigned: string, readonly adhoc: string }): Record<string, string> {
    const row = (variant: 'unsigned' | 'adhoc', fields: Readonly<Record<string, string>>) =>
      Object.entries({ variant, macos: '15.8.2 arm64', gatekeeper: 'assessments enabled', quarantine: 'propagated', signature_msg: signatures[variant],
        launched_quarantined: 'yes', launched_after_xattr: 'yes', ...fields }).map(([key, value]) => `${key}=${value}\n`).join('')
    return {
      'signing-results/unsigned.env': row('unsigned', { codesign_exit: '1', codesign_msg: 'APP: code has no resources but signature indicates they must be present',
        spctl_exit: '3', spctl_msg: 'APP: code has no resources but signature indicates they must be present', syspolicy_exit: '1', syspolicy_msg: 'Error: Notary Ticket Missing; damaged',
        dialog: '“Canopi” is damaged and can’t be opened. You should move it to the Trash.' }),
      'signing-results/adhoc.env': row('adhoc', { codesign_exit: '0', codesign_msg: 'APP: valid on disk', spctl_exit: '3', spctl_msg: 'APP: rejected',
        syspolicy_exit: '1', syspolicy_msg: 'Error: Notary Ticket Missing', dialog: '“Canopi” Not Opened Apple could not verify “Canopi” is free of malware' }),
    }
  }
  const LINKER = 'Executable=APP/Contents/MacOS/canopi-desktop CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 Signature=adhoc'
  const SEALED = 'Executable=APP/Contents/MacOS/canopi-desktop CodeDirectory v=20400 size=1 flags=0x10002(adhoc,runtime) hashes=1+3 Signature=adhoc Sealed Resources version=2'

  it('canopi-3cu2: the probe\'s unsigned row builds 2.0.3\'s linker-signed bundle, so the verdict never compares the shipped bundle with itself', () => {
    const rows = probe.jobs?.['probe']?.strategy?.matrix?.include ?? []
    const args = (variant: string) => String(rows.find((row) => row['variant'] === variant)?.['bundle_args'] ?? '')
    // The unsigned row overrides the shipped identity away, in one word (the action splits bundle-args on whitespace).
    expect(args('unsigned')).not.toMatch(/\s.*\s/)
    expect(JSON.parse(args('unsigned').replace(/^--config /, ''))).toEqual({ bundle: { macOS: { signingIdentity: null } } })
    // The ad-hoc row builds what ships.
    expect(args('adhoc')).toBe('')
    const verdict = (signatures: { readonly unsigned: string, readonly adhoc: string }) =>
      runStep(probeRun(VERDICT_STEP), probeRows(signatures), { RESULTS: 'signing-results' })
    const found = verdict({ unsigned: LINKER, adhoc: SEALED })
    expect(found.status, found.stdout + found.stderr).toBe(0)
    expect(found.stdout).toContain('classifier self-test passed')
    expect(found.stdout).toContain("SIGNING-VERDICT: improved: ship signingIdentity '-' and the Release Candidate verify check")
    expect(found.stdout).toContain(`SIGNING-INSTALL-TEXT: ${probeText('open_anyway_steps')}`)
    // Planted: the unsigned row silently sealed ad hoc, then the ad-hoc row silently linker-signed.
    const same = verdict({ unsigned: SEALED, adhoc: SEALED })
    expect(same.status).toBe(1)
    expect(same.stdout).toContain("::error::the unsigned row is not 2.0.3's linker-signed bundle (adhoc)")
    const lost = verdict({ unsigned: LINKER, adhoc: LINKER })
    expect(lost.status).toBe(1)
    expect(lost.stdout).toContain('::error::the adhoc row is not sealed ad hoc (linker-signed)')
  })

  it('canopi-3cu2: the Mac install text everywhere a user reads it is the probe\'s for the shipped bundle', () => {
    const docs = new Map(INSTALL_DOCS.map((file) => [file, read(file)]))
    expect(installFaults(macConfig.bundle?.macOS?.signingIdentity, docs)).toEqual([])
    // Planted: the same text over an unsigned bundle names Open Anyway, which its damaged dialog never shows.
    expect(installFaults(undefined, new Map([['README.md', read('README.md')]]))).toEqual([
      "README.md lacks the probe's install text for the unsigned bundle",
      'README.md names Open Anyway, which macOS shows only for an ad-hoc sealed bundle'])
    // Planted: 2.0.3's text over the ad-hoc bundle.
    const old = 'macOS: open the dmg and drag Canopi to Applications; macOS then says Canopi is damaged, which it is not.'
    expect(installFaults('-', new Map([['README.md', old]]))).toEqual([
      "README.md lacks the probe's install text for the ad-hoc bundle",
      "README.md says macOS calls Canopi damaged, which the ad-hoc bundle's first open does not"])
  })

  it('canopi-3cu2: the ad-hoc install text names a step on every macOS the install line supports, 12 to 15', () => {
    expect(openAnywayFaults(probeText('open_anyway_steps'))).toEqual([])
    // Planted: the macOS 15-only text the probe first printed.
    expect(openAnywayFaults('If macOS says it could not verify Canopi, click Done, open System Settings > Privacy & Security, click Open Anyway beside Canopi and confirm.'))
      .toEqual([
        'the install text never names the dialog of macOS 12 to 14 (cannot check it for malware)',
        'the install text never names the Cancel button of macOS 12 to 14',
        'the install text never names macOS 12\'s System Preferences > Security & Privacy'])
  })

  // promote-release.sh builds the release page from docs/release-notes/v<version>.md and writes a bare header when it is
  // missing; the version files name the next release once its release commit bumps them, and until then they name
  // 2.1.0-beta.2, published with the linker-signed bundle and its xattr text.
  it.fails('canopi-3cu2: the release notes of the version the tree would release carry the probe\'s install text (expected to fail until the reader release\'s version bump and notes land: main agent, canopi-3cu2)', () => {
    const version = (JSON.parse(read('desktop/tauri.conf.json')) as { readonly version: string }).version
    const notes = `docs/release-notes/v${version}.md`
    expect(existsSync(join(REPO_ROOT, notes)), `${notes} is missing, so the release page carries no install text`).toBe(true)
    expect(installFaults(macConfig.bundle?.macOS?.signingIdentity, new Map([[notes, read(notes)]]))).toEqual([])
  })
})
