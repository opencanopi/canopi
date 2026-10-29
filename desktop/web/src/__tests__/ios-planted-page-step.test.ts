// Regression tests for the iOS lane's planted blank-page step (2.1-Q247, F5 chunk 11 review findings 1a and 1b):
// the step passes only when the smoke itself fails on the blank page, and the smoke names the start screen only when
// wdio's wait timed out, so a session that never started or died mid-wait fails the step.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = resolve(__dirname, '../..')
const SPEC = join(WEB, 'e2e/platform/phones/ios/smoke.spec.ts')
const WORKFLOW = join(WEB, '../../.github/workflows/web-edition-browsers.yml')
const STEP_NAME = '- name: The iOS lane fails on a planted blank page'

/** The planted step's shell script, as the runner reads it (the `run: |` block under the step's name). */
function plantedStepScript(): string {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === STEP_NAME.trim())
  if (start < 0) throw new Error(`no step "${STEP_NAME}" in ${WORKFLOW}`)
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

/**
 * Runs the smoke's real test body under node with a fake @wdio/globals whose start-screen wait rejects with
 * `waitError`, and returns the message the smoke throws.
 */
function smokeFailure(waitError: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ios-smoke-'))
  const harness = join(dir, 'harness.mjs')
  writeFileSync(harness, `
import { registerHooks } from 'node:module'
const [specPath, waitError] = process.argv.slice(2)
const fake = 'data:text/javascript,' + encodeURIComponent(
  'const el = { waitForDisplayed: async () => { throw new Error(' + JSON.stringify(waitError) + ') } };' +
  'export const $ = () => el; export const browser = { url: async () => {} };' +
  'export const expect = () => { throw new Error("unreachable") };')
// The spec imports its sibling modules without an extension, as Vite resolves them; node needs the .ts added.
registerHooks({
  resolve: (s, c, next) => {
    if (s === '@wdio/globals') return { url: fake, shortCircuit: true }
    try { return next(s, c) } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.')) return next(s + '.ts', c)
      throw error
    }
  },
})
let body
globalThis.describe = (_name, fn) => fn()
globalThis.it = (_name, fn) => { body = fn }
await import(specPath)
try { await body(); process.stdout.write('') } catch (error) { process.stdout.write(error.message) }
`)
  return execFileSync(process.execPath, [harness, SPEC, waitError], {
    encoding: 'utf8',
    env: { ...process.env, CANOPI_E2E_PLANTED_PAGE: 'about:blank' },
  })
}

describe('the iOS planted blank-page step (2.1-Q247, canopi-f47t.52.228.14)', () => {
  const startScreenFailure = smokeFailure('element ("[data-start-screen]") still not displayed after 90000ms')

  it('passes when the smoke fails on the blank page itself', () => {
    expect(startScreenFailure).toBe('the start screen was not displayed 90 s after opening about:blank')
    expect(runPlantedStep(`${startScreenFailure}\n`, 1)).toBe(true)
  })

  it('fails when the smoke passes on the blank page', () => {
    expect(runPlantedStep('1 passing\n', 0)).toBe(false)
  })

  it('fails when Appium created no session (finding 1a)', () => {
    expect(runPlantedStep('ERROR webdriver: Could not create a session: WebDriverAgent did not start\n', 1)).toBe(false)
  })

  it('fails when the session dies during the start-screen wait (finding 1b)', () => {
    const died = 'waitUntil condition failed with the following reason: invalid session id'
    const failure = smokeFailure(died)
    expect(failure).toBe(died)
    expect(runPlantedStep(`${failure}\n`, 1)).toBe(false)
  })
})
