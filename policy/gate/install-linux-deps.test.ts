// The shared Linux install (.github/actions/install-linux-deps) when the runner's Ubuntu mirror crawls
// (canopi-f47t.52.228.54): on 2026-11-05 and 2026-11-06 the real-app job's install hit its 20-minute bound (exit 124,
// runs 42046263045 and 42132961259) on azure.archive.ubuntu.com delivering 14.6 kB/s, too slow to trip apt's own
// inactivity timeout, and a rerun went green. The packages are downloaded first under a short bound; a mirror that
// misses it is left for a second one, and only then does dpkg install, so a slow mirror costs minutes, not a red run.
// Each case runs the action's own step through bash with apt-get, sudo and timeout faked on PATH.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { cleanEnv, REPO_ROOT } from './planted-repo.ts'

const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml
const ACTION = '.github/actions/install-linux-deps/action.yml'
const action = parse(readFileSync(join(REPO_ROOT, ACTION), 'utf8')) as {
  inputs?: Record<string, unknown>, runs: { steps: { name?: string, run?: string, env?: Record<string, string> }[] }
}
const step = action.runs.steps.find((candidate) => candidate.run?.includes('apt-get'))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A runner whose apt configuration holds `sources` (`@ETC@` in its text is the planted configuration directory) and
 * any `planted` files beside it; apt-get stalls (exit 124, as `timeout` reports it) on each `stalled` host. A
 * `mirror+file:` source is read as apt reads it on a slow mirror: from the list's first mirror, since apt moves down
 * the list on an error, never on slowness.
 */
function runner(sources: { file: string, text: string }, stalled: string[], packages = '', planted: { file: string, text: string }[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'canopi-apt-'))
  dirs.push(dir)
  const etc = join(dir, 'etc-apt')
  const bin = join(dir, 'bin')
  const log = join(dir, 'apt.log')
  mkdirSync(join(etc, 'sources.list.d'), { recursive: true })
  mkdirSync(bin)
  for (const { file, text } of [sources, ...planted]) writeFileSync(join(etc, file), text.replaceAll('@ETC@', etc))
  writeFileSync(log, '')
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  fake('sudo', 'exec "$@"')
  // The bound is recorded and the command run: a stall is the fake apt-get's to report.
  fake('timeout', `echo "bound $1" >> "${log}"; shift; exec "$@"`)
  fake('dpkg', `echo "dpkg $*" >> "${log}"`)
  fake('apt-get', [
    `host=$(grep -hoE '(mirror\\+file:[^ ]+|https?://[^/ ]+)' "${etc}"/sources.list "${etc}"/sources.list.d/* 2>/dev/null | head -n 1)`,
    'if [[ "$host" == mirror+file:* ]]; then host=$(grep -hoE \'https?://[^/ ]+\' "${host#mirror+file:}" | head -n 1); fi',
    'args="$*"',
    `echo "apt-get \${args//-o Acquire::Retries=5 -o Acquire::http::Timeout=60 /} on $host" >> "${log}"`,
    `for stall in ${stalled.join(' ')}; do`,
    '  if [[ "$host" == *"://$stall" && "$args" == *--download-only* ]]; then exit 124; fi',
    'done',
  ].join('\n'))
  const result = spawnSync('bash', ['-c', step?.run ?? 'exit 9'], {
    encoding: 'utf8',
    env: { ...cleanEnv(), ...step?.env, CANOPI_APT_PACKAGES: packages, CANOPI_APT_ETC: etc, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  })
  return { result, log: readFileSync(log, 'utf8').trim().split('\n'), sources: () => readFileSync(join(etc, sources.file), 'utf8') }
}

