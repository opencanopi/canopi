// Regression tests for the iOS lane's planted blank-page step (2.1-Q247, F5 chunk 11 review findings 1a and 1b):
// the step passes only when the smoke itself fails on the blank page, and the smoke names the start screen only when
// wdio's wait timed out, so a session that never started or died mid-wait fails the step. The step runs when a change
// touches the lane's own files, and on the schedule or a dispatch (canopi-f47t.52.240).
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const WORKFLOW = new URL('../../../../.github/workflows/phone-smoke.yml', import.meta.url)
const PLANTED_STEP = 'The iOS lane fails on a planted blank page'
const DECIDE_STEP = 'Whether the planted blank page runs'

/** The iOS job's step `name`'s shell script, as the runner reads it. */
function iosStep(name: string): string {
  const { jobs } = parse(readFileSync(WORKFLOW, 'utf8')) as { jobs: { ios: { steps: { name?: string, run?: string }[] } } }
  const run = jobs.ios.steps.find((step) => step.name === name)?.run
  if (!run) throw new Error(`no iOS step "${name}" with a script in phone-smoke.yml`)
  return run
}
const plantedStepScript = () => iosStep(PLANTED_STEP)

/** Runs the planted step with a fake `npm` that prints `log` and exits with `status`; returns whether the step passed. */
function runPlantedStep(log: string, status: number): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'ios-planted-'))
  writeFileSync(join(dir, 'log.txt'), log)
  writeFileSync(join(dir, 'npm'), `#!/usr/bin/env bash\ncat "${join(dir, 'log.txt')}"\nexit ${status}\n`)
  chmodSync(join(dir, 'npm'), 0o755)
  try {
    execFileSync('bash', ['-e', '-c', plantedStepScript()], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, RUNNER_TEMP: dir },
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

// The smoke's real test body, imported with a fake @wdio/globals whose start-screen wait rejects with `wait.error`,
// and with wdio's mocha globals standing in for the describe and it the spec calls when it loads.
const wait = vi.hoisted(() => ({ error: '' }))
vi.mock('@wdio/globals', () => {
  const element = { waitForDisplayed: () => Promise.reject(new Error(wait.error)) }
  return { $: () => element, browser: { url: () => Promise.resolve() }, expect: () => { throw new Error('unreachable') } }
})
let smokeBody: (() => Promise<void>) | undefined

/** The message the smoke throws when wdio's start-screen wait rejects with `waitError`. */
async function smokeFailure(waitError: string): Promise<string> {
  wait.error = waitError
  try {
    await smokeBody?.()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

beforeAll(async () => {
  vi.stubEnv('CANOPI_E2E_PLANTED_PAGE', 'about:blank')
  vi.stubGlobal('describe', (_name: string, suite: () => void) => suite())
  vi.stubGlobal('it', (_name: string, body: () => Promise<void>) => { smokeBody = body })
  // A specifier TypeScript does not follow: the spec type-checks in its own project (e2e/platform, wdio's globals), and
  // under this one's vitest types its `expect` calls do not compile.
  const spec: string = '../../e2e/platform/phones/ios/smoke.spec'
  await import(/* @vite-ignore */ spec)
  vi.unstubAllGlobals()
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describe('the iOS planted blank-page step (2.1-Q247, canopi-f47t.52.228.14)', () => {
  it('passes when the smoke fails on the blank page itself', async () => {
    const startScreenFailure = await smokeFailure('element ("[data-start-screen]") still not displayed after 90000ms')
    expect(startScreenFailure).toBe('the start screen was not displayed 90 s after opening about:blank')
    expect(runPlantedStep(`${startScreenFailure}\n`, 1)).toBe(true)
  })

  it('fails when the smoke passes on the blank page', () => {
    expect(runPlantedStep('1 passing\n', 0)).toBe(false)
  })

  it('fails when Appium created no session (finding 1a)', () => {
    expect(runPlantedStep('ERROR webdriver: Could not create a session: WebDriverAgent did not start\n', 1)).toBe(false)
  })

  it('fails when the session dies during the start-screen wait (finding 1b)', async () => {
    const died = 'waitUntil condition failed with the following reason: invalid session id'
    const failure = await smokeFailure(died)
    expect(failure).toBe(died)
    expect(runPlantedStep(`${failure}\n`, 1)).toBe(false)
  })
})

describe('the iOS planted step runs on the lane\'s own files, the schedule or a dispatch (canopi-f47t.52.240)', () => {
  let dir = ''
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  let edits = 0
  /** A new revision of `path`, so each call commits a change. */
  const write = (path: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), `${path} ${++edits}\n`)
  }
  /** The decision for `event` from `base`, with `changed` committed on top of it. */
  const decide = (event: string, changed: string[], base?: string) => {
    for (const path of changed) write(path)
    if (changed.length) {
      git('add', '.')
      git('commit', '-q', '-m', 'change')
    }
    const output = join(dir, 'github-output')
    writeFileSync(output, '')
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', iosStep(DECIDE_STEP)], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, EVENT: event, BASE: base ?? '', GITHUB_OUTPUT: output },
    })
    expect(result.status, result.stderr).toBe(0)
    return readFileSync(output, 'utf8').trim()
  }
  let start = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ios-planted-decide-'))
    git('init', '-q')
    write('README.md')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    start = git('rev-parse', 'HEAD')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs when a pull request or a push changes the lane\'s own files', () => {
    expect(decide('pull_request', ['desktop/web/e2e/platform/phones/ios/smoke.spec.ts'], start)).toBe('run=true')
    expect(decide('push', ['.github/workflows/phone-smoke.yml'], start)).toBe('run=true')
    expect(decide('pull_request', ['desktop/web/package.json'], start)).toBe('run=true')
  })

  it('skips the planted page when a change touches only what the smoke loads', () => {
    expect(decide('pull_request', ['desktop/web/src/app.tsx', 'desktop/tauri.conf.json'], start)).toBe('run=false')
  })

  it('runs on the schedule and a dispatch, and when the base is unknown or cannot be fetched', () => {
    expect(decide('schedule', ['desktop/web/src/app.tsx'], start)).toBe('run=true')
    expect(decide('workflow_dispatch', [], start)).toBe('run=true')
    expect(decide('push', ['desktop/web/src/app.tsx'], '0000000000000000000000000000000000000000')).toBe('run=true')
    expect(decide('pull_request', ['desktop/web/src/app.tsx'], 'f'.repeat(40))).toBe('run=true')
  })
})

