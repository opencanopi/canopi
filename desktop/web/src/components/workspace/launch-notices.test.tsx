// @vitest-environment jsdom
// The Desktop root's update notices on the one notice row (2.1-Q254, Q290, Q293), through the real update controller,
// notice queue and row; fakes stand only at the host's update commands and the exit flush.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locale } from '../../app/settings/state'
import { closeWaitsFor } from '../../app/shell/close-guard'
import { createUpdateController, type UpdateController } from '../../app/updates/controller'
import { resetNoticesForTests } from '../../failures/notices'
import type { UpdateOffer, UpdateOs } from '../../generated/contracts'
import { NoticeRow } from '../shared/NoticeRow'
import { raiseLaunchNotices, raiseUpdateNotice, withdrawUpdateNoticeOnInstall } from './launch-notices'

const OFFER: UpdateOffer = { version: '2.1.0', date: '2026-11-02', notes_url: 'https://github.com/opencanopi/canopi/releases/tag/v2.1.0' }
const never = <T,>() => new Promise<T>(() => {})

let container: HTMLDivElement
let disposers: (() => void)[] = []

beforeEach(() => {
  locale.value = 'en'
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  for (const dispose of disposers) dispose()
  disposers = []
  closeWaitsFor.value = null
  resetNoticesForTests()
})

/** A controller holding the launch check's offer, downloaded and verified, with its notice on the row. */
async function verifiedOffer(platform: UpdateOs): Promise<UpdateController> {
  let id = 0
  const controller = createUpdateController({
    updater: {
      checkForUpdate: () => Promise.resolve(OFFER),
      downloadUpdate: () => Promise.resolve({ kind: 'verified' }),
      installUpdate: () => never<void>(),
      cancelUpdate: () => Promise.resolve(),
      restartAfterUpdate: () => never<void>(),
      getLaunchCheck: () => Promise.resolve(true),
    },
    platform,
    // The exit flush runs on: the Windows installer is what keeps Canopi waiting.
    flushBeforeExit: () => Promise.resolve('proceed'),
    holdCloseUntilSettled: () => () => true,
    mintOperationId: () => `op-${++id}`,
    currentDesignPath: () => null,
    onUpdateAvailable: raiseUpdateNotice,
  })
  disposers.push(withdrawUpdateNoticeOnInstall(controller), raiseLaunchNotices())
  await act(async () => { render(<NoticeRow />, container) })
  await act(async () => { await controller.launchCheck() })
  await act(async () => { await controller.download() })
  return controller
}

function row() {
  const shown = container.querySelector<HTMLElement>('[data-notice-row]')
  return { key: shown?.dataset.noticeKey ?? null, count: container.querySelector('[data-notice-count]')?.textContent ?? null }
}

describe('launch notices', () => {
  it('[canopi-f47t.52.36] a downloaded offer stays on the row until its install starts (2.1-Q293)', async () => {
    await verifiedOffer('linux')
    expect(row()).toEqual({ key: 'update.available', count: null })
  })

  it('[canopi-f47t.52.36] on Windows a close waiting for the update\'s exit shows Finishing update…, never a stale offer behind it (2.1-Q254)', async () => {
    const controller = await verifiedOffer('windows')
    await act(async () => { void controller.install(); await Promise.resolve() })
    // The close guard names the run a window close now waits for.
    await act(async () => { closeWaitsFor.value = 'exit' })
    expect({ ...row(), text: container.textContent }).toEqual({ key: 'update.closing', count: null, text: 'Finishing update…' })
  })

  it('[canopi-f47t.52.36] on Linux a close during the install shows Installing update…, never a stale offer behind it (2.1-Q254)', async () => {
    const controller = await verifiedOffer('linux')
    await act(async () => { void controller.install(); await Promise.resolve() })
    await act(async () => { closeWaitsFor.value = 'install' })
    expect({ ...row(), text: container.textContent }).toEqual({ key: 'update.closing', count: null, text: 'Installing update…' })
  })

  it('[canopi-f47t.52.36] the closing notice offers no Dismiss, since nothing would raise it again while the close waits (2.1-Q254)', async () => {
    disposers.push(raiseLaunchNotices())
    await act(async () => { render(<NoticeRow />, container) })
    await act(async () => { closeWaitsFor.value = 'exit' })
    expect({ key: row().key, buttons: container.querySelectorAll('[data-notice-row] button').length }).toEqual({ key: 'update.closing', buttons: 0 })
  })
})
