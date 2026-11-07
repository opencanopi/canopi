// The one notice row is an ordered queue (contracts §13; design check A17): a notice raised during boot is not
// replaced by the next. failures/notices.ts arrives in 1b-c3; until then this test fails on its absence.
import { describe, expect, it } from 'vitest'

describe('notice queue', () => {
  it.fails('[1b-c3 canopi-f47t.52.107] canopi-f47t.52.107: a notice raised during boot survives the next notice', async () => {
    const loaders = import.meta.glob<Record<string, unknown>>('./notices.ts')
    const load = loaders['./notices.ts']
    expect(load, 'failures/notices.ts, the one notice queue').toBeDefined()
    const notices = await load!()
    expect(typeof notices.raiseNotice).toBe('function')
  })
})
