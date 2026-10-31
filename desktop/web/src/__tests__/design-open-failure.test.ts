import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadDesign: vi.fn(),
  openDesignDialog: vi.fn(),
}))

vi.mock('../ipc/design', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcDesignModule>()
  return { ...actual, loadDesign: mocks.loadDesign, openDesignDialog: mocks.openDesignDialog }
})

import { openDesign } from '../app/document-session/actions'
import {
  designOpenFailureNoticeOf,
  presentDesignOpenFailure,
  registerDesignOpenFailurePresenter,
} from '../app/document-session/open-failure'
import { locale } from '../app/settings/state'
import type * as IpcDesignModule from '../ipc/design'

const olderVersion = { kind: 'older_version', message: 'unsupported Canopi Design version 6; this build opens versions 7 to 9' }

describe('a Design that cannot be opened is told to the user', () => {
  const presenter = vi.fn()

  beforeEach(() => {
    locale.value = 'en'
    presenter.mockReset()
    registerDesignOpenFailurePresenter(presenter)
    mocks.loadDesign.mockReset()
    mocks.openDesignDialog.mockReset()
  })

  afterEach(() => {
    registerDesignOpenFailurePresenter(null)
  })

  it('turns the typed load failure into the Start-screen wording, never the raw message or a path', () => {
    expect(designOpenFailureNoticeOf(olderVersion)).toEqual({
      tone: 'error',
      title: 'Can’t open this Design',
      message: 'Made with Canopi before 2.0; Canopi 2.0 and later can’t open it',
    })
    expect(designOpenFailureNoticeOf(new Error('/home/someone/garden.canopi: boom'))).toEqual({
      tone: 'error',
      title: 'Can’t open this Design',
      message: 'Can’t read this file',
    })
  })

  it('presents a failure from the open dialog, and says nothing when the dialog is cancelled', async () => {
    mocks.openDesignDialog.mockRejectedValue({ kind: 'newer_version', message: 'newer' })
    await expect(openDesign()).rejects.toBeTruthy()
    expect(presenter).toHaveBeenCalledTimes(1)
    expect(presenter.mock.calls[0]?.[0].message).toBe('Made with a newer version of Canopi; update Canopi to open it')

    presenter.mockReset()
    mocks.openDesignDialog.mockRejectedValue(new Error('Dialog cancelled'))
    await openDesign()
    expect(presenter).not.toHaveBeenCalled()
  })

  it('is silent without a presenter', () => {
    registerDesignOpenFailurePresenter(null)
    expect(() => presentDesignOpenFailure(olderVersion)).not.toThrow()
  })
})
