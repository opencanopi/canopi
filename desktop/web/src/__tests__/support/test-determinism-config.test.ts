/**
 * The test run is deterministic (ADR 0028 Flakes, fixed seeds): files and tests
 * run in a seeded random order whose seed is pinned unless CANOPI_TEST_SEED
 * names another, every test asserts, and fast-check runs from a pinned seed
 * (CANOPI_FC_SEED) with a fixed number of runs and a per-run limit.
 */
import fc from 'fast-check'
import type { ConfigEnv, UserConfig } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import viteConfig from '../../../vite.config'
import { fastCheckSettings } from '../../test-setup'

type TestConfig = NonNullable<UserConfig['test']>

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
  it('fails a test that asserts nothing', async () => {
    expect((await testConfig()).expect?.requireAssertions).toBe(true)
  })

  it('runs src/test-setup.ts after the Preact after-paint setup', async () => {
    expect((await testConfig()).setupFiles).toEqual(['./src/__tests__/support/preact-after-paint.ts', './src/test-setup.ts'])
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
})
