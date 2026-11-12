// The rollback lane's reader and writer refs (rollback-refs.ts; ADR 0026 Checks, 2.1-M37, 2.1-M53, 2.1-M68): the
// resolver over planted tag lists, its command line (cli.mjs rollback-refs) through the real node and rollback.yml's
// resolve step, and the reader build that goes red rather than fall back to head's tree.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { cleanEnv, REPO_ROOT } from './planted-repo.ts'
import { LAST_BEFORE_READERS, outputLines, resolveRollbackRefs } from './rollback-refs.ts'

const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml
type Step = { name?: string, uses?: string, run?: string, if?: string, with?: Record<string, unknown>,
  env?: Record<string, string>, 'continue-on-error'?: unknown }
type Job = { steps: Step[], 'continue-on-error'?: unknown, needs?: string | string[], outputs?: Record<string, string> }
const ROLLBACK = parse(readFileSync(join(REPO_ROOT, '.github/workflows/rollback.yml'), 'utf8')) as { jobs: Record<string, Job>,
  on: { pull_request?: { branches?: string[], paths?: string[] } } }

const CANDIDATE = '3f9c2e1d0b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e'
/** The repository's tags on 2026-11-12: stable releases to v2.0.3, two 2.1 betas and the channel and asset tags. */
const TODAY = ['beta-channel', 'bundler-tools', 'canopi-beta-manifest', 'canopi-core-db', 'canopi-stable-manifest', 'v1.2.0',
  'v2.0.0', 'v2.0.1', 'v2.0.2', 'v2.0.3', 'v2.1.0-beta.1', 'v2.1.0-beta.2']

describe('the rollback lane\'s reader and writer refs (canopi-f47t.52.239)', () => {
  it('canopi-f47t.52.239: no tag at or above the reader release floor: candidate mode on the frozen fixtures, logged', () => {
    const refs = resolveRollbackRefs({ tags: TODAY, branch: 'main', candidate: CANDIDATE })
    expect(LAST_BEFORE_READERS).toBe('v2.0.3')
    expect(refs).toMatchObject({ mode: 'candidate', reader: CANDIDATE, writer: null })
    expect(refs.log).toBe(`Rollback refs: candidate mode. No stable tag is above v2.0.3, the last 2.0.x before the readers, so the `
      + `readers build from the candidate ${CANDIDATE} and read the frozen fixtures only.`)
    // A beta of a later minor, or a tag that is no version, is no reader release.
    expect(resolveRollbackRefs({ tags: [...TODAY, 'v2.0.4-rc.1', 'v2.1.0-beta.9', 'v2.0.04', 'release-2.0.4'], branch: 'main',
      candidate: CANDIDATE }).mode).toBe('candidate')
  })

  it('tag mode: once the reader release is tagged the readers build from the latest stable 2.0.x tag over what the candidate writes', () => {
    const refs = resolveRollbackRefs({ tags: [...TODAY, 'v2.0.4'], branch: 'main', candidate: CANDIDATE })
    expect(refs).toEqual({ mode: 'tag', reader: 'v2.0.4', writer: CANDIDATE, log: 'Rollback refs: tag mode. The readers build from '
      + `v2.0.4, the latest stable tag of 2.0, and read what the candidate ${CANDIDATE} writes.` })
    // Versions compare as numbers, not text.
    expect(resolveRollbackRefs({ tags: ['v2.0.10', 'v2.0.9', 'v2.0.4', ...TODAY], branch: 'main', candidate: CANDIDATE }).reader)
      .toBe('v2.0.10')
  })

  it('a maintenance branch builds the readers from its candidate over what main, or the writer_ref branch, writes', () => {
    const tags = [...TODAY, 'v2.0.4', 'v2.0.5']
    const refs = resolveRollbackRefs({ tags, branch: 'release/2.0', candidate: CANDIDATE, writerRef: 'store/settings-record-3' })
    expect(refs).toEqual({ mode: 'maintenance', reader: CANDIDATE, writer: 'store/settings-record-3', log: 'Rollback refs: maintenance '
      + `branch release/2.0. The readers build from the candidate ${CANDIDATE} and read the frozen fixtures and what `
      + 'store/settings-record-3 writes.' })
    expect(resolveRollbackRefs({ tags, branch: 'release/2.0', candidate: CANDIDATE })).toMatchObject({ reader: CANDIDATE, writer: 'main' })
    expect(resolveRollbackRefs({ tags, branch: 'release/2.0', candidate: CANDIDATE, writerRef: '' })).toMatchObject({ writer: 'main' })
    // Only a maintenance run names its writer: on main the candidate is what writes.
    expect(() => resolveRollbackRefs({ tags, branch: 'main', candidate: CANDIDATE, writerRef: 'store/settings-record-3' }))
      .toThrow('writer_ref store/settings-record-3 applies to a maintenance branch run (release/<major>.<minor>), not to main')
  })

  it('from 2.1.0 on the readers build from the previous stable minor\'s latest tag', () => {
    const tags = [...TODAY, 'v2.0.4', 'v2.0.5', 'v2.1.0', 'v2.1.1', 'v2.2.0-beta.1', 'v2.0.6']
    expect(resolveRollbackRefs({ tags, branch: 'main', candidate: CANDIDATE })).toMatchObject({ mode: 'tag', reader: 'v2.1.1',
      writer: CANDIDATE, log: expect.stringContaining('v2.1.1, the latest stable tag of 2.1,') })
    // 2.1's maintenance branch builds from its own candidate, as release/2.0 did.
    expect(resolveRollbackRefs({ tags, branch: 'release/2.1', candidate: CANDIDATE })).toMatchObject({ mode: 'maintenance',
      reader: CANDIDATE, writer: 'main' })
  })

  it('refuses a run with no candidate or no branch rather than guess one', () => {
    expect(() => resolveRollbackRefs({ tags: TODAY, branch: 'main', candidate: '' })).toThrow('no candidate commit')
    expect(() => resolveRollbackRefs({ tags: TODAY, branch: '', candidate: CANDIDATE })).toThrow('no branch')
  })

  it('writes the step outputs, an unwritten writer empty', () => {
    expect(outputLines(resolveRollbackRefs({ tags: TODAY, branch: 'main', candidate: CANDIDATE })))
      .toBe(`mode=candidate\nreader=${CANDIDATE}\nwriter=\n`)
    expect(outputLines(resolveRollbackRefs({ tags: [...TODAY, 'v2.0.4'], branch: 'main', candidate: CANDIDATE })))
      .toBe(`mode=tag\nreader=v2.0.4\nwriter=${CANDIDATE}\n`)
  })
})

