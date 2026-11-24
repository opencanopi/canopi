import { afterEach, describe, expect, it } from 'vitest'
import { installCommandTransport } from '../../types/command-transport'
import { desktopUpdatePorts } from './updates'

describe('editions/desktop/updates launch check (Stage 2 E1, ADR 0024)', () => {
  let uninstall: (() => void) | null = null

  afterEach(() => {
    uninstall?.()
    uninstall = null
  })

  function installFakeRows(initial: Record<string, string> = {}) {
    const rows = new Map<string, string>(Object.entries(initial))
    uninstall = installCommandTransport(async (command, args) => {
      if (command === 'get_setting_row') {
        return rows.get(String(args?.key ?? '')) ?? null
      }
      if (command === 'set_setting_row') {
        rows.set(String(args?.key ?? ''), String(args?.value ?? ''))
        return undefined
      }
      throw new Error(`unexpected command ${command}`)
    })
    return rows
  }

  it('defaults to true when missing and round-trips through the opaque key row', async () => {
    const rows = installFakeRows()
    await expect(desktopUpdatePorts.updater.getLaunchCheck()).resolves.toBe(true)
    await desktopUpdatePorts.setLaunchCheck(false)
    expect(rows.get('updater.check_at_launch')).toBe('false')
    await expect(desktopUpdatePorts.updater.getLaunchCheck()).resolves.toBe(false)
    await desktopUpdatePorts.setLaunchCheck(true)
    expect(rows.get('updater.check_at_launch')).toBe('true')
    await expect(desktopUpdatePorts.updater.getLaunchCheck()).resolves.toBe(true)
  })
})
