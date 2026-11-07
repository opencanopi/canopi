// The one TS redactor runs the shared corpus Rust runs (contracts §13 Redaction, 2.1-M434) and keeps text with nothing
// to redact. failures/redact.ts arrives in 1b-c1; until then these tests fail on its absence.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import shared from '../../../../canopi-types/fixtures/redaction/shared.json'

type Redact = (text: string) => string

async function loadRedact(): Promise<Redact> {
  const loaders = import.meta.glob<Record<string, unknown>>('./redact.ts')
  const load = loaders['./redact.ts']
  expect(load, 'failures/redact.ts, the one TS redactor').toBeDefined()
  const module = await load!()
  expect(typeof module.redact).toBe('function')
  return module.redact as Redact
}

describe('TS redaction', () => {
  it.fails('[1b-c1 canopi-f47t.52.37] redaction corpus: shared cases redact to their expected text', async () => {
    const redact = await loadRedact()
    const wrong = shared.cases.filter((c) => redact(c.input) !== c.expected).map((c) => `${c.id} (${c.shape})`)
    expect(wrong).toEqual([])
  })

  it.fails('[1b-c1 canopi-f47t.52.37] redaction keeps text with nothing to redact and is idempotent', async () => {
    const redact = await loadRedact()
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z0-9 ,.;!?()-]{0,80}$/), (text) => redact(text) === text))
    fc.assert(fc.property(fc.string(), (text) => redact(redact(text)) === redact(text)))
  })
})