const AZURE = { file: 'sources.list.d/ubuntu.sources', text: 'Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports noble-security\nComponents: main universe restricted multiverse\n' }
const ARCHIVE = { file: 'sources.list', text: 'deb http://archive.ubuntu.com/ubuntu/ jammy main universe\ndeb http://security.ubuntu.com/ubuntu/ jammy-security main universe\n' }
// The hosted ubuntu-latest image: its sources name a mirror list, azure's mirror first (run 42140336093 logs
// `Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist`, then `Hit:2 http://azure.archive.ubuntu.com/ubuntu noble InRelease`).
const MIRROR_LIST = { file: 'sources.list.d/ubuntu.sources', text: 'Types: deb\nURIs: mirror+file:@ETC@/apt-mirrors.txt\nSuites: noble noble-updates noble-backports noble-security\nComponents: main universe restricted multiverse\n' }
const MIRRORS = { file: 'apt-mirrors.txt', text: 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n' }
const PACKAGES = 'pkg-config libcairo2-dev libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev patchelf'

describe('the shared Linux install on a slow mirror (canopi-f47t.52.228.54)', () => {
  it('canopi-f47t.52.228.54: a healthy mirror downloads once under the short bound, then installs', () => {
    const { result, log } = runner(AZURE, [])
    expect(result.status, result.stderr).toBe(0)
    expect(log).toEqual([
      'bound 3m', 'apt-get update on http://azure.archive.ubuntu.com',
      'bound 5m', `apt-get install --download-only -y ${PACKAGES} on http://azure.archive.ubuntu.com`,
      'bound 10m', `apt-get install -y ${PACKAGES} on http://azure.archive.ubuntu.com`,
    ])
    expect(result.stdout).not.toContain('::warning::')
  })

  it('busy: a runner mirror that misses the download bound is left for the Ubuntu archive, with a warning', () => {
    const { result, log, sources } = runner(AZURE, ['azure.archive.ubuntu.com'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('::warning::http://azure.archive.ubuntu.com did not deliver the packages within its bound; downloading them from http://archive.ubuntu.com/ubuntu/')
    expect(sources()).toContain('URIs: http://archive.ubuntu.com/ubuntu/\n')
    expect(log.slice(4)).toEqual([
      'dpkg --configure -a',
      'bound 5m', 'apt-get update on http://archive.ubuntu.com',
      'bound 12m', `apt-get install --download-only -y ${PACKAGES} on http://archive.ubuntu.com`,
      'bound 10m', `apt-get install -y ${PACKAGES} on http://archive.ubuntu.com`,
    ])
  })

  it('busy: a hosted runner\'s mirror list whose first mirror misses the bound is left for the Ubuntu archive', () => {
    const { result, log, sources } = runner(MIRROR_LIST, ['azure.archive.ubuntu.com'], '', [MIRRORS])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('::warning::http://azure.archive.ubuntu.com did not deliver the packages within its bound; downloading them from http://archive.ubuntu.com/ubuntu/')
    expect(sources()).toContain('URIs: http://archive.ubuntu.com/ubuntu/\n')
    expect(log.slice(0, 4)).toEqual([
      'bound 3m', 'apt-get update on http://azure.archive.ubuntu.com',
      'bound 5m', `apt-get install --download-only -y ${PACKAGES} on http://azure.archive.ubuntu.com`,
    ])
    expect(log.slice(4)).toEqual([
      'dpkg --configure -a',
      'bound 5m', 'apt-get update on http://archive.ubuntu.com',
      'bound 12m', `apt-get install --download-only -y ${PACKAGES} on http://archive.ubuntu.com`,
      'bound 10m', `apt-get install -y ${PACKAGES} on http://archive.ubuntu.com`,
    ])
  })

  it('busy: sources already on the archive fall back to kernel.org\'s mirror, the security line untouched', () => {
    const { result, sources } = runner(ARCHIVE, ['archive.ubuntu.com'])
    expect(result.status, result.stderr).toBe(0)
    expect(sources()).toBe('deb http://mirrors.edge.kernel.org/ubuntu/ jammy main universe\ndeb http://security.ubuntu.com/ubuntu/ jammy-security main universe\n')
  })

  it('busy: when the second mirror stalls too, the step fails naming both, and dpkg installs nothing', () => {
    const { result, log } = runner(AZURE, ['azure.archive.ubuntu.com', 'archive.ubuntu.com'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::neither http://azure.archive.ubuntu.com nor http://archive.ubuntu.com/ubuntu/ delivered the packages within their bounds')
    expect(log.filter((line) => line.startsWith('apt-get install -y'))).toEqual([])
  })

  it('a caller\'s extra packages join the one bounded download and install', () => {
    const { result, log } = runner(AZURE, [], 'webkit2gtk-driver xvfb file')
    expect(result.status, result.stderr).toBe(0)
    expect(log.at(-1)).toBe(`apt-get install -y ${PACKAGES} webkit2gtk-driver xvfb file on http://azure.archive.ubuntu.com`)
    expect(Object.keys(action.inputs ?? {})).toEqual(['packages'])
  })
})
