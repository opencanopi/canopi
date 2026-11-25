import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requestSaveDecision: vi.fn(),
  presentOpenFailure: vi.fn(),
}))

vi.mock('../app/document-session/save-problem', () => ({
  requestSaveProblemDecision: mocks.requestSaveDecision,
}))

vi.mock('../app/document-session/open-failure', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenFailureModule>()
  return {
    ...actual,
    presentDesignOpenFailure: (error: unknown) => mocks.presentOpenFailure(actual.designOpenFailureNoticeOf(error)),
  }
})

import {
  designRevertAvailable,
  designSaveStatus,
  newDesignAction,
  openDesign,
  openDesignFromPath,
  revertDesign,
  saveCurrentDesign,
} from '../app/document-session/actions'
import { designSessionStore } from '../app/document-session/store'
import { newDesignDefaults } from '../app/settings/state'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { installEditionPorts } from '../platform/edition-ports'
import type { PickFileOutcome } from '../platform/file-access'
import type { CanopiFile } from '../types/design'
import { createTestEditionPorts } from './support/test-edition-ports'
import { createTestSessionCore, type TestSessionCoreHandle } from './support/session-core-fixture'
import { currentDesign, designName, designPath } from './support/design-session-state'
import type * as OpenFailureModule from '../app/document-session/open-failure'

function makeFile(name: string, overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-03-29T00:00:00.000Z',
    updated_at: '2026-03-29T00:00:00.000Z',
    extra: {},
    ...overrides,
  }
}

let handle: TestSessionCoreHandle
let disposePorts: (() => void) | null = null
let pickOpenMock: ReturnType<typeof vi.fn<(kind: 'canopi') => Promise<PickFileOutcome>>>

const DISK_FULL = {
  kind: 'failed' as const,
  failure: { code: { kind: 'io' as const, io: 'other' as const }, op: 'design.write', operation: 'design.write' as never, detail: 'disk full' as never, user_may_retry: true },
}

function readQuestion() {
  const state = handle.core.state.value
  return state.kind === 'closing' || state.kind === 'replacing' ? state.question ?? null : null
}

beforeEach(() => {
  mocks.requestSaveDecision.mockReset()
  mocks.requestSaveDecision.mockResolvedValue('cancel')
  mocks.presentOpenFailure.mockReset()
  pickOpenMock = vi.fn<(kind: 'canopi') => Promise<PickFileOutcome>>(async () => ({ kind: 'cancelled' as const }))
  disposePorts = installEditionPorts(createTestEditionPorts({
    fileAccess: {
      pickOpen: pickOpenMock,
      pickHomeTarget: async () => ({ kind: 'cancelled' as const }),
    },
  }))
  handle = createTestSessionCore({
    file: makeFile('Current'),
    path: '/designs/current.canopi',
    name: 'Current',
    newDesignFactory: () => makeFile('Untitled'),
  })
})

afterEach(() => {
  handle.dispose()
  disposePorts?.()
  disposePorts = null
  newDesignDefaults.value = { satellite: false, symbolScale: 1, labels: 'names' }
  mapLayers.value = createDefaultMapLayers()
})

