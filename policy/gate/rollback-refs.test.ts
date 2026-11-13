// The rollback lane's reader and writer refs (rollback-refs.ts; ADR 0026 Checks, 2.1-M37, 2.1-M53, 2.1-M68): the
// resolver over planted tag lists, its command line (cli.mjs rollback-refs) through the real node and rollback.yml's
// resolve step, the reader jobs that go red rather than fall back to head's tree, the planted-change self-tests and the
// fixture checks around the readers.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as Yaml from 'yaml'
import { cleanEnv, REPO_ROOT } from './planted-repo.ts'
import { LAST_BEFORE_READERS, outputLines, resolveRollbackRefs } from './rollback-refs.ts'

const { parse } = createRequire(join(REPO_ROOT, 'desktop/web/package.json'))('yaml') as typeof Yaml
type Step = { name?: string, uses?: string, run?: string, if?: string, with?: Record<string, unknown>,
  env?: Record<string, string>, 'continue-on-error'?: unknown, 'working-directory'?: string }
type Job = { steps: Step[], 'continue-on-error'?: unknown, needs?: string | string[], outputs?: Record<string, string> }
const ROLLBACK = parse(readFileSync(join(REPO_ROOT, '.github/workflows/rollback.yml'), 'utf8')) as { jobs: Record<string, Job>,
  on: { pull_request?: unknown, push?: unknown, workflow_call?: { inputs?: Record<string, unknown> }, workflow_dispatch?: unknown } }

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
  const run = (step: Step, env: Record<string, string>, cwd = REPO_ROOT) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run ?? ''], {
    cwd, encoding: 'utf8', timeout: 60_000,
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

  it('canopi-f47t.52.239: the lane runs when Build & Test or a Release Candidate calls it, or on a dispatch, never on a pull request of its own', () => {
    // Its release/2.0 trigger is Build & Test's, which a release branch cut from main inherits (ci-parity.test.ts).
    expect(ROLLBACK.on.pull_request).toBeUndefined()
    expect(ROLLBACK.on.push).toBeUndefined()
    expect(Object.keys(ROLLBACK.on.workflow_call?.inputs ?? {}).sort()).toEqual(['branch', 'candidate', 'writer_ref'])
    expect(ROLLBACK.on.workflow_dispatch).toBeDefined()
    expect(resolveStep().env).toEqual({ ROLLBACK_BRANCH: '${{ inputs.branch || github.base_ref || github.ref_name }}',
      ROLLBACK_CANDIDATE: '${{ inputs.candidate || github.event.pull_request.head.sha || github.sha }}',
      ROLLBACK_WRITER_REF: '${{ inputs.writer_ref }}' })
  })

  /** `name`'s job, or a thrown error naming it. */
  const job = (name: string) => {
    const found = ROLLBACK.jobs[name]
    if (!found) throw new Error(`rollback.yml has no ${name} job`)
    return found
  }
  /** `name`'s step whose script holds `text`. */
  const stepOf = (name: string, text: string) => {
    const found = job(name).steps.find((step) => step.run?.includes(text))
    if (!found) throw new Error(`rollback.yml's ${name} job has no step running ${text}`)
    return found
  }

  it('canopi-f47t.52.239: each reader job builds the resolved reader tree, red when it fails with no fallback to head\'s tree', () => {
    for (const name of ['reader-desktop', 'reader-web']) {
      const reader = job(name)
      expect(reader.needs).toEqual(['resolve', 'writer'])
      // The reader tree at the root; this run's tree, whose fixture checks judge the readers, under lane/ only.
      const checkouts = reader.steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
      expect(checkouts.map((step) => step.with)).toEqual([{ ref: '${{ needs.resolve.outputs.reader }}' }, { path: 'lane' }])
      // Red stays red: nothing tolerates a failure, and only the report upload runs after one.
      expect(reader['continue-on-error']).toBeUndefined()
      expect(reader.steps.filter((step) => step['continue-on-error'] !== undefined)).toEqual([])
      expect(reader.steps.filter((step) => step.if !== undefined).map((step) => [step.name, step.if]))
        .toEqual(name === 'reader-web' ? [['Upload the report and traces', 'failure()']] : [])
    }
    fake('cargo', 'error: could not compile `canopi-desktop` (lib) due to 3 previous errors\n', 101)
    expect(run(stepOf('reader-desktop', 'cargo test -p canopi-desktop --test rollback_reader --locked'), {}).status).toBe(101)
    // The writer lays its tree's forms down, the candidate's in candidate mode.
    expect(job('writer').steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with)
      .toEqual({ ref: '${{ needs.resolve.outputs.writer || needs.resolve.outputs.reader }}' })
  })

  it('canopi-f47t.52.239: missing fixture artifact: the writer\'s upload fails on an empty directory, and each reader checks what it downloaded first', () => {
    const upload = job('writer').steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
    expect(upload?.with).toMatchObject({ name: 'rollback-fixtures', 'if-no-files-found': 'error' })
    for (const name of ['reader-desktop', 'reader-web']) {
      const steps = job(name).steps
      const download = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'))
      expect(steps[download]?.with?.['name']).toBe('rollback-fixtures')
      const harness = steps.findIndex((step) => /cargo test|npm run test:rollback/.test(step.run ?? ''))
      const check = steps.findIndex((step) => step.run?.includes('rollback-fixtures check'))
      expect(download).toBeGreaterThan(-1)
      expect(check).toBeGreaterThan(download)
      expect(harness).toBeGreaterThan(check)
    }
  })

  it('canopi-f47t.52.239: store with no writer (fixtures only): the writer names each form it laid down from its frozen form in the summary', () => {
    fake('cargo', 'running 1 test\nFIXTURES-ONLY web settings 2 web/settings.json: no build writes it yet, so the readers read its frozen form\ntest ok\n')
    const result = run(stepOf('writer', 'the_writer_lays_down'), { RUNNER_TEMP: dir })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toBe('FIXTURES-ONLY web settings 2 web/settings.json: no build writes it yet, so the readers read its frozen form\n')
    fake('cargo', 'error: test failed\n', 101)
    expect(run(stepOf('writer', 'the_writer_lays_down'), { RUNNER_TEMP: dir }).status).toBe(101)
  })

  /** A cargo that lists `ignored` for `--list` and otherwise exits `status`. */
  const fakeCargo = (ignored: string, status: number) => {
    writeFileSync(join(dir, 'list.out'), ignored)
    writeFileSync(join(dir, 'cargo'), `#!/usr/bin/env bash\nif [[ "$*" == *--list* ]]; then cat "${join(dir, 'list.out')}"; exit 0; fi\nexit ${status}\n`)
    chmodSync(join(dir, 'cargo'), 0o755)
  }

  it('canopi-f47t.52.239: planted run passes: the Desktop lane fails when its readers pass over the planted change, held only while the session test is expected-fail', () => {
    const planted = stepOf('reader-desktop', 'rollback-fixtures plant')
    mkdirSync(join(dir, 'rollback-fixtures'))
    fake('node', '')
    const env = { RUNNER_TEMP: dir, CANOPI_ROLLBACK_FIXTURES: join(dir, 'planted') }
    const again = () => rmSync(join(dir, 'planted'), { recursive: true, force: true })
    fakeCargo('', 0)
    let result = run(planted, env)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::the Desktop readers passed over a planted unreadable change')
    again()
    fakeCargo('', 101)
    expect(run(planted, env).status).toBe(0)
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain('PLANTED desktop: the readers failed on the planted change')
    again()
    fakeCargo('reader::r4_canopi_f47t_52_239_a_session_over_every_frozen_store_fixture_writes_no_byte_on_desktop: test\n', 0)
    result = run(planted, env)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('::warning::expected-fail (R4 canopi-f47t.52.239)')
  })

  it('canopi-f47t.52.239: a reader tag whose Desktop session test is still expected-fail fails the planted-change step, never held', () => {
    const planted = stepOf('reader-desktop', 'rollback-fixtures plant')
    expect(planted.env?.['ROLLBACK_MODE']).toBe('${{ needs.resolve.outputs.mode }}')
    mkdirSync(join(dir, 'rollback-fixtures'))
    fake('node', '')
    fakeCargo('reader::r4_canopi_f47t_52_239_a_session_over_every_frozen_store_fixture_writes_no_byte_on_desktop: test\n', 0)
    const env = { RUNNER_TEMP: dir, CANOPI_ROLLBACK_FIXTURES: join(dir, 'planted') }
    const result = run(planted, { ...env, ROLLBACK_MODE: 'tag' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::the reader tag\'s Desktop session test is still expected-fail')
    rmSync(join(dir, 'planted'), { recursive: true, force: true })
    expect(run(planted, { ...env, ROLLBACK_MODE: 'candidate' }).status).toBe(0)
  })

  it('canopi-f47t.52.239: planted run passes: a Web lane whose readers pass over the planted change fails', () => {
    // GitHub fills the matrix expression in before bash runs the script.
    const step = stepOf('reader-web', 'rollback-fixtures plant')
    const planted = { ...step, run: step.run?.replaceAll('${{ matrix.engine }}', 'webkit') }
    mkdirSync(join(dir, 'rollback-fixtures'))
    fake('node', '')
    const env = { RUNNER_TEMP: dir, CANOPI_ROLLBACK_FIXTURES: join(dir, 'planted') }
    fake('npm', '1 passed\n', 0)
    const result = run(planted, env, join(REPO_ROOT, 'desktop/web'))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::the webkit readers passed over a planted unreadable change')
    rmSync(join(dir, 'planted'), { recursive: true, force: true })
    fake('npm', '1 failed\n', 1)
    expect(run(planted, env, join(REPO_ROOT, 'desktop/web')).status).toBe(0)
  })

  it('canopi-f47t.52.239: the Web job serves the reader tree\'s bundle to this run\'s harness under lane/, which seeds and compares the profile', () => {
    // Contracts §11 Rollback harness: main's lane judges the Web readers, as it hashes the Desktop fixtures itself, so a
    // frozen reader tag never fixes what its Web check asserts.
    const steps = job('reader-web').steps
    const build = steps.find((step) => step.run === 'npm run build:web:bundle')
    expect(build?.['working-directory'], 'the reader tree builds its own bundle').toBeUndefined()
    expect(steps.filter((step) => step.run?.startsWith('npm ci')).map((step) => step['working-directory']))
      .toEqual([undefined, 'lane/desktop/web'])
    for (const text of ['npm run test:rollback -- --project', 'rollback-fixtures plant']) {
      expect(stepOf('reader-web', text)['working-directory'], text).toBe('lane/desktop/web')
    }
    expect(steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))?.with?.['path']).toBe('lane/desktop/web/test-results/')
    // Through bash: the harness serves the reader's dist-web, wherever the runner puts the workspace.
    const harness = stepOf('reader-web', 'npm run test:rollback -- --project')
    writeFileSync(join(dir, 'npm'), '#!/usr/bin/env bash\necho "serves $CANOPI_ROLLBACK_WEB_DIST"\n')
    chmodSync(join(dir, 'npm'), 0o755)
    const result = run({ ...harness, run: harness.run?.replaceAll('${{ matrix.engine }}', 'chromium') },
      { GITHUB_WORKSPACE: join(dir, 'workspace') }, join(REPO_ROOT, 'desktop/web'))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(`serves ${join(dir, 'workspace')}/desktop/web/dist-web\n`)
  })

  it('canopi-f47t.52.239: cancelled run: a cancelled or failed rollback lane fails Build & Test, on main and release/2.0 alike, and blocks a release', () => {
    type Caller = { on: unknown, jobs: Record<string, { needs?: string | string[], if?: string, uses?: string, with?: unknown, steps?: Step[] }> }
    const read = (file: string) => parse(readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8')) as Caller
    // Its release/2.0 trigger is Build & Test's: the lane has none of its own, so the release branch cut from main
    // inherits it with build.yml.
    const build = read('build.yml')
    expect(build.on).toMatchObject({ push: { branches: ['main', 'release/2.0'] }, pull_request: { branches: ['main', 'release/2.0'] } })
    expect(build.jobs['rollback']).toEqual({ needs: 'changes', if: "needs.changes.outputs.rollback == 'true'", uses: './.github/workflows/rollback.yml' })
    const aggregate = build.jobs['build-and-test']
    expect(aggregate?.needs).toContain('rollback')
    expect(aggregate?.if).toBe('always()')
    expect(aggregate?.steps?.[0]?.if).toBe("contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')")
    // A Release Candidate's manifest waits on it and runs only when nothing failed or was cancelled; its dry run never
    // calls it, which would share the lane's group with Build & Test's call (ci-parity.test.ts nestedFaults).
    const release = read('release-candidate.yml')
    expect(release.jobs['rollback']).toEqual({ needs: 'preflight', if: "needs.preflight.outputs.dry_run != 'true'",
      uses: './.github/workflows/rollback.yml', with: { candidate: '${{ needs.preflight.outputs.head_sha }}', branch: '${{ inputs.ref }}' } })
    expect(release.jobs['manifest']?.needs).toContain('rollback')
    expect(release.jobs['manifest']?.if).toContain('!cancelled()')
  })

  it('canopi-f47t.52.239: -wal/-shm created or a file pruned: the Desktop job compares the fixture bytes after its harness ran', () => {
    const steps = job('reader-desktop').steps
    const snapshot = steps.findIndex((step) => step.run?.includes('rollback-fixtures snapshot'))
    const harness = steps.findIndex((step) => step.run === 'cargo test -p canopi-desktop --test rollback_reader --locked')
    const compare = steps.findIndex((step) => step.run?.includes('rollback-fixtures compare'))
    expect([snapshot > -1, harness > snapshot, compare === harness + 1]).toEqual([true, true, true])
    expect(steps[harness]?.env).toEqual({ CANOPI_ROLLBACK_FIXTURES: '${{ runner.temp }}/rollback-fixtures' })
  })
})

