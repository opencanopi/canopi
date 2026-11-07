// One message per store status and its one notice (contracts §11, design check F3). failures/health-presentation.ts
// arrives in 1b-c4; until then these tests fail on its absence.
import { describe, expect, it } from 'vitest'

async function loadPresentation(): Promise<Record<string, unknown>> {
  const loaders = import.meta.glob<Record<string, unknown>>('./health-presentation.ts')
  const load = loaders['./health-presentation.ts']
  expect(load, 'failures/health-presentation.ts, the store status messages').toBeDefined()
  return load!()
}

describe('store health presentation', () => {
  it.fails('[1b-c4 canopi-f47t.52.36] every_health_status_has_one_message', async () => {
    const presentation = await loadPresentation()
    expect(presentation.MESSAGE_BY_STATUS, 'one row per StoreOpenStatus kind').toBeDefined()
  })

  it.fails('[1b-c4 canopi-f47t.52.41] NAT-02 notice: a set-aside user DB shows one notice', async () => {
    const presentation = await loadPresentation()
    expect(typeof presentation.noticeForStore).toBe('function')
  })
})
