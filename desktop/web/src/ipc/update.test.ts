import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateFailure, UpdateProgress } from '../generated/contracts'
import {
  cancelUpdate,
  checkForUpdate,
  downloadUpdate,
  getLaunchCheck,
  installUpdate,
  restartAfterUpdate,
  setLaunchCheck,
  takeUpdateLaunchNotice,
} from './update'

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null))

const FakeChannel = vi.hoisted(
  () =>
    class FakeChannel<T> {
      onmessage: (message: T) => void = () => undefined
    },
)
type FakeChannel<T> = InstanceType<typeof FakeChannel<T>>

vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: FakeChannel }))

describe('the updater wire (canopi-f47t.52.228.15, 2.1-M241)', () => {
  beforeEach(() => invoke.mockReset())

  it('asks update_check and returns the offer, or null when there is none', async () => {
    const offer = { version: '2.1.0', date: null, notes_url: 'https://github.com/opencanopi/canopi/releases/tag/v2.1.0' }
    invoke.mockResolvedValueOnce(offer).mockResolvedValueOnce(null)

    await expect(checkForUpdate()).resolves.toEqual(offer)
    await expect(checkForUpdate()).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledWith('update_check')
  })

  it('asks update_download with a progress channel whose messages reach the caller', async () => {
    const heard: UpdateProgress[] = []
    invoke.mockImplementationOnce(async (_command, args) => {
      const { progress } = args as { progress: FakeChannel<UpdateProgress> }
      progress.onmessage({ received: 512, total: 1024 })
      progress.onmessage({ received: 1024, total: 1024 })
      return { kind: 'verified' }
    })

    await expect(downloadUpdate((progress) => heard.push(progress))).resolves.toEqual({ kind: 'verified' })
    expect(invoke).toHaveBeenCalledWith('update_download', { progress: expect.any(FakeChannel) })
    expect(heard).toEqual([
      { received: 512, total: 1024 },
      { received: 1024, total: 1024 },
    ])
  })

  it('passes an update failure on as the rejection', async () => {
    const failure: UpdateFailure = {
      code: { kind: 'update_signature_refused' },
      user_may_retry: false,
      op: 'updater.download',
      detail: 'the signature did not verify',
    }
    invoke.mockRejectedValueOnce(failure)

    await expect(downloadUpdate(() => undefined)).rejects.toBe(failure)
  })

  it('names the install, cancel and restart commands, the restart with the Design path or null', async () => {
    await installUpdate()
    await cancelUpdate()
    await restartAfterUpdate('/home/garden.canopi')
    await restartAfterUpdate(null)

    expect(invoke.mock.calls).toEqual([
      ['update_install'],
      ['update_cancel'],
      ['update_restart', { designPath: '/home/garden.canopi' }],
      ['update_restart', { designPath: null }],
    ])
  })

  it('reads and writes the launch check, and takes the launch notice', async () => {
    invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(undefined).mockResolvedValueOnce(false)

    await expect(getLaunchCheck()).resolves.toBe(true)
    await setLaunchCheck(false)
    await expect(takeUpdateLaunchNotice()).resolves.toBe(false)

    expect(invoke.mock.calls).toEqual([
      ['update_launch_check_get'],
      ['update_launch_check_set', { on: false }],
      ['update_take_launch_notice'],
    ])
  })
})