describe('the rollback lane\'s own fixture checks (canopi-f47t.52.239)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rollback-fixtures-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** `node policy/gate/cli.mjs rollback-fixtures ...args` through the real node, its summary in the scratch folder. */
  const cli = (...args: string[]) => spawnSync('node', ['policy/gate/cli.mjs', 'rollback-fixtures', ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, env: { ...cleanEnv(), GITHUB_STEP_SUMMARY: join(dir, 'summary') },
  })
  /** A fixture directory as the writer job uploads it: the manifest and two forms, one of each edition. */
  const fixtures = () => {
    const root = join(dir, 'fixtures')
    mkdirSync(join(root, 'desktop/app-data'), { recursive: true })
    mkdirSync(join(root, 'web'), { recursive: true })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 1, forms: [
      { store: 'user_db', form_version: 10, edition: 'desktop', path: 'desktop/app-data/user.db' },
      { store: 'web_species_lists', form_version: 1, edition: 'web', path: 'web/species-lists.json' }] }))
    writeFileSync(join(root, 'desktop/app-data/user.db'), 'SQLite format 3\0 frozen pages')
    writeFileSync(join(root, 'web/species-lists.json'), '{"key":"canopi:web-app-data:v4:species","record":{"version":1}}')
    return root
  }

  it('canopi-f47t.52.239: missing fixture artifact: a directory the writer\'s artifact never reached, or missing a listed form, is refused', () => {
    const absent = cli('check', join(dir, 'never-downloaded'))
    expect(absent.status).toBe(1)
    expect(absent.stderr).toContain('the writer job\'s artifact was not downloaded')
    const root = fixtures()
    expect(cli('check', root).status).toBe(0)
    rmSync(join(root, 'web/species-lists.json'))
    const partial = cli('check', root)
    expect(partial.status).toBe(1)
    expect(partial.stderr).toContain('the web web_species_lists form web/species-lists.json is missing')
    rmSync(join(root, 'manifest.json'))
    expect(cli('check', root).stderr).toContain('manifest.json is missing')
    writeFileSync(join(root, 'manifest.json'), '{"forms": []}')
    expect(cli('check', root).stderr).toContain('lists no forms')
    writeFileSync(join(root, 'manifest.json'), 'not json')
    expect(cli('check', root).stderr).toContain('is not JSON')
  })

  it('canopi-f47t.52.239: -wal/-shm created or a file pruned: only SQLite\'s engine metadata passes, any other write fails naming the file', () => {
    const root = fixtures()
    const before = join(dir, 'before.json')
    expect(cli('snapshot', root, before).status).toBe(0)
    expect(Object.keys(JSON.parse(readFileSync(before, 'utf8')) as object).sort())
      .toEqual(['desktop/app-data/user.db', 'manifest.json', 'web/species-lists.json'])
    // A read-only open of a WAL database may create a -shm and an empty -wal (contracts §11 Degraded stores).
    writeFileSync(join(root, 'desktop/app-data/user.db-shm'), Buffer.alloc(32))
    writeFileSync(join(root, 'desktop/app-data/user.db-wal'), '')
    const clean = cli('compare', root, before)
    expect(clean.status, clean.stderr).toBe(0)
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain('the readers wrote no byte')
    // A -wal holding a frame is a write.
    writeFileSync(join(root, 'desktop/app-data/user.db-wal'), 'frame')
    expect(cli('compare', root, before).stderr).toContain('ERROR: the readers wrote: desktop/app-data/user.db-wal was created')
    rmSync(join(root, 'desktop/app-data/user.db-wal'))
    // A pruned file and a changed byte are changes.
    rmSync(join(root, 'web/species-lists.json'))
    writeFileSync(join(root, 'desktop/app-data/user.db'), 'SQLite format 3\0 frozen pageS')
    const changed = cli('compare', root, before)
    expect(changed.status).toBe(1)
    expect(changed.stderr).toContain('desktop/app-data/user.db changed')
    expect(changed.stderr).toContain('web/species-lists.json was pruned')
  })

  it('canopi-f47t.52.239: planted run: the self-test makes one frozen form of each edition unreadable, and refuses an edition with none', () => {
    const root = fixtures()
    const before = join(dir, 'before.json')
    expect(cli('snapshot', root, before).status).toBe(0)
    const planted = cli('plant', root, 'web')
    expect(planted.status, planted.stderr).toBe(0)
    expect(planted.stdout).toContain('planted an unreadable change in web/species-lists.json')
    // A Web record keeps its key, so the harness still seeds it and the reader is what fails on it.
    expect(JSON.parse(readFileSync(join(root, 'web/species-lists.json'), 'utf8'))).toEqual({ key: 'canopi:web-app-data:v4:species',
      record: 'planted: a change the readers cannot read, so their run must fail' })
    expect(cli('compare', root, before).stderr).toContain('web/species-lists.json changed')
    // A database's bytes are replaced.
    expect(cli('plant', root, 'desktop').status).toBe(0)
    expect(readFileSync(join(root, 'desktop/app-data/user.db'), 'utf8')).toMatch(/^planted: /)
    expect(cli('plant', root, 'phone').stderr).toContain('lists no phone form to plant a change in')
    expect(cli('plant', join(dir, 'none'), 'web').stderr).toContain('manifest.json is missing')
    expect(cli('wipe', root).stderr).toContain('usage: rollback-fixtures')
  })
})
