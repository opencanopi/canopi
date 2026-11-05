// The desktop packaging both build jobs share (.github/actions/package-desktop; design check AR4; canopi-f47t.52.228.61):
// Build & Test's build job and the Release Candidate's build job package through one composite action, so what the
// release reads (the updater overlay, the signing key, the beta .deb repack, the pinned AppImage tools, the DB the
// preflight verified) lives in one place. Ported from scripts/test_release_smoke_lanes.py's release workflow cases
// (2.1-Q267), with the action's failure states: a DB whose sha256 differs never reaches the build (unreadable), and a
// failed or empty upload fails the job (unwritable).
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { cleanEnv, REPO_ROOT } from './planted-repo.ts'

const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')

interface Step {
  readonly name?: string, readonly uses?: string, readonly if?: string, readonly run?: string
  readonly with?: Readonly<Record<string, string | number | boolean>>, readonly env?: Readonly<Record<string, string>>
  readonly 'continue-on-error'?: unknown
}
interface Job { readonly steps?: readonly Step[], readonly strategy?: { readonly matrix?: { readonly include?: readonly Record<string, unknown>[] } } }
interface Workflow { readonly jobs?: Readonly<Record<string, Job>> }

const ACTION_DIR = '.github/actions/package-desktop'
const ACTION = `${ACTION_DIR}/action.yml`
const FETCH_DB = `${ACTION_DIR}/fetch-db.sh`
const OVERLAY = '.github/tauri-release-updater.json'
const RC = '.github/workflows/release-candidate.yml'
const BUILD = '.github/workflows/build.yml'

const action = parse(read(ACTION)) as { runs: { steps: Step[] } }
const actionSteps = new Map(action.runs.steps.map((step) => [step.name ?? step.uses ?? '', step]))
const flows = new Map(readdirSync(join(REPO_ROOT, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, parse(read(`.github/workflows/${name}`)) as Workflow]))
const jobOf = (file: string, job: string): Job => flows.get(file)?.jobs?.[job] ?? {}
/** The step of `file`'s `job` that runs the package-desktop action. */
const packageStep = (file: string) => (jobOf(file, 'build').steps ?? []).find((step) => step.uses?.endsWith(ACTION_DIR))
const run = (name: string) => actionSteps.get(name)?.run ?? ''

