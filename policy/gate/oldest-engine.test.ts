// The oldest engines' parse check (design check A15; 2.1-Q267, 2.1-M490): the real CLI in a planted repository, docker
// recorded by the PATH shim, which stands in for both containers (each prints what the shim's file for its image holds).
// The real containers run in the gate itself (`node policy/gate/cli.mjs oldest-engine`, the Frontend row).
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGINE_FLOOR } from '../../desktop/web/engine-floor.ts'
import { FLOOR_ENGINE_IMAGE, FLOOR_ENGINE_PLAYWRIGHT, FLOOR_PLANTED_CHUNK, OLDEST_ENGINE_IMAGE, PLANTED_CHUNK } from './oldest-engine.ts'
import { PlantedRepo, REPO_ROOT } from './planted-repo.ts'

/** The floor the check reads (desktop/web/engine-floor.ts, which the planted copy of the gate imports). */
const FLOOR_SOURCE = { 'desktop/web/engine-floor.ts': readFileSync(join(REPO_ROOT, 'desktop/web/engine-floor.ts'), 'utf8') }

let repo: PlantedRepo
beforeEach(() => {
  repo = new PlantedRepo()
  repo.write({ ...FLOOR_SOURCE, 'desktop/web/dist/assets/index.js': 'export const a = 1\n', 'desktop/web/dist-web/assets/web.mjs': 'export {}\n',
    'desktop/web/dist-web/index.html': '<!doctype html>\n' })
})
// A test that plants no repository leaves none to clean up, in any order the seed shuffles (canopi-f47t.52.228.54).
afterEach(() => {
  repo?.cleanup()
  repo = undefined as never
})

/** What a healthy Debian 12 run prints: its engine, the planted chunk refused, every file checked. */
const DEBIAN_OK = `engine: WebKitGTK 2.50.6\nFAIL /check/${PLANTED_CHUNK}: Unexpected identifier 'held' (line 1)\nchecked 3\n`
/** What a healthy floor run prints. */
const FLOOR_OK = `engine: WebKit ${ENGINE_FLOOR.safari}\nFAIL /check/${FLOOR_PLANTED_CHUNK}: SyntaxError: Invalid regular expression: invalid flags\nchecked 3\n`

/** The docker shim prints `debian` for a `docker run` of the Debian 12 image, `floor` for the floor's, and records every call. */
function container(debian: string, floor: string = FLOOR_OK): void {
  writeFileSync(join(repo.root, 'debian.out'), debian)
  writeFileSync(join(repo.root, 'floor.out'), floor)
  writeFileSync(join(repo.bin, 'docker'), `#!/bin/sh\necho "docker $*" >> "$SHIM_LOG"\n`
    + `case "$1 $2" in "image inspect") [ -n "$SHIM_NO_IMAGE" ] && exit 1; exit 0 ;; "pull "*) echo "no such host" >&2; exit 1 ;; esac\n`
    + `case "$*" in *${OLDEST_ENGINE_IMAGE}*) cat '${join(repo.root, 'debian.out')}' ;; *) cat '${join(repo.root, 'floor.out')}' ;; esac\n`)
  chmodSync(join(repo.bin, 'docker'), 0o755)
}

const runs = () => repo.calls().filter((call) => call.startsWith('docker run '))

