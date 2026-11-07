// The one IPC transport (contracts §2, design check F15): every native command goes through it, a command error
// that is still a String reaches the failure ring as `native_untyped` with its text redacted, and only a typed
// `cancelled` code is a cancel. ipc/transport.ts arrives in 1b-c2; until then these tests fail on its absence.
import { describe, expect, it } from 'vitest'

type TransportModule = Record<string, unknown>

async function loadTransport(): Promise<TransportModule> {
  const loaders = import.meta.glob<TransportModule>('./transport.ts')
  const load = loaders['./transport.ts']
  expect(load, 'ipc/transport.ts, the one IPC transport').toBeDefined()
  return load!()
}

describe('IPC transport', () => {
  it.fails('[1b-c2 canopi-f47t.52.36] native_untyped: a String command error naming a UNC and a home path reaches the ring redacted', async () => {
    const transport = await loadTransport()
    expect(typeof transport.invokeCommand).toBe('function')
  })

  it.fails('[1b-c2 canopi-f47t.52.172] canopi-f47t.52.172: an error whose text contains cancelled shows its message', async () => {
    const transport = await loadTransport()
    expect(typeof transport.isCancelledFailure).toBe('function')
    const isCancelled = transport.isCancelledFailure as (error: unknown) => boolean
    // A real failure whose English happens to say "cancelled" is a failure to show, not a user cancel.
    expect(isCancelled(new Error('The export was cancelled by the operating system: disk full'))).toBe(false)
  })
})
