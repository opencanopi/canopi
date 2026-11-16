// @vitest-environment jsdom
//
// Phase 2 commit 0: 2.1-Q344, written before 2a-3 builds it (it.fails until then). Desktop chooses its layout with
// Web's classifier: a Desktop window under 640 px wide, or short and wide, uses the phone layout. The Desktop root
// today never installs the classifier. 2a-3 turns it.fails into it.

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The map needs WebGL, which jsdom lacks; the layout classifier does not look at it.
vi.mock('../components/panels/CanvasPanel', () => ({ CanvasPanel: () => null }))

import { App, type DesktopUpdatePorts } from '../app'
import { phoneLayout } from '../app/shell/phone-layout'

/** A host with no update to offer and the launch check off: every port answers at once with nothing. */
const nothing = () => Promise.resolve()
const NO_UPDATES: DesktopUpdatePorts = {
  updater: {
    checkForUpdate: () => Promise.resolve(null), downloadUpdate: () => new Promise(() => {}), installUpdate: nothing,
    cancelUpdate: nothing, restartAfterUpdate: nothing, getLaunchCheck: () => Promise.resolve(false),
  },
  setLaunchCheck: nothing, takeLaunchNotice: () => Promise.resolve(false), mintOperationId: () => 'op',
}

const container = document.createElement('div')

function resizeWindow(width: number, height: number): void {
  Object.assign(window, { innerWidth: width, innerHeight: height })
  window.dispatchEvent(new Event('resize'))
}

afterEach(() => {
  render(null, container)
  container.remove()
  phoneLayout.value = null
  resizeWindow(1024, 768)
})

describe('2.1-Q344 the Desktop layout classifier', () => {
  it.fails('Q344 (2a-3): a Desktop window 600 px wide uses the phone layout, and a short wide one the landscape phone layout', async () => {
    resizeWindow(600, 800)
    document.body.appendChild(container)
    await act(async () => {
      render(<App updates={NO_UPDATES} dismissStoreNoticeOnHost={async () => {}} />, container)
    })
    expect(phoneLayout.value).toBe('portrait')

    await act(async () => { resizeWindow(900, 420) })
    expect(phoneLayout.value).toBe('landscape')
    await act(async () => { resizeWindow(1200, 800) })
    expect(phoneLayout.value).toBeNull()
  })
})