describe('the oldest-engine check (A15)', () => {
  it('canopi-f47t.52.228.54: every chunk of both builds is parsed by Debian 12\'s engine in the pinned image, the planted one refused', () => {
    container(DEBIAN_OK)
    const run = repo.gate(['oldest-engine'])
    expect(run.status, run.stderr).toBe(0)
    const docker = runs().find((call) => call.includes(OLDEST_ENGINE_IMAGE)) ?? ''
    expect(docker).toContain(`${OLDEST_ENGINE_IMAGE} sh -c`)
    expect(docker).toContain('gir1.2-javascriptcoregtk-4.1')
    expect(run.stderr).toContain('oldest engine (Debian 12): 2 chunks in')
    expect(run.stderr).toContain('engine: WebKitGTK 2.50.6')
  })

  it('canopi-f47t.52.228.54: a chunk the oldest engine cannot parse fails naming it', () => {
    container(`FAIL /work/desktop/web/dist/assets/index.js: Unexpected token '.' (line 1)\nFAIL /check/${PLANTED_CHUNK}: x\n`)
    const run = repo.gate(['oldest-engine'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("gate: FAIL desktop/web/dist/assets/index.js: Unexpected token '.' (line 1)")
  })

  it('canopi-f47t.52.228.54: an engine that accepts the planted chunk fails, never a green that parsed nothing', () => {
    container('checked 3\n')
    const run = repo.gate(['oldest-engine'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`the oldest engine (Debian 12) accepted the planted chunk ${PLANTED_CHUNK}: the check parsed nothing`)
  })

  it('canopi-f47t.52.228.54: missing: a missing container image that cannot be pulled fails naming its digest', () => {
    container('')
    const run = repo.gate(['oldest-engine'], { env: { SHIM_NO_IMAGE: '1' } })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`the oldest-engine image ${OLDEST_ENGINE_IMAGE} is missing and could not be pulled`)
    expect(runs()).toEqual([])
  })

  it('canopi-f47t.52.228.54: missing: with no builds the check fails naming the builds to run', () => {
    repo.reset()
    repo.write(FLOOR_SOURCE)
    container('')
    const run = repo.gate(['oldest-engine'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('run npm run build and npm run build:web in desktop/web first')
  })
})

describe('the engine floor\'s WebKit (canopi-4kfl)', () => {
  it('U canopi-4kfl: every chunk of both builds is parsed by the floor\'s WebKit in its pinned image, driven by its own Playwright', () => {
    container(DEBIAN_OK)
    const run = repo.gate(['oldest-engine'])
    expect(run.status, run.stderr).toBe(0)
    const docker = runs().find((call) => call.includes(FLOOR_ENGINE_IMAGE)) ?? ''
    expect(docker).toContain(`${FLOOR_ENGINE_IMAGE} sh -c`)
    expect(docker).toContain(`playwright-core@${FLOOR_ENGINE_PLAYWRIGHT}`)
    expect(run.stderr).toContain(`engine floor (Safari ${ENGINE_FLOOR.safari}): 2 chunks in ${FLOOR_ENGINE_IMAGE}`)
    expect(run.stderr).toContain(`engine floor (Safari ${ENGINE_FLOOR.safari}): every chunk parses`)
  })

  it('U canopi-4kfl: planted too-new chunk passes the engine check: a floor engine that accepts it fails, never a green that parsed nothing', () => {
    container(DEBIAN_OK, `engine: WebKit ${ENGINE_FLOOR.safari}\nchecked 3\n`)
    const run = repo.gate(['oldest-engine'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`the engine floor (Safari ${ENGINE_FLOOR.safari}) accepted the planted chunk ${FLOOR_PLANTED_CHUNK}: the check parsed nothing`)
  })

  it('U canopi-4kfl: a chunk too new for the floor fails naming it, and the Debian 12 run still reports', () => {
    container(DEBIAN_OK, `engine: WebKit ${ENGINE_FLOOR.safari}\nFAIL /work/desktop/web/dist-web/assets/web.mjs: SyntaxError: Invalid regular expression: invalid flags\n`
      + `FAIL /check/${FLOOR_PLANTED_CHUNK}: SyntaxError: x\nchecked 3\n`)
    const run = repo.gate(['oldest-engine'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('gate: FAIL desktop/web/dist-web/assets/web.mjs: SyntaxError: Invalid regular expression: invalid flags')
    expect(run.stderr).toContain('oldest engine (Debian 12): every chunk parses')
  })

  it('U canopi-4kfl: an image whose WebKit is not ENGINE_FLOOR\'s Safari fails, so a raised floor re-pins the image', () => {
    container(DEBIAN_OK, `engine: WebKit 16.0\nFAIL /check/${FLOOR_PLANTED_CHUNK}: SyntaxError: x\nchecked 3\n`)
    const run = repo.gate(['oldest-engine'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`runs engine: WebKit 16.0, not WebKit ${ENGINE_FLOOR.safari}: pin the image whose WebKit is ENGINE_FLOOR's Safari`)
  })

  it('U canopi-4kfl: a floor container that stops fails naming the engine', () => {
    container(DEBIAN_OK)
    writeFileSync(join(repo.bin, 'docker'), `#!/bin/sh\necho "docker $*" >> "$SHIM_LOG"\n`
      + `case "$1 $2" in "image inspect") exit 0 ;; esac\n`
      + `case "$*" in *${OLDEST_ENGINE_IMAGE}*) cat '${join(repo.root, 'debian.out')}' ;; *) echo 'the floor engine stopped: Target closed' >&2; exit 1 ;; esac\n`)
    chmodSync(join(repo.bin, 'docker'), 0o755)
    const run = repo.gate(['oldest-engine'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`FAIL the engine floor (Safari ${ENGINE_FLOOR.safari}) container did not run (exit 1): the floor engine stopped: Target closed`)
  })
})
