// The gate's entry (2.1-Q267; design check A9, AR24): a Node below the engines major runs it again on nvm's install of
// that major or refuses in one line before any other module loads, the command line takes only its modes, and no
// policy module imports it (2.1-M348).
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { engineRefusal } from './engines.mjs'
import { ENTRY, PlantedRepo, REPO_ROOT } from './planted-repo.ts'

let repo: PlantedRepo
beforeEach(() => { repo = new PlantedRepo() })
afterEach(() => repo.cleanup())

const engines = (node: string | undefined) => {
  const file = join(repo.repo, 'desktop/web/package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { engines?: { node?: string } }
  writeFileSync(file, JSON.stringify({ ...manifest, engines: node === undefined ? undefined : { node } }))
}

describe('the engines Node (design check A9)', () => {
  it('wrong Node: a Node below the engines major refuses in one line, in every mode', () => {
    engines('>=99')
    for (const args of [['areas', '--base', repo.base], ['full', '--print'], ['agents-rows', '--check'], ['nonsense']]) {
      const run = repo.gate(args, { env: { NVM_DIR: join(repo.root, 'no-nvm') } })
      expect([run.status, run.stdout], args.join(' ')).toEqual([1, ''])
      expect(run.stderr).toBe(`gate: Node 99 is required (engines); found ${process.version}: run nvm install 99\n`)
    }
  })

  it("canopi-f47t.52.228.54: an older Node runs the gate again on nvm's newest install of the engines major, once", () => {
    engines('>=99')
    const nvm = join(repo.root, 'nvm')
    for (const version of ['v98.0.0', 'v99.9.0', 'v99.10.0']) {
      mkdirSync(join(nvm, 'versions/node', version, 'bin'), { recursive: true })
      writeFileSync(join(nvm, 'versions/node', version, 'bin/node'),
        `#!/bin/sh\necho "${version} $* PATH=$PATH"\nexit 7\n`, { mode: 0o755 })
    }
    const newest = join(nvm, 'versions/node/v99.10.0/bin')
    const run = repo.gate(['full', '--print'], { env: { NVM_DIR: nvm } })
    expect(run.status).toBe(7)
    const ran = `v99.10.0 ${join(repo.repo, ENTRY)} full --print PATH=${newest}${delimiter}`
    expect(run.stdout.slice(0, ran.length)).toBe(ran)
    // Already running nvm's install and still older: it refuses rather than running itself again.
    rmSync(join(newest, 'node'))
    symlinkSync(process.execPath, join(newest, 'node'))
    const again = repo.gate(['full', '--print'], { env: { NVM_DIR: nvm } })
    expect([again.status, again.stdout]).toEqual([1, ''])
    expect(again.stderr).toBe(`gate: Node 99 is required (engines); found ${process.version}: run nvm install 99\n`)
  })

  it("canopi-f47t.52.228.54: wrong Node: a Node that cannot load TypeScript still refuses in one line or runs the gate again", () => {
    // Node 20, and 22 before 22.18, cannot strip types: the entry is plain JavaScript, so they reach the engines check.
    engines('>=99')
    const stripless = ['--no-experimental-strip-types']
    const refused = repo.gate(['full', '--print'], { node: stripless, env: { NVM_DIR: join(repo.root, 'no-nvm') } })
    expect([refused.status, refused.stdout, refused.stderr])
      .toEqual([1, '', `gate: Node 99 is required (engines); found ${process.version}: run nvm install 99\n`])
    const bin = join(repo.root, 'nvm/versions/node/v99.0.0/bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "v99.0.0 $*"\n', { mode: 0o755 })
    const again = repo.gate(['full', '--print'], { node: stripless, env: { NVM_DIR: join(repo.root, 'nvm') } })
    expect([again.status, again.stdout]).toEqual([0, `v99.0.0 ${join(repo.repo, ENTRY)} full --print\n`])
  })

  it("canopi-f47t.52.228.54: when nvm's engines Node cannot run the gate again, it refuses in one line", () => {
    engines('>=99')
    const nvm = join(repo.root, 'nvm')
    const bin = join(nvm, 'versions/node/v99.0.0/bin')
    mkdirSync(bin, { recursive: true })
    const node = join(bin, 'node')
    const refusal = `gate: Node 99 is required (engines); found ${process.version}: run nvm install 99; ${node}`
    writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    const unrunnable = repo.gate(['full', '--print'], { env: { NVM_DIR: nvm } })
    expect([unrunnable.status, unrunnable.stdout, unrunnable.stderr]).toEqual([1, '', `${refusal} failed to run (EACCES)\n`])
    writeFileSync(node, '#!/bin/sh\nkill -TERM $$\n')
    chmodSync(node, 0o755)
    const killed = repo.gate(['full', '--print'], { env: { NVM_DIR: nvm } })
    expect([killed.status, killed.stdout, killed.stderr]).toEqual([1, '', `${refusal} was stopped by SIGTERM\n`])
  })

  it("canopi-f47t.52.228.54: cancelled: SIGINT to an older Node reaches the gate it runs again on nvm's engines Node", async () => {
    // A hook or test that interrupts the process it started (not the whole group, as a terminal's Ctrl-C does) must
    // stop the engines Node's run too, never orphan it, and exit as that run did.
    engines('>=99')
    const bin = join(repo.root, 'nvm/versions/node/v99.0.0/bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node'), [
      '#!/bin/sh', "trap 'echo interrupted >&2; exit 130' INT", 'echo running >&2',
      'i=0; while [ $i -lt 100 ]; do sleep 0.05; i=$((i + 1)); done', 'echo finished >&2', '',
    ].join('\n'), { mode: 0o755 })
    const child = spawn(process.execPath, [ENTRY, 'full', '--print'], { cwd: repo.repo, env: repo.env({ NVM_DIR: join(repo.root, 'nvm') }) })
    let stderr = ''
    const code = await new Promise<number | null>((done) => {
      child.stderr.on('data', (chunk: Buffer) => {
        const started = !stderr.includes('running')
        stderr += chunk.toString()
        if (started && stderr.includes('running')) child.kill('SIGINT')
      })
      child.on('close', (status) => done(status))
    })
    expect([code, stderr]).toEqual([130, 'running\ninterrupted\n'])
  })

  it('wrong Node: an unreadable or rangeless engines file refuses naming it', () => {
    engines(undefined)
    expect(repo.gate(['full', '--print']).stderr).toBe('gate: desktop/web/package.json names no engines.node major\n')
    rmSync(join(repo.repo, 'desktop/web/package.json'))
    expect(repo.gate(['full', '--print']).stderr)
      .toBe('gate: desktop/web/package.json cannot be read for the engines Node (ENOENT)\n')
  })

  it('reads the major from the range and lets an equal or newer Node run', () => {
    const root = repo.repo
    engines('>=24.11')
    expect(engineRefusal('v24.0.0', root)).toBeUndefined()
    expect(engineRefusal('v25.1.0', root)).toBeUndefined()
    expect(engineRefusal('v22.22.0', root)).toBe('Node 24 is required (engines); found v22.22.0: run nvm install 24')
  })
})

