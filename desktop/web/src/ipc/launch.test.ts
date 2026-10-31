import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribePendingOpen, takePendingOpen } from './launch'

const invoke = vi.hoisted(() => vi.fn(async (_command: string): Promise<unknown> => null))
const unlisten = vi.hoisted(() => vi.fn())
const listen = vi.hoisted(() => vi.fn(async (_event: string, _handler: () => void) => unlisten))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

describe('the launch file wire (canopi-f47t.52.228.14)', () => {
  beforeEach(() => {
    invoke.mockClear()
    listen.mockClear()
    unlisten.mockClear()
  })

  it('pulls the pending-open slot with take_pending_open', async () => {
    invoke.mockResolvedValueOnce({ path: '/home/g.canopi', several: true })

    await expect(takePendingOpen()).resolves.toEqual({ path: '/home/g.canopi', several: true })
    expect(invoke).toHaveBeenCalledWith('take_pending_open')
  })

  it('hears the payload-free launch:pending-open event, and once when listening starts, until unsubscribed', async () => {
    const onPending = vi.fn()
    const unsubscribe = subscribePendingOpen(onPending)
    await vi.waitFor(() => expect(listen).toHaveBeenCalledWith('launch:pending-open', expect.any(Function)))

    await vi.waitFor(() => expect(onPending).toHaveBeenCalledTimes(1))
    listen.mock.calls[0]![1]()
    expect(onPending).toHaveBeenCalledTimes(2)

    unsubscribe()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
  })

  it('unsubscribing before the listener is set up still removes it', async () => {
    const unsubscribe = subscribePendingOpen(vi.fn())
    unsubscribe()

    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
  })

  it('a listener that cannot be set up is logged, never an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    listen.mockRejectedValueOnce(new Error('no webview'))

    const unsubscribe = subscribePendingOpen(vi.fn())
    unsubscribe()

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('The launch file listener could not be set up:', expect.any(Error)))
    expect(unlisten).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
