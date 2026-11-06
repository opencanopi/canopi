/**
 * The test run is deterministic (ADR 0028 Flakes, fixed seeds): files and tests
 * run in a seeded random order whose seed is pinned unless CANOPI_TEST_SEED
 * names another, every test asserts, and fast-check runs from a pinned seed
 * (CANOPI_FC_SEED) with a fixed number of runs and a per-run limit. The seed lane's planted job selects its
 * fixture alone.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import type { ConfigEnv, UserConfig } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import viteConfig from '../../../vite.config'
import { fastCheckSettings } from './fast-check-setup'

type TestConfig = NonNullable<UserConfig['test']>

const WEB_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

async function testConfig(): Promise<TestConfig> {
  const environment: ConfigEnv = { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false }
  const config = await Promise.resolve(typeof viteConfig === 'function' ? viteConfig(environment) : viteConfig)
  return config.test!
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('test run determinism', () => {
  it('shuffles files and tests', async () => {
    expect((await testConfig()).sequence?.shuffle).toEqual({ files: true, tests: true })
  })

  it('pins the shuffle seed, and reads CANOPI_TEST_SEED only when it is set', async () => {
    vi.stubEnv('CANOPI_TEST_SEED', undefined)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const pinned = (await testConfig()).sequence?.seed
    vi.setSystemTime(new Date('2027-06-01T00:00:00Z'))
    expect((await testConfig()).sequence?.seed).toBe(pinned)
    expect(Number.isSafeInteger(pinned)).toBe(true)
    vi.stubEnv('CANOPI_TEST_SEED', '1234')
    expect((await testConfig()).sequence?.seed).toBe(1234)
    vi.stubEnv('CANOPI_TEST_SEED', 'tomorrow')
    await expect(testConfig()).rejects.toThrow('CANOPI_TEST_SEED must be a whole number, got "tomorrow"')
  })

  it('fails a test that asserts nothing', async () => {
    expect((await testConfig()).expect?.requireAssertions).toBe(true)
  })

  it('runs the fast-check setup after the Preact after-paint setup', async () => {
    expect((await testConfig()).setupFiles).toEqual(['./src/__tests__/support/preact-after-paint.ts', './src/__tests__/support/fast-check-setup.ts'])
  })

  it('runs fast-check from a pinned seed, or CANOPI_FC_SEED when set, with fixed runs and a per-run limit', () => {
    const pinned = fastCheckSettings(undefined)
    expect(fc.readConfigureGlobal()).toMatchObject(process.env.CANOPI_FC_SEED ? fastCheckSettings(process.env.CANOPI_FC_SEED) : pinned)
    expect(Number.isSafeInteger(pinned.seed)).toBe(true)
    expect(pinned.numRuns).toBeGreaterThan(0)
    expect(pinned.timeout).toBeGreaterThan(0)
    expect(fastCheckSettings('77')).toEqual({ ...pinned, seed: 77 })
    expect(() => fastCheckSettings('x1')).toThrow('CANOPI_FC_SEED must be a whole number, got "x1"')
  })

  // Vitest 5 passes no `--dir` to a project, so `-- --dir <fixtures>` ran the whole suite once vite.config.ts had
  // projects and the planted order-dependent test never ran (PR #87).
  it('canopi-f47t.52.228.54: the seed lane\'s planted job runs its fixture alone', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/seed-lane.yml', import.meta.url), 'utf8')
    const planted = workflow.slice(workflow.indexOf('\n  planted:\n'), workflow.indexOf('\n  proptest:\n'))
    expect(planted).toContain('CANOPI_TEST_DIR: ../../policy/fixtures/seed-lane\n')
    // The web project alone, with Vitest's JSON report beside the console one: the step's verdict reads that report,
    // which names the planted test the same coloured or not (canopi-f47t.52.228.54).
    expect(planted).toContain('npm run test:seed-lane -- --project web --reporter=default --reporter=json \\\n'
      + '            --outputFile.json="$RUNNER_TEMP/planted.json" 2>&1')
    expect(planted).toContain('process.exit(failed.includes("order-dependent.test.ts > runs the second step") ? 0 : 1)')
    expect(planted).toContain('\' "$RUNNER_TEMP/planted.json" || {')
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')))
    const list = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--project', 'web'], {
      cwd: WEB_ROOT, encoding: 'utf8', timeout: 60_000, env: { ...env, CANOPI_TEST_DIR: '../../policy/fixtures/seed-lane' },
    })
    expect(list.status, list.stderr).toBe(0)
    expect(list.stdout.split('\n').filter((line) => line.startsWith('['))).toEqual(['[web] ../../policy/fixtures/seed-lane/order-dependent.test.ts'])
  }, 60_000)
})
