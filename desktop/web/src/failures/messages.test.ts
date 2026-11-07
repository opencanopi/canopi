// Every catalogue code maps to one message or is silent (contracts §2, §13; 2.1-M418). failures/messages.ts arrives in
// 1b-c1; until then this test fails on its absence.
import { describe, expect, it } from 'vitest'

type MessagesModule = Record<string, unknown>

describe('failure messages', () => {
  it.fails('[1b-c1 canopi-f47t.52.35] every_code_has_a_message_or_is_silent', async () => {
    const loaders = import.meta.glob<MessagesModule>('./messages.ts')
    const load = loaders['./messages.ts']
    expect(load, 'failures/messages.ts, the one code-to-message table').toBeDefined()
    const messages = await load!()
    expect(messages.MESSAGE_BY_CODE, 'one row per FailureCode kind').toBeDefined()
  })
})
