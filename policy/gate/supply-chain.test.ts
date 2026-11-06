// OSV is the one advisory scanner (design check A17, superseding 2.1-M204's cargo-deny advisories): a pull request
// changing a lockfile, the exception table or the scanner's inputs runs it in Build & Test's supply-chain job, and
// advisories.yml runs the same action on every push to main and weekly, where new advisories land (2.1-M292).
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { holdsIf } from './expression.ts'
import { areasJson } from './plan.ts'
import { REPO_ROOT } from './planted-repo.ts'
import { TABLE } from './table.ts'
import { readWorkflows, triggers, type Step } from './workflows.ts'

const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml
const ACTION = './.github/actions/osv-advisories'
const all = readWorkflows(join(REPO_ROOT, '.github/workflows'))
const build = all.get('build.yml') ?? {}
const advisories = all.get('advisories.yml') ?? {}
const action = parse(readFileSync(join(REPO_ROOT, ACTION, 'action.yml'), 'utf8')) as { runs: { steps: Step[] } }
const usesAction = (steps: readonly Step[] = []) => steps.some((step) => step.uses === ACTION)

describe('the supply-chain lane (design check A17, canopi-f47t.52.240)', () => {
  it('runs OSV in Build & Test on a pull request changing a lockfile, the table or the scanner, and on no other', () => {
    const job = build.jobs?.['supply-chain']
    expect(usesAction(job?.steps)).toBe(true)
    expect([build.jobs?.['build-and-test']?.needs ?? []].flat()).toContain('supply-chain')
    const runs = (output: string) => holdsIf(job?.if, { needs: { changes: { outputs: { supply_chain: output } } }, github: { event_name: 'pull_request' } })
    expect([runs('true'), runs('false')]).toEqual([true, false])
    // Every tracked lockfile osv-scanner reads (canopi-f47t.52.228.14), the fixtures aside.
    const lockfiles = execFileSync('git', ['ls-files', 'Cargo.lock', '*package-lock.json'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n').filter((path) => path !== '' && !path.startsWith('policy/fixtures/'))
    expect(lockfiles).toContain('desktop/web/e2e/platform/phones/ios/appium/package-lock.json')
    const inputs = [...lockfiles, 'desktop/web/package.json', 'policy/advisories.json', 'osv-scanner.toml', 'policy/adapters/osv-scanner.mjs', 'policy/adapters/advisories.ts', 'renovate.json', `${ACTION.slice(2)}/action.yml`]
    for (const path of inputs) expect(areasJson(REPO_ROOT, [path]).selected, path).toContain('supply-chain')
    for (const path of ['desktop/web/src/app.tsx', 'desktop/src/lib.rs', 'deny.toml']) expect(areasJson(REPO_ROOT, [path]).selected, path).not.toContain('supply-chain')
    expect(TABLE.areas.find((area) => area.name === 'supply-chain')?.full).toEqual(['supply-chain'])
  })

  it('runs the same action on every push to main, weekly and on a dispatch, never on a pull request of its own', () => {
    const on = triggers(advisories)
    expect(Object.keys(on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch'])
    expect(on['push']).toEqual({ branches: ['main'] })
    expect(usesAction(advisories.jobs?.['advisories']?.steps)).toBe(true)
    expect([...TABLE.checks['advisories']?.on ?? []].sort()).toEqual(['push', 'schedule', 'workflow_dispatch'])
  })

  // advisories.yml has no pull_request run of its own, so a PR's supply-chain job proves it: the workflow holds only
  // the checkout and the action, the action sets up the Node its checker runs, and a PR editing the workflow runs the job.
  it('holds nothing a pull request\'s supply-chain job does not run', () => {
    const steps = advisories.jobs?.['advisories']?.steps ?? []
    expect(steps.map((step) => step.uses?.replace(/@.*/, ''))).toEqual(['actions/checkout', ACTION])
    const node = action.runs.steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'))
    const scan = action.runs.steps.findIndex((step) => step.name === 'OSV advisories against policy/advisories.json')
    expect(node).toBeGreaterThanOrEqual(0)
    expect(node).toBeLessThan(scan)
    expect(areasJson(REPO_ROOT, ['.github/workflows/advisories.yml']).selected).toContain('supply-chain')
  })

  describe('the action\'s table check', () => {
    let dir = ''
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'supply-chain-'))
      for (const path of ['policy/adapters', 'policy/core']) cpSync(join(REPO_ROOT, path), join(dir, path), { recursive: true })
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('unreadable: a malformed OSV table fails the job, naming the file', () => {
      writeFileSync(join(dir, 'policy/advisories.json'), '{ "advisories": [ ')
      const check = action.runs.steps.find((step) => step.name === 'OSV advisories against policy/advisories.json')
      const summary = join(dir, 'summary')
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', check?.run ?? 'exit 99'], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, EVENT: 'push', BASE_SHA: '', GITHUB_STEP_SUMMARY: summary },
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('ERROR: policy/advisories.json cannot be read')
    })
  })
})