describe('rollback.yml (canopi-f47t.52.239)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rollback-refs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A program on PATH that prints `out` and exits `status`. */
  const fake = (name: string, out: string, status = 0) => {
    writeFileSync(join(dir, `${name}.out`), out)
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\ncat "${join(dir, `${name}.out`)}"\nexit ${status}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  /** `step`'s script in GitHub's bash (`-eo pipefail`) from the repository root, the fakes first on PATH. */
  const run = (step: Step, env: Record<string, string>) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run ?? ''], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...cleanEnv(), ...env, PATH: `${dir}:${process.env['PATH'] ?? ''}`, GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary') },
  })
  const resolveStep = () => {
    const step = ROLLBACK.jobs['resolve']?.steps.find((candidate) => candidate.run?.includes('node policy/gate/cli.mjs rollback-refs'))
    if (!step) throw new Error('rollback.yml\'s resolve job has no step running node policy/gate/cli.mjs rollback-refs')
    return step
  }
  const lsRemote = (tags: readonly string[]) => tags.map((tag, index) => `${index.toString(16).padStart(40, '0')}\trefs/tags/${tag}\n`).join('')

  it('canopi-f47t.52.239: the resolve step logs candidate mode when no tag is at or above the reader release floor, through the real node', () => {
    fake('git', lsRemote(TODAY))
    const result = run(resolveStep(), { ROLLBACK_BRANCH: 'main', ROLLBACK_CANDIDATE: CANDIDATE, ROLLBACK_WRITER_REF: '' })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('Rollback refs: candidate mode. No stable tag is above v2.0.3')
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain('Rollback refs: candidate mode.')
    expect(readFileSync(join(dir, 'output'), 'utf8')).toBe(`mode=candidate\nreader=${CANDIDATE}\nwriter=\n`)
    // The job hands each output on, under its own name.
    expect(ROLLBACK.jobs['resolve']?.outputs).toEqual({ mode: '${{ steps.refs.outputs.mode }}',
      reader: '${{ steps.refs.outputs.reader }}', writer: '${{ steps.refs.outputs.writer }}' })
  })

  it('the resolve step names the tag in tag mode and fails, naming why, on a writer_ref outside a maintenance branch', () => {
    fake('git', lsRemote([...TODAY, 'v2.0.4']))
    const tag = run(resolveStep(), { ROLLBACK_BRANCH: 'main', ROLLBACK_CANDIDATE: CANDIDATE, ROLLBACK_WRITER_REF: '' })
    expect(tag.status, `${tag.stdout}\n${tag.stderr}`).toBe(0)
    expect(readFileSync(join(dir, 'output'), 'utf8')).toBe(`mode=tag\nreader=v2.0.4\nwriter=${CANDIDATE}\n`)
    const wrong = run(resolveStep(), { ROLLBACK_BRANCH: 'main', ROLLBACK_CANDIDATE: CANDIDATE, ROLLBACK_WRITER_REF: 'store/x' })
    expect(wrong.status).not.toBe(0)
    expect(wrong.stderr).toContain('ERROR: writer_ref store/x applies to a maintenance branch run')
    // A failed tag listing is a failed step, not candidate mode.
    fake('git', '', 128)
    expect(run(resolveStep(), { ROLLBACK_BRANCH: 'main', ROLLBACK_CANDIDATE: CANDIDATE, ROLLBACK_WRITER_REF: '' }).status).not.toBe(0)
  })

  it('canopi-f47t.52.239: a pull request starts the lane only when it changes rollback.yml, not on a gate edit', () => {
    // The resolver's own tests run in the policy-gate project; an edit to the gate's entry or the resolver starts no
    // v2.0.3 build or browser legs.
    expect(ROLLBACK.on.pull_request).toEqual({ branches: ['main'], paths: ['.github/workflows/rollback.yml'] })
  })

  it('canopi-f47t.52.239: a reader tag that fails to build is red, with no fallback to head\'s tree', () => {
    const job = ROLLBACK.jobs['reader-build']
    if (!job) throw new Error('rollback.yml has no reader-build job')
    const build = job.steps.find((step) => step.run?.includes('cargo test -p canopi-desktop --no-run'))
    if (!build) throw new Error('rollback.yml\'s reader-build job has no step building the desktop tests')
    fake('cargo', 'error: could not compile `canopi-desktop` (lib) due to 3 previous errors\n', 101)
    const result = run(build, {})
    expect(result.status).toBe(101)
    // Red stays red: nothing in the job tolerates the failure or runs after it, and its one checkout is the reader tag.
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.steps.filter((step) => step['continue-on-error'] !== undefined || step.if !== undefined)).toEqual([])
    const checkouts = job.steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkouts.map((step) => step.with?.['ref'])).toEqual(['${{ inputs.reader_tag || \'v2.0.3\' }}'])
  })
})