describe('the command line', () => {
  it('refuses an unknown mode or flag with the usage and exit 2', () => {
    for (const args of [[], ['nonsense'], ['affected'], ['affected', '--staged', '--base', 'x'], ['full', '--areas', 'x'],
      ['areas'], ['actionlint', 'x'], ['agents-rows', '--fix']]) {
      const run = repo.gate(args)
      expect(run.status, args.join(' ')).toBe(2)
      expect(run.stderr).toContain('usage: node policy/gate/cli.mjs affected (--base <rev> | --staged) [--only <id>]... [--log-dir <dir>] [--print]')
    }
  })

  it('prints each check with a stable id', () => {
    const ids = repo.printed(['full', '--area', 'docs']).checks.map((check) => check.id)
    expect(ids).toEqual(['docs', 'docs-drift', 'docs-tests'])
  })
})

describe('the entry in the policy graph (2.1-M348)', () => {
  it('canopi-f47t.52.228.54: a policy module importing the gate entry breaks policy-imports-no-cli', () => {
    const web = join(REPO_ROOT, 'desktop/web')
    const run = spawnSync(join(web, 'node_modules/.bin/depcruise'), ['--config', '.dependency-cruiser.policy.cjs',
      '--output-type', 'json', '../../policy/fixtures/rules/policy-imports-no-cli/adapters/planted.mjs'], { cwd: web, encoding: 'utf8' })
    const { summary } = JSON.parse(run.stdout) as { summary: { violations: { rule: { name: string }, to: string }[] } }
    expect(summary.violations.filter((v) => v.rule.name === 'policy-imports-no-cli:cli').map((v) => v.to))
      .toEqual(['../../policy/check.mjs', '../../policy/gate/cli.mjs'])
  })
})
