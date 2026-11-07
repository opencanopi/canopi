// The one TS report builder over REPORT_SECTIONS (contracts §13 Failure report, 2.1-M421, 2.1-M422): Desktop and Web
// build the same sections, every catalogue code reaches the report, and a report opened from a failure leads with
// it. app/problem-report/builder.ts arrives in 1b-c5; until then these tests fail on its absence.
import { describe, expect, it } from 'vitest'

type BuilderModule = Record<string, unknown>

async function loadBuilder(): Promise<BuilderModule> {
  const loaders = import.meta.glob<BuilderModule>('./builder.ts')
  const load = loaders['./builder.ts']
  expect(load, 'app/problem-report/builder.ts, the one report builder').toBeDefined()
  return load!()
}

describe('problem report builder', () => {
  it.fails('[1b-c5 canopi-f47t.52.37] every_code_reaches_the_report', async () => {
    const builder = await loadBuilder()
    expect(typeof builder.buildProblemReport).toBe('function')
  })

  it.fails('[1b-c5 canopi-f47t.52.96] a Web problem report bundle carries Desktop\'s sections', async () => {
    const builder = await loadBuilder()
    expect(typeof builder.buildProblemReport).toBe('function')
  })

  it.fails('[1b-c5 canopi-f47t.52.37] a report opened from a failure lists its code and operation first', async () => {
    const builder = await loadBuilder()
    expect(typeof builder.buildProblemReport).toBe('function')
  })
})
