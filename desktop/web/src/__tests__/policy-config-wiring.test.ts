import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigEnv, UserConfig } from 'vite'

// Where the policy families' values reach the tools that enforce them (2.1-M217, 2.1-M232, 2.1-M240).
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

  const workflow = readFileSync(new URL('../../../../.github/workflows/build.yml', import.meta.url), 'utf8')
  /** Each job of build.yml by id, with its lines up to the next job. */
  const jobs = new Map<string, string>()
  for (const [, id, body] of workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z0-9-]+):\n((?:(?: {4}.*)?\n)*)/gm)) {
    jobs.set(id!, body!)
  }

  it('holds the bundle budgets in Build & Test once both editions are built (2.1-M240)', () => {
    const job = jobs.get('test-frontend') ?? ''
    const at = (command: string) => job.indexOf(`npm run ${command} --prefix desktop/web`)
    expect(at('build')).toBeGreaterThan(-1)
    expect(at('build:web')).toBeGreaterThan(-1)
    expect(at('test:policies:bundle')).toBeGreaterThan(Math.max(at('build'), at('build:web')))
  })

  it('ends in one always-run Build & Test job that needs every other job and fails when one failed or was cancelled', () => {
    const aggregate = [...jobs].filter(([, body]) => body.includes('name: Build & Test'))
    expect(aggregate.map(([id]) => id)).toEqual(['build-and-test'])
    const body = aggregate[0]![1]
    expect(body).toMatch(/^ {4}if: always\(\)$/m)
    const needs = /^ {4}needs: \[(.*)\]$/m.exec(body)?.[1]?.split(',').map((id) => id.trim()).sort()
    expect(needs).toEqual([...jobs.keys()].filter((id) => id !== 'build-and-test').sort())
    expect(body).toContain("contains(needs.*.result, 'failure')")
    expect(body).toContain("contains(needs.*.result, 'cancelled')")
  })
})