// On a cache hit the job restores the WebDriverAgent build and the session runs it as is; on a miss build-wda builds it
// first, and the session runs that build: either way the job names its derived data (canopi-f47t.52.240).
describe('the session runs the WebDriverAgent the job built or restored (canopi-f47t.52.240)', () => {
  const KEYS = ['CANOPI_IOS_DEVICE', 'CANOPI_IOS_VERSION', 'CANOPI_IOS_UDID', 'CANOPI_WDA_DERIVED_DATA'] as const
  let saved: Partial<Record<(typeof KEYS)[number], string>> = {}
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  })
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  /** The Safari capabilities wdio.ios.conf.ts gives with `derivedData` named by the job, or none. */
  const capabilities = async (derivedData?: string) => {
    Object.assign(process.env, { CANOPI_IOS_DEVICE: 'iPhone 17', CANOPI_IOS_VERSION: '26.1', CANOPI_IOS_UDID: 'UDID-1' })
    if (derivedData) process.env['CANOPI_WDA_DERIVED_DATA'] = derivedData
    else delete process.env['CANOPI_WDA_DERIVED_DATA']
    vi.resetModules()
    // Not followed by TypeScript, as the spec above: the config type-checks in its own project (e2e/platform).
    const conf: string = '../../e2e/platform/phones/ios/wdio.ios.conf'
    const { config } = await import(/* @vite-ignore */ conf) as { config: { capabilities: Record<string, unknown>[] } }
    return config.capabilities[0] ?? {}
  }

  it('runs the prebuilt WebDriverAgent from the derived data the job names, without rebuilding it', async () => {
    const safari = await capabilities('/Users/runner/Library/Developer/Xcode/DerivedData/WebDriverAgent-abc')
    expect(safari['appium:usePrebuiltWDA']).toBe(true)
    expect(safari['appium:derivedDataPath']).toBe('/Users/runner/Library/Developer/Xcode/DerivedData/WebDriverAgent-abc')
  })

  it('lets the driver build WebDriverAgent itself when no job named a build', async () => {
    const safari = await capabilities()
    expect(safari).not.toHaveProperty('appium:usePrebuiltWDA')
    expect(safari).not.toHaveProperty('appium:derivedDataPath')
    expect(safari['appium:udid']).toBe('UDID-1')
  })
})
