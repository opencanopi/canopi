import { afterEach, describe, expect, it } from 'vitest'
import { installCommandTransport } from '../types/command-transport'
import { deliverFileBytes } from './bytes'

const MAX_DELIVER_FILE_BYTES = 64 * 1024 * 1024

describe('deliverFileBytes (2.1-M154)', () => {
  let disposeTransport: (() => void) | null = null

  afterEach(() => {
    disposeTransport?.()
    disposeTransport = null
  })

  it('refuses payloads over 64 MiB before invoking IPC', async () => {
    let called = false
    disposeTransport = installCommandTransport(async () => {
      called = true
      return '/out.pdf'
    })
    const oversized = new Uint8Array(MAX_DELIVER_FILE_BYTES + 1)
    await expect(deliverFileBytes('pdf', '/out.pdf', oversized)).rejects.toThrow(/64 MiB/)
    expect(called).toBe(false)
  })

  it('sends raw Uint8Array bytes and encoded headers for payloads within the cap', async () => {
    let seen: unknown = null
    disposeTransport = installCommandTransport(async (command, args) => {
      seen = { command, args }
      return '/tmp/Café.pdf'
    })
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    await expect(deliverFileBytes('pdf', '/tmp/Café.pdf', bytes)).resolves.toBe('/tmp/Café.pdf')
    expect(seen).toEqual({
      command: 'deliver_file',
      args: {
        bytes,
        headers: {
          'x-canopi-delivery-kind': 'pdf',
          'x-canopi-delivery-path': encodeURIComponent('/tmp/Café.pdf'),
        },
      },
    })
  })
})
