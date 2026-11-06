// The Windows MSI on a push to main (canopi-f47t.52.228.54.2). Since 2026-11-03 main's push build failed at the MSI
// bundle (run 41604466494): WiX refuses 2.1.0-beta.1, "optional pre-release identifier in app version must be
// numeric-only and cannot be greater than 65535 for msi target", and pull requests bundle NSIS only, so none saw it. A
// push packaging a pre-release builds Windows NSIS only, as the beta release does (2.1-M27, M55). These tests run
// build.yml's changes job's packaging step through bash, and they name build.yml and tauri.conf.json, so a pull
// request changing either (a version bump included) runs them.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const BUILD = new URL('../../../../.github/workflows/build.yml', import.meta.url)
const TAURI_CONF = new URL('../../../tauri.conf.json', import.meta.url)

/** The Windows row's bundle arguments build.yml's packaging step gives a push or a pull request packaging `version`. */
function windowsBundles(pr: boolean, version: string): string | undefined {
  const { jobs } = parse(readFileSync(BUILD, 'utf8')) as { jobs: { changes: { steps: { id?: string, run?: string }[] } } }
  const step = jobs.changes.steps.find((candidate) => candidate.id === 'packaging')
  const dir = mkdtempSync(join(tmpdir(), 'canopi-msi-'))
  try {
    const output = join(dir, 'out')
    writeFileSync(output, '')
    mkdirSync(join(dir, 'desktop'))
    writeFileSync(join(dir, 'desktop/tauri.conf.json'), JSON.stringify({ productName: 'Canopi', version }))
    const result = spawnSync('bash', ['-c', step?.run ?? 'exit 9'], {
      encoding: 'utf8', cwd: dir, env: { PATH: process.env.PATH, PR_RUN: String(pr), EVERY_PLATFORM: 'true', GITHUB_OUTPUT: output },
    })
    expect(result.status, result.stderr).toBe(0)
    const matrix = readFileSync(output, 'utf8').split('\n').find((line) => line.startsWith('matrix='))?.slice('matrix='.length)
    return (JSON.parse(matrix ?? '[]') as { os: string, bundle_args: string }[]).find((row) => row.os === 'windows-latest')?.bundle_args
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whether bundle arguments build the MSI: every configured target (no --bundles), or a --bundles list naming msi. */
const buildsMsi = (args: string) => !/--bundles\b/u.test(args) || /--bundles\s+(?:\S+\s+)*?msi\b/u.test(args)

/**
 * Whether WiX takes `version` (tauri-bundler's MSI version rule): major and minor at most 255, patch at most 65535,
 * and a pre-release, if any, a number at most 65535.
 */
function msiTakes(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version)
  if (!match) return false
  const [major, minor, patch, pre] = [Number(match[1]), Number(match[2]), Number(match[3]), match[4]]
  return major <= 255 && minor <= 255 && patch <= 65535 && (pre === undefined || (/^\d+$/u.test(pre) && Number(pre) <= 65535))
}

describe('the Windows MSI on a push (canopi-f47t.52.228.54.2)', () => {
  it('canopi-f47t.52.228.54.2: a push packaging a pre-release builds Windows NSIS only; a release builds the MSI too', () => {
    const beta = windowsBundles(false, '2.1.0-beta.2') ?? ''
    expect(buildsMsi(beta)).toBe(false)
    expect(beta).toMatch(/--bundles nsis(?:\s|$)/u)
    expect(buildsMsi(windowsBundles(false, '2.1.0') ?? '--bundles none')).toBe(true)
    // A pull request builds NSIS only, with zlib, whatever the version.
    expect(windowsBundles(true, '2.1.0')).toBe('--bundles nsis --config .github/tauri-branch-nsis.json')
    expect(windowsBundles(true, '2.1.0-beta.2')).toBe('--bundles nsis --config .github/tauri-branch-nsis.json')
  })

  it('canopi-f47t.52.228.54.2: the version this tree would package on a push reaches the MSI only when WiX takes it', () => {
    const { version } = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as { version: string }
    const windows = windowsBundles(false, version) ?? ''
    expect(!buildsMsi(windows) || msiTakes(version), `a push packaging ${version} bundles Windows with "${windows}"`).toBe(true)
    expect([msiTakes('2.1.0'), msiTakes('2.1.0-7'), msiTakes('2.1.0-beta.1'), msiTakes('256.0.0'), msiTakes('2.1.0-65536')])
      .toEqual([true, true, false, false, false])
  })
})
