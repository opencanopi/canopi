// Regression tests for the iOS lane's planted blank-page step (2.1-Q247, F5 chunk 11 review findings 1a and 1b):
// the step passes only when the smoke itself fails on the blank page, and the smoke names the start screen only when
// wdio's wait timed out, so a session that never started or died mid-wait fails the step.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const WORKFLOW = new URL('../../../../.github/workflows/web-edition-browsers.yml', import.meta.url)
const STEP_NAME = '- name: The iOS lane fails on a planted blank page'

/** The planted step's shell script, as the runner reads it (the `run: |` block under the step's name). */
function plantedStepScript(): string {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === STEP_NAME.trim())
  if (start < 0) throw new Error(`no step "${STEP_NAME}" in web-edition-browsers.yml`)
  const runAt = start + 1
  if (lines[runAt]?.trim() !== 'run: |') throw new Error('the planted step has no `run: |` block next to its name')
  const body: string[] = []
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break
    body.push(line.slice(10))
  }
  return body.join('\n')
}

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