describe('document replacement actions', () => {
  it('writes a dirty Design to its file home, then replaces it without asking', async () => {
    handle.core.document('edit', () => ({ description: 'edited' }))
    handle.home.seedFile('/designs/next.canopi', makeFile('Next'))

    await openDesignFromPath('/designs/next.canopi')

    expect(mocks.requestSaveDecision).not.toHaveBeenCalled()
    const saved = handle.home.files.get('/designs/current.canopi')
    expect(JSON.parse(new TextDecoder().decode(saved!.bytes))).toMatchObject({ name: 'Current', description: 'edited' })
    expect(currentDesign.value?.name).toBe('Next')
    expect(designName.value).toBe('Next')
    expect(designPath.value).toBe('/designs/next.canopi')
  })

  it('keeps the current Design when its write fails and the user cancels', async () => {
    handle.core.document('edit', () => ({ description: 'edited' }))
    handle.home.setWriteResult(DISK_FULL)
    handle.home.seedFile('/designs/next.canopi', makeFile('Next'))

    const opening = openDesignFromPath('/designs/next.canopi')
    await vi.waitFor(() => {
      expect(readQuestion()).not.toBeNull()
    })
    handle.core.answer(readQuestion()!.id, 'cancel')
    await opening

    expect(currentDesign.value?.name).toBe('Current')
    expect(designPath.value).toBe('/designs/current.canopi')
  })

  it('discards unwritable changes only when the user chooses to', async () => {
    handle.core.document('edit', () => ({ description: 'edited' }))
    handle.home.setWriteResult(DISK_FULL)
    handle.home.seedFile('/designs/next.canopi', makeFile('Next'))

    const opening = openDesignFromPath('/designs/next.canopi')
    await vi.waitFor(() => {
      expect(readQuestion()).not.toBeNull()
    })
    handle.core.answer(readQuestion()!.id, 'discard')
    await opening

    expect(currentDesign.value?.name).toBe('Next')
  })

  it('propagates load failures without replacing the document', async () => {
    await expect(openDesignFromPath('/designs/missing.canopi')).rejects.toThrow()

    expect(currentDesign.value?.name).toBe('Current')
    expect(mocks.presentOpenFailure).toHaveBeenCalledTimes(1)
  })

  it('opens from the file dialog while the canvas session is detached', async () => {
    handle.home.seedFile('/designs/dialog.canopi', makeFile('Dialog Pick'))
    pickOpenMock.mockResolvedValueOnce({ kind: 'picked' as const, grant: '/designs/dialog.canopi' })

    await openDesign()

    expect(pickOpenMock).toHaveBeenCalledTimes(1)
    expect(currentDesign.value?.name).toBe('Dialog Pick')
    expect(designName.value).toBe('Dialog Pick')
    expect(designPath.value).toBe('/designs/dialog.canopi')
  })

  it('creates a new design while the canvas session is detached', async () => {
    await newDesignAction()

    expect(currentDesign.value?.name).toBe('Untitled')
    expect(designName.value).toBe('Untitled')
    expect(designPath.value).toBe(null)
    expect(handle.core.currentDesign.value?.home.kind).toBe('draft')
    expect(designSaveStatus.value).toBe('draft')
  })

  it('starts a new Design with the Settings › New Designs background and never touches an opened one', async () => {
    newDesignDefaults.value = { satellite: true, symbolScale: 1.5, labels: 'codes' }
    mapLayers.value = createDefaultMapLayers()

    await newDesignAction()
    expect(mapLayers.value.satellite.visible).toBe(true)

    mapLayers.value = createDefaultMapLayers()
    handle.home.seedFile('/designs/kept.canopi', makeFile('Kept'))
    await openDesignFromPath('/designs/kept.canopi')
    expect(currentDesign.value?.name).toBe('Kept')
    expect(mapLayers.value.satellite.visible).toBe(false)
  })

  it('saves the canonical document snapshot to its file when no canvas session is mounted', async () => {
    handle.core.document('rename', () => ({ name: 'Detached' }))

    await expect(saveCurrentDesign()).resolves.toBe(true)

    const saved = handle.home.files.get('/designs/current.canopi')
    expect(JSON.parse(new TextDecoder().decode(saved!.bytes))).toMatchObject({ name: 'Detached' })
    expect(designName.value).toBe('Detached')
    expect(designSessionStore.isDesignDirty()).toBe(false)
  })

  it('saves a draft home with Save As, then forgets the draft', async () => {
    await newDesignAction()
    handle.core.document('edit', () => ({ description: 'draft edit' }))
    await handle.core.flushNow()
    const draftHome = handle.core.currentDesign.value?.home
    expect(draftHome?.kind).toBe('draft')
    const draftKey = draftHome!.key
    expect(handle.home.files.has(draftKey)).toBe(true)

    handle.fileAccess.setPickHomeTarget({ kind: 'picked', grant: '/designs/saved.canopi' })
    await expect(saveCurrentDesign()).resolves.toBe(true)

    expect(designPath.value).toBe('/designs/saved.canopi')
    expect(handle.home.files.has('/designs/saved.canopi')).toBe(true)
    expect(handle.home.files.has(draftKey)).toBe(false)
  })

  it('reverts to the version opened and writes it back to the file', async () => {
    handle.home.seedFile('/designs/opened.canopi', makeFile('Opened', { description: 'as opened' }))
    await openDesignFromPath('/designs/opened.canopi')
    expect(designRevertAvailable.value).toBe(false)

    handle.core.document('edit', () => ({ description: 'edited' }))
    await handle.core.flushNow()
    expect(designRevertAvailable.value).toBe(true)
    mocks.requestSaveDecision.mockResolvedValueOnce('revert')

    await revertDesign()
    await handle.core.flushNow()

    expect(currentDesign.value?.description).toBe('as opened')
    expect(designPath.value).toBe('/designs/opened.canopi')
    const saved = handle.home.files.get('/designs/opened.canopi')
    expect(JSON.parse(new TextDecoder().decode(saved!.bytes))).toMatchObject({ description: 'as opened' })
  })
})
