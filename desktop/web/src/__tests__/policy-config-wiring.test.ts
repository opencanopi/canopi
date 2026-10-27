import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigEnv, UserConfig } from 'vite'
import { parse } from 'yaml'

interface WorkflowStep { readonly run?: string }
interface WorkflowJob { readonly needs?: string | readonly string[], readonly if?: string, readonly steps?: readonly WorkflowStep[] }
interface Workflow { readonly jobs: Readonly<Record<string, WorkflowJob>> }

const workflow = (name: string) => parse(readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), 'utf8')) as Workflow

// A step runs `npm run <script>` when it names that exact script (`build` is not `build:web`); names are [\w:-].
const runsScript = (step: WorkflowStep, script: string) => new RegExp(`\\bnpm run ${script}(?![\\w:-])`).test(step.run ?? '')

/** What keeps Build & Test from being the one required check that every job's failure reaches (2.1-Q222, 2.1-M240). */
function buildAndTestFaults({ jobs }: Workflow): string[] {
  const faults: string[] = []
  const aggregate = jobs['build-and-test']
  if (!aggregate) return ['no build-and-test job']
  const needs = new Set([aggregate.needs ?? []].flat())
  for (const job of Object.keys(jobs)) {
    if (job !== 'build-and-test' && !needs.has(job)) faults.push(`build-and-test does not need ${job}`)
  }
  for (const job of needs) if (!(job in jobs) || job === 'build-and-test') faults.push(`build-and-test needs ${job}, no other job`)
  if (aggregate.if !== 'always()') faults.push('build-and-test does not run always()')
  const steps = jobs['test-frontend']?.steps ?? []
  const last = (script: string) => Math.max(-1, ...steps.flatMap((step, index) => (runsScript(step, script) ? [index] : [])))
  const bundle = steps.findIndex((step) => runsScript(step, 'test:policies:bundle'))
  if (bundle < 0) faults.push('test-frontend runs no test:policies:bundle')
  else if (bundle < last('build') || bundle < last('build:web')) faults.push('test-frontend checks bundle sizes before both builds')
  if (last('build') < 0 || last('build:web') < 0) faults.push('test-frontend does not build both editions')
  return faults
}

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

  it('makes Build & Test need every other job, run always, and check bundle sizes after both builds (2.1-Q222, 2.1-M240)', () => {
    expect(buildAndTestFaults(workflow('build.yml'))).toEqual([])

    const planted: Workflow = {
      jobs: {
        lint: {},
        late: {},
        'test-frontend': { steps: [{ run: 'npm run build' }, { run: 'npm run test:policies:bundle' }, { run: 'npm run build:web' }] },
        'build-and-test': { needs: ['lint', 'test-frontend'], if: 'success()' },
      },
    }
    expect(buildAndTestFaults(planted)).toEqual([
      'build-and-test does not need late',
      'build-and-test does not run always()',
      'test-frontend checks bundle sizes before both builds',
    ])
    expect(buildAndTestFaults({ jobs: { 'test-frontend': { steps: [{ run: 'npm run build:web' }] }, 'build-and-test': { needs: 'test-frontend', if: 'always()' } } }))
      .toEqual(['test-frontend runs no test:policies:bundle', 'test-frontend does not build both editions'])
  })
})
