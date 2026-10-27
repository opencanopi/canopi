import { describe, expect, it, vi } from 'vitest'
import type { ConfigEnv, UserConfig } from 'vite'

// Where the policy families' values reach the tools that enforce them (2.1-M217).
describe('policy wiring', () => {
  it('runs vitest coverage over the include, exclusions and floors of policy/ratchets/coverage.json (2.1-M217)', async () => {
    vi.resetModules()
    const planted = { include: ['planted/**'], exclude: ['planted/x.ts'], floors: { statements: 1, branches: 2, functions: 3, lines: 4 } }
    vi.doMock('../../../../policy/ratchets/coverage.json', () => ({ default: { floors: { vitest: planted } } }))
    try {
      const { default: config } = await import('../../vite.config')
      const resolved = (typeof config === 'function' ? await config({ command: 'serve', mode: 'test' } as ConfigEnv) : config) as UserConfig
      expect(resolved.test?.coverage).toMatchObject({ include: planted.include, exclude: planted.exclude, thresholds: planted.floors })
    } finally {
      vi.doUnmock('../../../../policy/ratchets/coverage.json')
      vi.resetModules()
    }
  }, 60_000)
})
