// The oldest engine's parse check (design check A15; 2.1-Q267): the real CLI in a planted repository, docker recorded by
// the PATH shim, which stands in for the container (its output is what the shim prints).
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OLDEST_ENGINE_IMAGE, PLANTED_CHUNK } from './oldest-engine.ts'
import { PlantedRepo } from './planted-repo.ts'

let repo: PlantedRepo
beforeEach(() => {
  repo = new PlantedRepo()
  repo.write({ 'desktop/web/dist/assets/index.js': 'export const a = 1\n', 'desktop/web/dist-web/assets/web.mjs': 'export {}\n',
    'desktop/web/dist-web/index.html': '<!doctype html>\n' })
})
afterEach(() => repo.cleanup())

/** The docker shim prints `output` for `docker run` (the container's report) and records every call. */
function container(output: string): void {
  writeFileSync(join(repo.root, 'container.out'), output)
  writeFileSync(join(repo.bin, 'docker'), `#!/bin/sh\necho "docker $*" >> "$SHIM_LOG"\n`
    + `case "$1 $2" in "image inspect") [ -n "$SHIM_NO_IMAGE" ] && exit 1; exit 0 ;; "pull "*) echo "no such host" >&2; exit 1 ;; esac\n`
    + `cat '${join(repo.root, 'container.out')}'\n`)
  chmodSync(join(repo.bin, 'docker'), 0o755)
}

describe('the oldest-engine check (A15)', () => {
  it('canopi-f47t.52.228.54: every chunk of both builds is parsed by Debian 12\'s engine in the pinned image, the planted one refused', () => {
    container(`engine: WebKitGTK 2.50.6\nFAIL /check/${PLANTED_CHUNK}: Unexpected identifier 'held' (line 1)\nchecked 3\n`)
    const run = repo.gate(['oldest-engine'])
    expect(run.status, run.stderr).toBe(0)
    const docker = repo.calls().find((call) => call.startsWith('docker run ')) ?? ''
    expect(docker).toContain(`${OLDEST_ENGINE_IMAGE} sh -c`)
    expect(docker).toContain('gir1.2-javascriptcoregtk-4.1')
    expect(run.stderr).toContain('oldest engine: 2 chunks in')
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
    expect(run.stderr).toContain(`the oldest engine accepted the planted chunk ${PLANTED_CHUNK}: the check parsed nothing`)
  })

  it('canopi-f47t.52.228.54: missing: a missing container image that cannot be pulled fails naming its digest', () => {
    container('')
    const run = repo.gate(['oldest-engine'], { env: { SHIM_NO_IMAGE: '1' } })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`the oldest-engine image ${OLDEST_ENGINE_IMAGE} is missing and could not be pulled`)
    expect(repo.calls().filter((call) => call.startsWith('docker run '))).toEqual([])
  })

  it('canopi-f47t.52.228.54: missing: with no builds the check fails naming the builds to run', () => {
    repo.reset()
    container('')
    const run = repo.gate(['oldest-engine'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('run npm run build and npm run build:web in desktop/web first')
  })
})