describe('the package-desktop action (design check AR4)', () => {
  it('canopi-f47t.52.228.61: Build & Test and the Release Candidate package through the one action, with no updater, channel or key in Build & Test', () => {
    const build = packageStep('build.yml')
    const release = packageStep('release-candidate.yml')
    expect(build?.uses).toBe(`./${ACTION_DIR}`)
    // A release/2.0 stable fix's tree has no action: the Release Candidate runs main's release tools' copy.
    expect(release?.uses).toBe(`./release-tools/${ACTION_DIR}`)
    expect(Object.keys(build?.with ?? {}).sort()).toEqual(['bundle-args', 'target'])
    // Neither job keeps a packaging step of its own beside the action.
    for (const file of ['build.yml', 'release-candidate.yml']) {
      const names = (jobOf(file, 'build').steps ?? []).map((step) => step.name ?? '')
      for (const moved of ['Download bundled plant DB', 'Pre-seed the AppImage bundler tools', 'Build Tauri app', 'Upload artifacts']) {
        expect(names, `${file} ${moved}`).not.toContain(moved)
      }
    }
    // Both linux-floor jobs install the floor's libraries through one script, retried and bounded like install-linux-deps.
    const floor = read(`${ACTION_DIR}/floor-libs.sh`)
    expect(floor).toMatch(/^apt=\(-o Acquire::Retries=[1-9]\d* -o Acquire::http::Timeout=\d+\)$/m)
    for (const call of [...floor.matchAll(/^(.*apt-get\b.*)$/gm)].map((match) => match[1] ?? '')) expect(call, call).toMatch(/^timeout \d+m apt-get "\$\{apt\[@\]\}" /)
    expect((jobOf('build.yml', 'linux-floor').steps ?? []).map((step) => step.run)).toContain(`${ACTION_DIR}/floor-libs.sh`)
    expect((jobOf('release-candidate.yml', 'linux-floor').steps ?? []).map((step) => step.run)).toContain(`release-tools/${ACTION_DIR}/floor-libs.sh`)
  })

  // Ported from test_release_smoke_lanes.py's test_only_the_build_step_reads_the_updater_signing_key.
  it('2.1-Q230: the updater key reaches the bundler and nothing else, in no workflow', () => {
    const readers: string[] = []
    for (const [file, flow] of flows) {
      for (const [job, body] of Object.entries(flow.jobs ?? {})) {
        for (const step of body.steps ?? []) {
          if (JSON.stringify(step).includes('secrets.TAURI_SIGNING_PRIVATE_KEY')) readers.push(`${file} ${job} ${step.name ?? step.uses}`)
        }
      }
    }
    expect(readers).toEqual(['release-candidate.yml build Package the desktop app'])
    expect(String(packageStep('release-candidate.yml')?.with?.['signing-key-password'])).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
    // Inside the action, only the bundling step reads the key it is passed.
    const keyed = action.runs.steps.filter((step) => JSON.stringify(step).includes('inputs.signing-key')).map((step) => step.name)
    expect(keyed).toEqual(['Build Tauri app'])
  })

  // Ported from test_release_smoke_lanes.py's test_updater_artifacts_come_only_from_the_release_overlay_on_linux_and_windows.
  it('2.1-M242: updater artifacts come only from the release overlay, on Linux and Windows', () => {
    expect(JSON.parse(read(OVERLAY))).toEqual({ bundle: { createUpdaterArtifacts: true } })
    expect(run('Build Tauri app')).toContain('if [ "$UPDATER" = true ]; then overlay="--config .github/tauri-release-updater.json"; fi')
    const named = [ACTION, RC, BUILD].map((path) => read(path).split('tauri-release-updater.json').length - 1)
    expect(named).toEqual([1, 0, 0])
    const rows = jobOf('release-candidate.yml', 'build').strategy?.matrix?.include ?? []
    expect(Object.fromEntries(rows.map((row) => [row['os'], row['updater']])))
      .toEqual({ 'ubuntu-latest': true, 'macos-15': false, 'macos-15-intel': false, 'windows-latest': true })
    expect(String(packageStep('release-candidate.yml')?.with?.['updater'])).toBe("${{ matrix.updater && needs.preflight.outputs.updater == 'true' }}")
  })

  // Ported from test_release_smoke_lanes.py's test_a_beta_builds_windows_as_the_nsis_installer_only.
  it('2.1-M27: a beta builds Windows as the NSIS installer only', () => {
    expect(String(packageStep('release-candidate.yml')?.with?.['bundle-args'])).toContain("needs.preflight.outputs.channel == 'beta' && '--bundles nsis'")
  })

  // Ported from test_release_smoke_lanes.py's test_the_beta_deb_is_repacked_to_sort_below_its_stable_and_signed_again.
  it('2.1-M64: a beta .deb is repacked to sort below its stable and signed again, after the bundler wrote it', () => {
    const build = run('Build Tauri app')
    expect(build).toContain('python3 scripts/release_smoke.py repack-deb "$deb" --version "$RELEASE_VERSION"')
    expect(build).toContain('signer sign --app-version "$RELEASE_VERSION" "$deb"')
    expect(build.indexOf('repack-deb')).toBeGreaterThan(build.indexOf('build; fi'))
    expect(build).toContain('if [ "$UPDATER" = true ] && [ "$CHANNEL" = beta ] && [ "$RUNNER_OS" = Linux ]; then')
  })

  // Ported from test_release_smoke_lanes.py's test_the_bundler_tools_come_from_copies_the_workflow_pins.
  it('2.1-M82: the AppImage bundler tools come from the copies the action pins, before the bundler runs', () => {
    const seed = run('Pre-seed the AppImage bundler tools')
    for (const tool of ['linuxdeploy-x86_64.AppImage', 'AppRun-x86_64', 'linuxdeploy-plugin-appimage.AppImage']) {
      expect(seed, tool).toMatch(new RegExp(`[0-9a-f]{64}  ${tool.replace(/[.]/g, '\\.')}`))
    }
    expect(seed).toContain('sha256sum --check --strict')
    expect(seed).toContain('$HOME/.cache}/tauri')
    // Ubuntu 22.04's gh (2.4) has no --clobber: a build using it fails on the Linux leg.
    expect(seed.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')).not.toContain('--clobber')
    expect(actionSteps.get('Pre-seed the AppImage bundler tools')?.if).toBe("runner.os == 'Linux' && contains(inputs.bundle-args, 'appimage')")
    const names = [...actionSteps.keys()]
    expect(names.indexOf('Pre-seed the AppImage bundler tools')).toBeLessThan(names.indexOf('Build Tauri app'))
  })

  // Ported from test_release_smoke_lanes.py's test_the_macos_dmg_is_still_built_and_published_unsigned.
  it('2.1-Q135: the macOS dmg is still built and uploaded unsigned, with no smoke', () => {
    const upload = actionSteps.get('Upload artifacts')
    expect(String(upload?.with?.['path'])).toContain('target/${{ inputs.target }}/release/bundle/**/*.dmg')
    const smokes = Object.entries(flows.get('release-candidate.yml')?.jobs ?? {}).filter(([job]) => job.startsWith('smoke-'))
    expect(smokes.length).toBe(2)
    expect(smokes.filter(([, job]) => JSON.stringify(job).includes('macos'))).toEqual([])
  })
})

describe('the package-desktop failure states', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  /** fetch-db.sh run in a planted tree whose gh downloads `bytes` and whose python3 names the asset and logs a verify. */
  function fetch(bytes: string, sha256: string) {
    dir = mkdtempSync(join(tmpdir(), 'canopi-fetch-db-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    stub('gh', `while [ $# -gt 0 ]; do case "$1" in --dir) out=$2; shift;; --pattern) name=$2; shift;; esac; shift; done
printf '%s' "$PLANTED_BYTES" > "$out/$name"`)
    stub('python3', `echo "python3 $*" >> "$STUB_LOG"; [ "$2" = value ] && echo canopi-core-planted.db; exit 0`)
    const result = spawnSync('bash', [join(REPO_ROOT, FETCH_DB), 'canopi-core-db', sha256], {
      cwd: dir, encoding: 'utf8',
      env: { ...cleanEnv(), PATH: `${bin}:${process.env['PATH'] ?? ''}`, PLANTED_BYTES: bytes, STUB_LOG: join(dir, 'log'), GITHUB_REPOSITORY: 'o/r' },
    })
    const log = existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : ''
    return { ...result, log, placed: existsSync(join(dir, 'desktop/resources/canopi-core.db')) }
  }

  // A sha256 the planted DB does not have.
  const SHA = '5d0f1f3f0a1b5d2c0dbe6d4c9c09b8f5e6f8f1d2a7d9c4d3f9b4f0e3b5a7c1d2'

  it('unreadable: a DB whose sha256 differs from the preflight\'s fails the step before the contract check, and never reaches the build', () => {
    const wrong = fetch('the prepared db', SHA)
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain(`Bundled DB checksum changed after preflight: expected ${SHA}, found `)
    expect(wrong.log).not.toContain('verify-db')
    expect(wrong.placed).toBe(false)
    // The step runs before the bundling step, and a failed step stops the action: nothing continues on error.
    const names = [...actionSteps.keys()]
    expect(names.indexOf('Download and verify the bundled plant DB')).toBeLessThan(names.indexOf('Build Tauri app'))
    expect(action.runs.steps.filter((step) => step['continue-on-error'] !== undefined)).toEqual([])
  })

  it('unreadable: the DB the preflight read is verified against the contract and bundled; with no sha256 the contract alone decides', () => {
    const sha = spawnSync('node', ['-e', 'process.stdout.write(require("node:crypto").createHash("sha256").update("the prepared db").digest("hex"))'],
      { encoding: 'utf8' }).stdout
    const right = fetch('the prepared db', sha)
    expect([right.status, right.stderr]).toEqual([0, ''])
    expect(right.log).toContain('python3 scripts/species_catalog_contract.py verify-db --profile prepared ')
    expect(right.placed).toBe(true)
    const empty = fetch('', '')
    expect(empty.status).toBe(1)
    expect(empty.stderr).toContain('was not downloaded or is empty')
    expect(empty.placed).toBe(false)
    expect(fetch('any db', '').placed).toBe(true)
  })

  it('unwritable: an upload that fails or finds no package fails the job', () => {
    const upload = actionSteps.get('Upload artifacts')
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@v\d+$/)
    expect(upload?.with?.['if-no-files-found']).toBe('error')
    expect(upload?.['continue-on-error']).toBeUndefined()
    expect(upload?.if).toBeUndefined()
    // Neither job lets the action's failure pass.
    for (const file of ['build.yml', 'release-candidate.yml']) expect(packageStep(file)?.['continue-on-error'], file).toBeUndefined()
  })
})
