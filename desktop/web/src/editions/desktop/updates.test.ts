import { afterEach, describe, expect, it } from 'vitest'
import { installCommandTransport } from '../../types/command-transport'
import { desktopUpdatePorts } from './updates'

describe('editions/desktop/updates launch check (2e-2, ADR 0024/0026)', () => {
  let uninstall: (() => void) | null = null

  afterEach(() => {
    uninstall?.()
    uninstall = null
  })

  function installFakeRecord(initial: Record<string, unknown> = { version: 2 }) {
    const record: Record<string, unknown> = { ...initial }
    uninstall = installCommandTransport(async (command, args) => {
      if (command === 'get_settings_record') {
        return { record: { ...record }, reset_fields: [], newer_read_only: false }
      }
      if (command === 'patch_settings_record') {
        const patch = (args?.patch ?? {}) as Record<string, unknown>
        Object.assign(record, patch)
        return undefined
      }
      throw new Error(`unexpected command ${command}`)
    })
    return record
  }

  it('defaults to true when missing and round-trips launch_check through settings record 2', async () => {
    const record = installFakeRecord()
    await expect(desktopUpdatePorts.updater.getLaunchCheck()).resolves.toBe(true)
    await desktopUpdatePorts.setLaunchCheck(false)
    expect(record.launch_check).toBe(false)
    await expect(desktopUpdatePorts.updater.getLaunchCheck()).resolves.toBe(false)
    await desktopUpdatePorts.setLaunchCheck(true)
    expect(record.launch_check).toBe(true)
    await expect(desktopUpdatePorts.updater.getLaunchCheck()).resolves.toBe(true)
  })
})
