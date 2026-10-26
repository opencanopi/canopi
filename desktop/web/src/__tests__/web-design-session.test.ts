// @vitest-environment jsdom

import { newDesignDefaults } from '../app/settings/state'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { effect, signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import { composeDocumentForSave } from '../app/contracts/document'
import { decodeCanopiDesign } from '../app/contracts/design-ingestion'
import { designLoadFailureOf } from '../app/contracts/canopi-design-errors'
import { createDesignSessionStore } from '../app/document-session/store'
import { CONTINUOUS_SAVE_DELAY_MS } from '../app/document-session/continuous-save'
import {
  createDesignSessionWorkflowRunner,
  type DesignSessionWorkflowRunner,
} from '../app/document-session/workflow-runner'
import {
  CanvasAuthorityBusyError,
  CanvasDocumentReplacementNotAdmittedError,
  type CanvasDocumentSurface,
  type CanvasPersistenceCapture,
  type CanvasRuntimeDocumentMetadata,
} from '../canvas/runtime/runtime'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'
import {
  browserDesignFileAdapter,
  createBrowserDesignSessionController,
  type BrowserCanopiDownload,
  type BrowserOpenedCanopiFile,
  type BrowserDesignFileAdapter,
  type BrowserPageLifecycleTarget,
} from '../web/browser-design-session'
import type { CanopiFile } from '../types/design'
import { registerDesignOpenFailurePresenter } from '../app/document-session/open-failure'
import {
  browserShellNotice,
  dismissBrowserShellNotice,
  showBrowserShellNotice,
} from '../web/browser-shell-notice'
import { t } from '../i18n'
import { createBrowserDesignTemplateImportWorkflow } from '../app/design-template-import/workflow.browser'
import { browserDraftPersistence } from '../web/browser-draft-persistence'
import {
  editDesignSessionForTest,
  markDesignSessionDirtyForTest,
} from './support/design-session-edit'

const NOW = new Date('2026-07-04T12:00:00.000Z')

describe('browser Design Session lifecycle', () => {
  it('starts a new browser Design with the Settings › New Designs defaults', async () => {
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })
    newDesignDefaults.value = { satellite: true, symbolScale: 0.5, labels: 'none' }
    mapLayers.value = createDefaultMapLayers()
    try {
      await controller.newDesign()
      expect(store.readCurrentDesign()?.extra?.plant_display).toMatchObject({ symbol_scale: 0.5, labels: 'none' })
      expect(mapLayers.value.satellite.visible).toBe(true)
    } finally {
      newDesignDefaults.value = { satellite: false, symbolScale: 1, labels: 'names' }
      mapLayers.value = createDefaultMapLayers()
    }
  })

  it('creates a browser-local Design with the canonical New Design defaults', async () => {
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })

    await controller.newDesign()

    const design = store.readCurrentDesign()
    expect(design).not.toBeNull()
    expect(store.readDesignPath()).toBeNull()
    expect(store.readDesignName()).toBe('Untitled')
    expect(store.isDesignDirty()).toBe(false)
    expect(design).not.toHaveProperty('spatial_frame')
    expect(design).toMatchObject({
      version: 9,
      name: 'Untitled',
      description: null,
      plant_species_colors: {},
      plant_species_symbols: {},
      layers: [
        { name: 'zones', visible: true, locked: false, opacity: 1 },
        { name: 'plants', visible: true, locked: false, opacity: 1 },
        { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
        { name: 'annotations', visible: true, locked: false, opacity: 1 },
      ],
      plants: [],
      zones: [],
      annotations: [],
      measurement_guides: [],
      groups: [],
      consortiums: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      extra: {},
    })
  })

  it('creates fresh layer records for each browser New Design', async () => {
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })

    await controller.newDesign()
    const first = store.readCurrentDesign()!
    await controller.newDesign()
    const second = store.readCurrentDesign()!
    const firstLayer = first.layers[0]
    const secondLayer = second.layers[0]
    if (!firstLayer || !secondLayer) throw new Error('canonical layer catalog is empty')

    expect(firstLayer).not.toBe(secondLayer)
    expect(secondLayer.visible).toBe(true)
    firstLayer.visible = false
    expect(secondLayer.visible).toBe(true)
  })

  it('composes a new browser Design as the current version through draft and download', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const downloadCanopiFile = vi.fn<(download: BrowserCanopiDownload) => Promise<void>>(
      async () => undefined,
    )
    const lastComposed: { current: CanopiFile | null } = { current: null }
    const canvas = testCanvasDocumentSurface({
      captureForPersistence: vi.fn((metadata, document) => {
        lastComposed.current = composeDocumentForSave({
          metadata,
          document,
          canvas: document,
        })
        return persistenceCapture(lastComposed.current)
      }),
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter({ downloadCanopiFile }),
      now: () => NOW,
      createDraftId: () => 'draft-canonical-new-design',
    })
    const detach = controller.attachCanvasSession(canvas)

    try {
      await controller.newDesign()
      markDesignSessionDirtyForTest(store)
      await expect(controller.continuousSave.flush()).resolves.toBe(true)

      expect(lastComposed.current?.version).toBe(9)
      expect(lastComposed.current).not.toHaveProperty('spatial_frame')
      const draft = appDataStore.loadDraft('draft-canonical-new-design')
      expect(draft?.version).toBe(9)
      expect(draft).not.toHaveProperty('spatial_frame')

      await controller.downloadCanopi()
      const download = downloadCanopiFile.mock.calls[0]?.[0]
      if (!download) throw new Error('browser download was not captured')
      const downloaded = JSON.parse(download.text) as Record<string, unknown>
      expect(downloaded.version).toBe(9)
      expect(downloaded).not.toHaveProperty('spatial_frame')
      expect(decodeCanopiDesign(downloaded).layers.find((layer) => layer.name === 'zones')?.visible).toBe(true)
    } finally {
      detach()
    }
  })

  it('opens a .canopi file as a detached browser Design and preserves future fields', async () => {
    const openedFile = makeCanopiFile({
      name: 'Loaded Garden',
      description: 'From disk',
      timeline: [{ id: 'future-action', action_type: 'other', description: 'Keep me', start_date: null, end_date: null, recurrence: null, targets: [], depends_on: null, completed: false, order: 0 }],
    }) as CanopiFile & { preserved: boolean; future_top_level: { keep: boolean } }
    // Unknown fields travel at the document root in a .canopi file.
    openedFile.preserved = true
    openedFile.future_top_level = { keep: true }
    const adapter = testFileAdapter({
      openCanopiFile: vi.fn(async () => ({
        fileName: 'loaded-garden.canopi',
        text: JSON.stringify(openedFile),
      })),
    })
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({ store, fileAdapter: adapter, now: () => NOW })

    await controller.openCanopi()

    const design = store.readCurrentDesign()
    expect(adapter.openCanopiFile).toHaveBeenCalledOnce()
    expect(store.readDesignPath()).toBeNull()
    expect(store.readDesignName()).toBe('Loaded Garden')
    expect(store.isDesignDirty()).toBe(false)
    expect(design?.timeline).toHaveLength(1)
    expect(design?.extra).toMatchObject({
      preserved: true,
      future_top_level: { keep: true },
    })
  })

  it('rejects a malformed selected Design before replacing the active session', async () => {
    const original = makeCanopiFile({ name: 'Working Garden' })
    const store = createDesignSessionStore({
      file: original,
      path: null,
      name: original.name,
    })
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(async () => ({
          fileName: 'malformed.canopi',
          text: JSON.stringify({ ...makeCanopiFile(), plants: 'not-an-array' }),
        })),
      }),
      now: () => NOW,
    })

    const presented = vi.fn()
    registerDesignOpenFailurePresenter(presented)
    try {
      await expect(controller.openCanopi()).resolves.toBe(false)
    } finally {
      registerDesignOpenFailurePresenter(null)
    }
    expect(presented).toHaveBeenCalledWith({
      tone: 'error',
      title: t('start.cantOpenTitle'),
      message: t('start.cantReadDamaged'),
    })
    expect(store.readDesignName()).toBe('Working Garden')
    expect(store.readCurrentDesign()).toEqual(original)
  })

  it.each([
    {
      label: 'a Design from before Canopi 2.0 (v4)',
      content: () => ({ ...makeCanopiFile(), version: 4 }),
      message: '$.version: unsupported Canopi Design version 4; Canopi 2.0 and later open only version 9',
      kind: 'unsupported_version',
    },
    {
      label: 'a Design newer than this build',
      content: () => ({ ...makeCanopiFile(), version: 10 }),
      message: '$.version: unsupported Canopi Design version 10; Canopi 2.0 and later open only version 9',
      kind: 'unsupported_version',
    },
    {
      label: 'a Canopi 1.2 Design (v6, local metres under a spatial frame)',
      content: () => ({
        ...makeCanopiFile(),
        version: 6,
        spatial_frame: { anchor_longitude_deg: 13, anchor_latitude_deg: 23, north_bearing_deg: 0, placement_status: 'confirmed' },
        plants: [{ ...plantAt({ lon: 0, lat: 0 }), position: { x: 10, y: 20 } }],
      }),
      message: '$.version: unsupported Canopi Design version 6; Canopi 2.0 and later open only version 9',
      kind: 'unsupported_version',
    },
    {
      label: 'an out-of-range longitude',
      content: () => ({ ...makeCanopiFile(), plants: [{ ...plantAt({ lon: 181, lat: 0 }) }] }),
      message: '$.plants[0].position.lon: expected a number less than or equal to 180',
      kind: 'invalid_document',
    },
    {
      label: 'a local-metre position',
      content: () => ({ ...makeCanopiFile(), plants: [{ ...plantAt({ lon: 0, lat: 0 }), position: { x: 10, y: 20 } }] }),
      message: 'missing required value',
      kind: 'invalid_document',
    },
  ])('rejects $label before replacing the active session', async ({ content, message, kind }) => {
    const original = makeCanopiFile({ name: 'Working Garden' })
    const store = createDesignSessionStore({
      file: original,
      path: null,
      name: original.name,
    })
    const presentOpenFailure = vi.fn()
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(async () => ({
          fileName: 'refused.canopi',
          text: JSON.stringify(content()),
        })),
      }),
      now: () => NOW,
      presentOpenFailure,
    })

    await expect(controller.openCanopi()).resolves.toBe(false)
    expect(presentOpenFailure).toHaveBeenCalledOnce()
    const refusal: unknown = presentOpenFailure.mock.calls[0]?.[0]
    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toContain(message)
    expect(refusal).toMatchObject({ kind })
    expect(store.readDesignName()).toBe('Working Garden')
    expect(store.readCurrentDesign()).toEqual(original)
  })

  it.each([
    {
      label: 'a Canopi 1.1 Design (version 6)',
      fileName: 'orchard.canopi',
      text: () => JSON.stringify({ ...makeCanopiFile(), version: 6, extra: {} }),
      messageKey: 'start.cantReadOlderVersion',
    },
    {
      label: 'a Design from a newer Canopi',
      fileName: 'future.canopi',
      text: () => JSON.stringify({ ...makeCanopiFile(), version: 99 }),
      messageKey: 'start.cantReadNewerVersion',
    },
    {
      label: 'a truncated file',
      fileName: 'truncated.canopi',
      text: () => JSON.stringify(makeCanopiFile()).slice(0, 40),
      messageKey: 'start.cantReadDamaged',
    },
    {
      label: 'a file that is not a .canopi Design',
      fileName: 'notes.txt',
      text: () => 'hello',
      messageKey: 'start.cantRead',
    },
  ])('tells the user why $label cannot be opened', async ({ fileName, text, messageKey }) => {
    dismissBrowserShellNotice()
    registerDesignOpenFailurePresenter(showBrowserShellNotice)
    try {
      const store = createDesignSessionStore()
      const controller = createBrowserDesignSessionController({
        store,
        fileAdapter: testFileAdapter({
          openCanopiFile: vi.fn(async () => ({ fileName, text: text() })),
        }),
        now: () => NOW,
      })

      await expect(controller.openCanopi()).resolves.toBe(false)
      expect(browserShellNotice.value).toEqual({
        tone: 'error',
        title: t('start.cantOpenTitle'),
        message: t(messageKey),
      })
      expect(store.hasCurrentDesign()).toBe(false)
    } finally {
      registerDesignOpenFailurePresenter(null)
      dismissBrowserShellNotice()
    }
  })

  it('opens a current-version Design with lon/lat positions', async () => {
    const openedFile = makeCanopiFile({
      name: 'Geolocated Garden',
      plants: [plantAt({ lon: 2.3522, lat: 48.8566 })],
    })
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(async () => ({
          fileName: 'geolocated.canopi',
          text: JSON.stringify(openedFile),
        })),
      }),
      now: () => NOW,
    })

    await controller.openCanopi()

    expect(store.readDesignName()).toBe('Geolocated Garden')
    expect(store.readCurrentDesign()?.plants[0]?.position).toEqual({ lon: 2.3522, lat: 48.8566 })
    expect(store.readCurrentDesign()).not.toHaveProperty('spatial_frame')
  })

  it('refuses a Design from a Canopi 2 preview (version 7) instead of upgrading it', async () => {
    const openedFile = {
      ...makeCanopiFile({ name: 'Preview Garden', plants: [plantAt({ lon: 2.3522, lat: 48.8566 })] }),
      version: 7,
      zones: [{ name: 'Hedge', zone_type: 'line', points: [{ lon: 2.3522, lat: 48.8566 }, { lon: 2.3523, lat: 48.8566 }] }],
    } as Record<string, unknown>
    delete openedFile.views
    delete openedFile.stories
    const store = createDesignSessionStore()
    const presentOpenFailure = vi.fn()
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(async () => ({
          fileName: 'preview.canopi',
          text: JSON.stringify(openedFile),
        })),
      }),
      now: () => NOW,
      presentOpenFailure,
    })

    await expect(controller.openCanopi()).resolves.toBe(false)

    expect(store.hasCurrentDesign()).toBe(false)
    expect(designLoadFailureOf(presentOpenFailure.mock.calls[0]?.[0])).toMatchObject({ kind: 'older_version' })
  })

  it('does not let an older pending Open overwrite a later New Design', async () => {
    const pendingOpen = deferred<BrowserOpenedCanopiFile | null>()
    const store = createDesignSessionStore({
      file: makeCanopiFile({ name: 'Original Garden' }),
      path: null,
      name: 'Original Garden',
    })
    let nextDraftId = 0
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(() => pendingOpen.promise),
      }),
      now: () => NOW,
      createDraftId: () => `draft-${++nextDraftId}`,
    })

    const opening = controller.openCanopi()
    await controller.newDesign()
    pendingOpen.resolve({
      fileName: 'older-picker.canopi',
      text: JSON.stringify(makeCanopiFile({ name: 'Older Picker Design' })),
    })

    await expect(opening).resolves.toBe(false)
    expect(store.readDesignName()).toBe('Untitled')
    expect(store.readCurrentDesign()?.name).toBe('Untitled')
  })

  it('does not let an older picker completion overwrite a newer Open request', async () => {
    const olderPicker = deferred<BrowserOpenedCanopiFile | null>()
    const newerPicker = deferred<BrowserOpenedCanopiFile | null>()
    const openCanopiFile = vi.fn()
      .mockReturnValueOnce(olderPicker.promise)
      .mockReturnValueOnce(newerPicker.promise)
    const store = createDesignSessionStore({
      file: makeCanopiFile({ name: 'Original Garden' }),
      path: null,
      name: 'Original Garden',
    })
    let nextDraftId = 0
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter({ openCanopiFile }),
      now: () => NOW,
      createDraftId: () => `draft-${++nextDraftId}`,
    })

    const olderOpening = controller.openCanopi()
    const newerOpening = controller.openCanopi()
    newerPicker.resolve({
      fileName: 'newer-picker.canopi',
      text: JSON.stringify(makeCanopiFile({ name: 'Newer Picker Design' })),
    })
    await expect(newerOpening).resolves.toBe(true)

    olderPicker.resolve({
      fileName: 'older-picker.canopi',
      text: JSON.stringify(makeCanopiFile({ name: 'Older Picker Design' })),
    })
    await expect(olderOpening).resolves.toBe(false)

    expect(store.readDesignName()).toBe('Newer Picker Design')
    expect(store.readCurrentDesign()?.name).toBe('Newer Picker Design')
  })

  it('cancels a pending Open when the active Design changes during the picker', async () => {
    const pendingOpen = deferred<BrowserOpenedCanopiFile | null>()
    const store = createDesignSessionStore({
      file: makeCanopiFile({
        name: 'Working Garden',
        description: 'Before picker',
      }),
      path: null,
      name: 'Working Garden',
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(() => pendingOpen.promise),
      }),
      now: () => NOW,
      createDraftId: () => 'draft-picker-guard',
    })

    const opening = controller.openCanopi()
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: 'Edited while picker was open',
    }))
    pendingOpen.resolve({
      fileName: 'picked.canopi',
      text: JSON.stringify(makeCanopiFile({ name: 'Picked Design' })),
    })

    await expect(opening).resolves.toBe(false)
    expect(store.readDesignName()).toBe('Working Garden')
    expect(store.readCurrentDesign()?.description).toBe('Edited while picker was open')
  })

  it('rechecks the Open guard immediately before applying the picked Design', async () => {
    const store = createDesignSessionStore({
      file: makeCanopiFile({
        name: 'Working Garden',
        description: 'Before picker',
      }),
      path: null,
      name: 'Working Garden',
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(async () => ({
          fileName: 'picked.canopi',
          text: JSON.stringify(makeCanopiFile({ name: 'Picked Design' })),
        })),
      }),
      now: () => NOW,
      createDraftId: () => {
        editDesignSessionForTest(store, (design) => ({
          ...design,
          description: 'Edit published during final preparation',
        }))
        return 'draft-picked-design'
      },
    })

    await expect(controller.openCanopi()).resolves.toBe(false)
    expect(store.readDesignName()).toBe('Working Garden')
    expect(store.readCurrentDesign()?.description).toBe(
      'Edit published during final preparation',
    )
  })

  it('opens fetched static templates as detached browser Designs with the template display name', async () => {
    const templateFile = makeCanopiFile({
      name: 'Downloaded Template',
      description: 'Bundled example',
      plants: [plantAt({ lon: -73.6, lat: 45.5 })],
    })
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })

    await expect(controller.openCanopiTemplate({
      name: 'Forest Edge',
      file: templateFile,
    })).resolves.toBe('opened')

    expect(store.readCurrentDesign()?.name).toBe('Downloaded Template')
    expect(store.readCurrentDesign()?.description).toBe('Bundled example')
    expect(store.readCurrentDesign()?.plants[0]?.position).toEqual({ lon: -73.6, lat: 45.5 })
    expect(store.readDesignName()).toBe('Forest Edge')
    expect(store.readDesignPath()).toBeNull()
    expect(store.isDesignDirty()).toBe(false)
  })

  it('does not let an older pending Open overwrite a later template replacement', async () => {
    const pendingOpen = deferred<BrowserOpenedCanopiFile | null>()
    const store = createDesignSessionStore({
      file: makeCanopiFile({ name: 'Original Garden' }),
      path: null,
      name: 'Original Garden',
    })
    let nextDraftId = 0
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(() => pendingOpen.promise),
      }),
      now: () => NOW,
      createDraftId: () => `draft-${++nextDraftId}`,
    })

    const opening = controller.openCanopi()
    await controller.openCanopiTemplate({
      name: 'Later Template',
      file: makeCanopiFile({ name: 'Later Template Design' }),
    })
    pendingOpen.resolve({
      fileName: 'older-picker.canopi',
      text: JSON.stringify(makeCanopiFile({ name: 'Older Picker Design' })),
    })

    await expect(opening).resolves.toBe(false)
    expect(store.readDesignName()).toBe('Later Template')
    expect(store.readCurrentDesign()?.name).toBe('Later Template Design')
  })

  it('downloads the current Design as .canopi JSON after browser edits', async () => {
    const adapter = testFileAdapter()
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({ store, fileAdapter: adapter, now: () => NOW })

    await controller.newDesign()
    controller.renameDesign('Balcony Guild')
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: 'Small browser edit',
      extra: {
        future_top_level: { keep: true },
      },
    }))
    await controller.downloadCanopi()

    expect(adapter.downloadCanopiFile).toHaveBeenCalledOnce()
    const [download] = vi.mocked(adapter.downloadCanopiFile).mock.calls[0]!
    const parsed = JSON.parse(download.text) as Record<string, unknown>
    expect(download.fileName).toBe('Balcony Guild.canopi')
    expect(parsed.name).toBe('Balcony Guild')
    expect(parsed.description).toBe('Small browser edit')
    expect(parsed.timeline).toEqual([])
    expect(parsed.budget).toEqual([])
    expect(parsed.consortiums).toEqual([])
    expect(parsed.future_top_level).toEqual({ keep: true })
    expect(parsed).not.toHaveProperty('extra')
    // A download is an export: the Draft home still lacks these edits.
    expect(store.isDesignDirty()).toBe(true)
    expect(store.readDesignPath()).toBeNull()
  })

  it('keeps edits and a rename made while a browser download is pending', async () => {
    const pending = deferred<void>()
    const adapter = testFileAdapter({
      downloadCanopiFile: vi.fn(() => pending.promise),
    })
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: adapter,
      now: () => NOW,
    })

    await controller.newDesign()
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: 'Captured download content',
    }))
    const downloading = controller.downloadCanopi()
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: 'Edited after download capture',
    }))
    controller.renameDesign('Later Browser Name')

    pending.resolve(undefined)
    await downloading

    const [download] = vi.mocked(adapter.downloadCanopiFile).mock.calls[0]!
    expect(JSON.parse(download.text)).toMatchObject({
      name: 'Untitled',
      description: 'Captured download content',
    })
    expect(store.readCurrentDesign()).toMatchObject({
      name: 'Later Browser Name',
      description: 'Edited after download capture',
    })
    expect(store.readDesignName()).toBe('Later Browser Name')
    expect(store.readDesignPath()).toBeNull()
  })

  it('exports a download without acknowledging the Canvas baseline', async () => {
    const adapter = testFileAdapter()
    const store = createDesignSessionStore({
      file: makeCanopiFile({ name: 'Export Garden' }),
      path: null,
      name: 'Export Garden',
    })
    const controller = createBrowserDesignSessionController({
      store,
      fileAdapter: adapter,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      now: () => NOW,
      createDraftId: () => 'draft-export-garden',
    })
    const acknowledgeSaved = vi.fn(() => 'applied' as const)
    const canvas = testCanvasDocumentSurface({
      captureForPersistence: vi.fn((_metadata, document) => ({
        content: document,
        isCurrent: () => true,
        acknowledgeSaved,
      })),
    })
    const detach = controller.attachCanvasSession(canvas)
    markDesignSessionDirtyForTest(store)

    await expect(controller.downloadCanopi()).resolves.toBeUndefined()

    expect(adapter.downloadCanopiFile).toHaveBeenCalledOnce()
    expect(acknowledgeSaved).not.toHaveBeenCalled()
    expect(store.isDesignDirty()).toBe(true)
    expect(controller.listDrafts()).toEqual([])
    detach()
  })

  it('resolves browser Open .canopi as a no-op when the picker is cancelled', async () => {
    const pending = browserDesignFileAdapter.openCanopiFile()
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()

    try {
      input!.dispatchEvent(new Event('cancel'))
      const result = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve('still-pending'), 0)),
      ])

      expect(result).toBeNull()
      expect(document.body.contains(input)).toBe(false)
    } finally {
      input?.remove()
    }
  })

  it('continuously saves Browser Drafts after the delay and reopens them as detached Designs', async () => {
    vi.useFakeTimers()
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const draftIds = ['draft-browser-patio', 'draft-new-untitled']
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      createDraftId: () => draftIds.shift() ?? 'draft-extra',
    })
    const uninstall = controller.installContinuousSave(testPage())

    try {
      await controller.newDesign()
      controller.renameDesign('Browser Patio')
      editDesignSessionForTest(store, (design) => ({
        ...design,
        description: 'Saved continuously',
      }))
      await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS - 1)
      expect(controller.listDrafts()).toEqual([])
      expect(controller.continuousSave.status.value).toBe('draft')

      await vi.advanceTimersByTimeAsync(1)
      expect(controller.listDrafts()).toEqual([
        {
          id: 'draft-browser-patio',
          name: 'Browser Patio',
          updatedAt: NOW.toISOString(),
        },
      ])
      expect(controller.continuousSave.status.value).toBe('draft')

      await controller.newDesign()
      await expect(controller.openDraft('draft-browser-patio')).resolves.toBe(true)

      expect(store.readDesignPath()).toBeNull()
      expect(store.readDesignName()).toBe('Browser Patio')
      expect(store.readCurrentDesign()?.description).toBe('Saved continuously')
      expect(store.isDesignDirty()).toBe(false)
    } finally {
      uninstall()
      vi.useRealTimers()
    }
  })

  it('flushes the Draft when the page is hidden or unloaded', async () => {
    vi.useFakeTimers()
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      createDraftId: () => 'draft-page-lifecycle',
    })
    const page = testPage()
    const uninstall = controller.installContinuousSave(page)

    try {
      await controller.newDesign()
      editDesignSessionForTest(store, (design) => ({ ...design, description: 'hidden' }))
      page.document.visibilityState = 'hidden'
      page.document.dispatchEvent(new Event('visibilitychange'))
      expect(appDataStore.loadDraft('draft-page-lifecycle')?.description).toBe('hidden')

      editDesignSessionForTest(store, (design) => ({ ...design, description: 'unloaded' }))
      page.window.dispatchEvent(new Event('pagehide'))
      expect(appDataStore.loadDraft('draft-page-lifecycle')?.description).toBe('unloaded')
    } finally {
      uninstall()
      vi.useRealTimers()
    }
  })

  it('writes the current Design before a replacement and asks only when that write fails', async () => {
    const storage = memoryStorage()
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage })
    const draftIds = ['draft-first', 'draft-second', 'draft-third']
    const requestSaveDecision = vi.fn(async () => 'cancel' as const)
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      createDraftId: () => draftIds.shift() ?? 'draft-extra',
      requestSaveDecision: requestSaveDecision as never,
    })

    await controller.newDesign()
    editDesignSessionForTest(store, (design) => ({ ...design, description: 'first edits' }))
    await controller.newDesign()
    expect(requestSaveDecision).not.toHaveBeenCalled()
    expect(appDataStore.loadDraft('draft-first')?.description).toBe('first edits')

    editDesignSessionForTest(store, (design) => ({ ...design, description: 'unwritable' }))
    storage.failWrites = true
    await controller.newDesign()
    expect(requestSaveDecision).toHaveBeenCalledWith({
      kind: 'flush-failed',
      purpose: 'replace',
      conflict: false,
    })
    expect(store.readCurrentDesign()?.description).toBe('unwritable')

    requestSaveDecision.mockResolvedValueOnce('discard' as never)
    await controller.newDesign()
    expect(store.readCurrentDesign()?.description).toBeNull()
    expect(controller.continuousSave.status.value).toBe('draft')
  })

  it('reverts to the version opened and writes it to the same Draft', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({
      id: 'draft-revert',
      file: makeCanopiFile({ name: 'Revert Garden', description: 'as opened' }),
      now: NOW.toISOString(),
    })
    const requestSaveDecision = vi.fn(async (): Promise<'revert' | 'cancel'> => 'cancel')
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      requestSaveDecision: requestSaveDecision as never,
    })
    expect(controller.restoreLatestDraft()).toBe(true)
    expect(controller.continuousSave.revertAvailable.value).toBe(false)

    editDesignSessionForTest(store, (design) => ({ ...design, description: 'changed' }))
    await controller.continuousSave.flush()
    expect(appDataStore.loadDraft('draft-revert')?.description).toBe('changed')
    expect(controller.continuousSave.revertAvailable.value).toBe(true)

    // Cancelling the confirmation keeps the changed Design.
    await expect(controller.revertDesign()).resolves.toBe(false)
    expect(requestSaveDecision).toHaveBeenCalledWith({ kind: 'revert' })
    expect(store.readCurrentDesign()?.description).toBe('changed')

    requestSaveDecision.mockResolvedValueOnce('revert')
    await expect(controller.revertDesign()).resolves.toBe(true)
    expect(store.readCurrentDesign()?.description).toBe('as opened')
    expect(controller.continuousSave.revertAvailable.value).toBe(false)
    await expect(controller.continuousSave.flush()).resolves.toBe(true)
    expect(appDataStore.loadDraft('draft-revert')?.description).toBe('as opened')
  })

  it('does not revert a Draft opened while the revert confirmation was open', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    for (const [id, description] of [['draft-first', 'first'], ['draft-second', 'second']]) {
      appDataStore.saveDraft({ id, file: makeCanopiFile({ name: id, description }), now: NOW.toISOString() })
    }
    const decision = deferred<'revert' | 'cancel'>()
    const requestSaveDecision = vi.fn(() => decision.promise)
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      requestSaveDecision: requestSaveDecision as never,
    })
    await expect(controller.openDraft('draft-first')).resolves.toBe(true)
    editDesignSessionForTest(store, (design) => ({ ...design, description: 'changed' }))

    const reverting = controller.revertDesign()
    await expect(controller.openDraft('draft-second')).resolves.toBe(true)
    editDesignSessionForTest(store, (design) => ({ ...design, description: 'second edited' }))
    decision.resolve('revert')

    await expect(reverting).resolves.toBe(false)
    expect(store.readDesignName()).toBe('draft-second')
    expect(store.readCurrentDesign()?.description).toBe('second edited')
  })

  it('pauses instead of overwriting a Draft another browser tab has changed', async () => {
    const storage = memoryStorage()
    let tick = 0
    const clock = () => new Date(Date.UTC(2026, 6, 4, 12, 0, tick++))
    createBrowserAppDataStore({ storage }).saveDraft({
      id: 'draft-shared',
      file: makeCanopiFile({ name: 'Shared Garden', description: 'as opened' }),
      now: clock().toISOString(),
    })
    function openTab(requestSaveDecision: ReturnType<typeof vi.fn>) {
      const store = createDesignSessionStore()
      const appDataStore = createBrowserAppDataStore({ storage })
      const controller = createBrowserDesignSessionController({
        store,
        appDataStore,
        fileAdapter: testFileAdapter(),
        now: clock,
        requestSaveDecision: requestSaveDecision as never,
      })
      expect(controller.restoreLatestDraft()).toBe(true)
      return { store, appDataStore, controller }
    }
    const decideA = vi.fn(async () => 'keep-mine')
    const decideB = vi.fn(async () => 'use-file')
    const tabA = openTab(decideA)
    const tabB = openTab(decideB)

    editDesignSessionForTest(tabA.store, (design) => ({ ...design, description: 'twenty plants' }))
    await expect(tabA.controller.continuousSave.flush()).resolves.toBe(true)

    // Tab B still holds the Design as opened; its write must not replace tab A's.
    editDesignSessionForTest(tabB.store, (design) => ({ ...design, description: 'nudged zone' }))
    await expect(tabB.controller.continuousSave.flush()).resolves.toBe(false)
    expect(tabB.controller.continuousSave.status.value).toBe('conflict')
    expect(tabB.appDataStore.loadDraft('draft-shared')?.description).toBe('twenty plants')

    // Using the other tab's version reloads the Draft as stored.
    await tabB.controller.resolveSaveConflict()
    expect(decideB).toHaveBeenCalledWith({ kind: 'conflict', fileGone: false, where: 'another-tab' })
    expect(tabB.store.readCurrentDesign()?.description).toBe('twenty plants')
    expect(tabB.controller.continuousSave.status.value).toBe('draft')
    editDesignSessionForTest(tabB.store, (design) => ({ ...design, description: 'twenty plants and a zone' }))
    await expect(tabB.controller.continuousSave.flush()).resolves.toBe(true)

    // Now tab A is behind; keeping its version overwrites on purpose.
    editDesignSessionForTest(tabA.store, (design) => ({ ...design, description: 'tab A again' }))
    await expect(tabA.controller.continuousSave.flush()).resolves.toBe(false)
    expect(tabA.appDataStore.loadDraft('draft-shared')?.description).toBe('twenty plants and a zone')
    await tabA.controller.resolveSaveConflict()
    expect(tabA.appDataStore.loadDraft('draft-shared')?.description).toBe('tab A again')
    expect(tabA.controller.continuousSave.status.value).toBe('draft')
    editDesignSessionForTest(tabA.store, (design) => ({ ...design, description: 'tab A continues' }))
    await expect(tabA.controller.continuousSave.flush()).resolves.toBe(true)
  })

  it('asks about a Draft another tab changed before a replacement discards this tab\'s edits', async () => {
    const storage = memoryStorage()
    let tick = 0
    const clock = () => new Date(Date.UTC(2026, 6, 4, 12, 0, tick++))
    const other = createBrowserAppDataStore({ storage })
    other.saveDraft({ id: 'draft-shared', file: makeCanopiFile({ name: 'Shared' }), now: clock().toISOString() })
    const store = createDesignSessionStore()
    const requestSaveDecision = vi.fn(async () => 'cancel')
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage }),
      fileAdapter: testFileAdapter(),
      now: clock,
      requestSaveDecision: requestSaveDecision as never,
    })
    expect(controller.restoreLatestDraft()).toBe(true)
    other.saveDraft({ id: 'draft-shared', file: makeCanopiFile({ name: 'Shared', description: 'other tab' }), now: clock().toISOString() })
    editDesignSessionForTest(store, (design) => ({ ...design, description: 'this tab' }))

    await controller.newDesign()

    expect(requestSaveDecision).toHaveBeenCalledWith({
      kind: 'flush-failed',
      purpose: 'replace',
      conflict: true,
      where: 'another-tab',
    })
    expect(store.readCurrentDesign()?.description).toBe('this tab')
    expect(other.loadDraft('draft-shared')?.description).toBe('other tab')
  })

  it('deletes a Draft other than the open one', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    for (const id of ['draft-old', 'draft-open']) {
      appDataStore.saveDraft({ id, file: makeCanopiFile({ name: id }), now: NOW.toISOString() })
    }
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })
    expect(controller.restoreLatestDraft()).toBe(true)
    expect(store.readDesignName()).toBe('draft-open')

    expect(controller.deleteDraft('draft-open').ok).toBe(false)
    expect(controller.deleteDraft('draft-old').ok).toBe(true)
    expect(controller.listDrafts().map((draft) => draft.id)).toEqual(['draft-open'])
  })

  it('restores the newest Browser Draft into an empty Design Session', () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({
      id: 'draft-older',
      file: makeCanopiFile({ name: 'Older Garden' }),
      now: '2026-07-04T10:00:00.000Z',
    })
    appDataStore.saveDraft({
      id: 'draft-newer',
      file: makeCanopiFile({ name: 'Recovered Garden' }),
      now: '2026-07-04T11:00:00.000Z',
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })

    expect(controller.restoreLatestDraft()).toBe(true)
    expect(store.readDesignName()).toBe('Recovered Garden')
    expect(store.readCurrentDesign()?.name).toBe('Recovered Garden')
    expect(store.isDesignDirty()).toBe(false)
  })

  it('does not replace an active Design while checking startup Draft recovery', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({
      id: 'draft-persisted',
      file: makeCanopiFile({ name: 'Persisted Garden' }),
      now: NOW.toISOString(),
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      createDraftId: () => 'draft-active',
    })
    await controller.newDesign()

    expect(controller.restoreLatestDraft()).toBe(false)
    expect(store.readDesignName()).toBe('Untitled')
  })

  it('does not let an older pending Open overwrite a later Draft replacement', async () => {
    const pendingOpen = deferred<BrowserOpenedCanopiFile | null>()
    const store = createDesignSessionStore({
      file: makeCanopiFile({ name: 'Original Garden' }),
      path: null,
      name: 'Original Garden',
    })
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({
      id: 'later-draft',
      file: makeCanopiFile({ name: 'Later Draft Design' }),
      now: NOW.toISOString(),
    })
    let nextDraftId = 0
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter({
        openCanopiFile: vi.fn(() => pendingOpen.promise),
      }),
      now: () => NOW,
      createDraftId: () => `draft-${++nextDraftId}`,
    })

    const opening = controller.openCanopi()
    await expect(controller.openDraft('later-draft')).resolves.toBe(true)
    pendingOpen.resolve({
      fileName: 'older-picker.canopi',
      text: JSON.stringify(makeCanopiFile({ name: 'Older Picker Design' })),
    })

    await expect(opening).resolves.toBe(false)
    expect(store.readDesignName()).toBe('Later Draft Design')
    expect(store.readCurrentDesign()?.name).toBe('Later Draft Design')
  })

  it('keeps separate Browser Drafts for different Designs with the same name', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const draftIds = ['draft-first-untitled', 'draft-second-untitled']
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      createDraftId: () => draftIds.shift() ?? 'draft-extra',
    })

    await controller.newDesign()
    markDesignSessionDirtyForTest(store)
    await controller.newDesign()
    markDesignSessionDirtyForTest(store)
    await controller.continuousSave.flush()

    expect(controller.listDrafts()).toEqual([
      {
        id: 'draft-second-untitled',
        name: 'Untitled',
        updatedAt: NOW.toISOString(),
      },
      {
        id: 'draft-first-untitled',
        name: 'Untitled',
        updatedAt: NOW.toISOString(),
      },
    ])
  })

  it('renames the active Browser Draft without leaving a stale draft row', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      createDraftId: () => 'draft-active-session',
    })

    await controller.newDesign()
    controller.renameDesign('Renamed Patio')
    await controller.continuousSave.flush()

    expect(controller.listDrafts()).toEqual([
      {
        id: 'draft-active-session',
        name: 'Renamed Patio',
        updatedAt: NOW.toISOString(),
      },
    ])
    expect(appDataStore.loadDraft('draft-active-session')?.name).toBe('Renamed Patio')
  })

  it('keeps the active Design intact when Browser Draft storage fails', async () => {
    const storage = memoryStorage()
    storage.failWrites = true
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })

    await controller.newDesign()
    markDesignSessionDirtyForTest(store)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(controller.continuousSave.flush()).resolves.toBe(false)
    logError.mockRestore()

    expect(store.readCurrentDesign()?.name).toBe('Untitled')
    expect(store.readDesignPath()).toBeNull()
    expect(store.isDesignDirty()).toBe(true)
    expect(controller.continuousSave.status.value).toBe('error')
    expect(controller.listDrafts()).toEqual([])
  })

  it('serializes attached canvas state into Browser Drafts', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({
      id: 'draft-canvas-draft',
      file: makeCanopiFile({ name: 'Canvas Draft' }),
      now: NOW.toISOString(),
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      createDraftId: () => 'draft-canvas-draft',
    })
    const acknowledgeSaved = vi.fn(() => 'applied' as const)
    const captureForPersistence = vi.fn((
      _metadata: CanvasRuntimeDocumentMetadata,
      doc: CanopiFile,
    ) => ({
      content: {
        ...doc,
        plants: [
          {
            id: 'plant-from-canvas',
            locked: false,
            canonical_name: 'Malus domestica',
            common_name: null,
            color: null,
            position: { lon: 13.0001, lat: 23.0002 },
            rotation: null,
            scale: 1,
            notes: null,
            planted_date: null,
            quantity: null,
          },
        ],
      },
      isCurrent: () => true,
      acknowledgeSaved,
    }))
    const canvas = testCanvasDocumentSurface({ captureForPersistence })
    controller.attachCanvasSession(canvas)
    expect(controller.restoreLatestDraft()).toBe(true)
    store.setCanvasClean(false)

    await expect(controller.continuousSave.flush()).resolves.toBe(false)

    expect(captureForPersistence).toHaveBeenCalledOnce()
    expect(appDataStore.loadDraft('draft-canvas-draft')?.plants).toEqual([
      {
        id: 'plant-from-canvas',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: null,
        color: null,
        symbol: null,
        pinned_name: false,
        position: { lon: 13.0001, lat: 23.0002 },
        rotation: null,
        scale: 1,
        notes: null,
        planted_date: null,
        quantity: null,
      },
    ])
    expect(acknowledgeSaved).toHaveBeenCalledOnce()
  })

  it('applies every browser replacement through the attached canvas lifecycle', async () => {
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({
      id: 'draft-replacement',
      file: makeCanopiFile({ name: 'Draft Replacement' }),
      now: NOW.toISOString(),
    })
    const adapter = testFileAdapter({
      openCanopiFile: vi.fn(async () => ({
        fileName: 'opened-replacement.canopi',
        text: JSON.stringify(makeCanopiFile({ name: 'Opened Replacement' })),
      })),
    })
    const store = createDesignSessionStore()
    const workflowRunner: DesignSessionWorkflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    }
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: adapter,
      workflowRunner,
      now: () => NOW,
      createDraftId: () => `draft-${store.readDesignName().toLowerCase().replace(/ /g, '-')}`,
    })
    const canvas = testCanvasDocumentSurface()
    const detach = controller.attachCanvasSession(canvas)
    vi.mocked(canvas.replaceDocument).mockClear()

    await controller.newDesign()
    await controller.openCanopi()
    await controller.openCanopiTemplate({
      name: 'Template Display',
      file: makeCanopiFile({ name: 'Template Replacement' }),
    })
    await expect(controller.openDraft('draft-replacement')).resolves.toBe(true)

    expect(vi.mocked(canvas.replaceDocument).mock.calls.map(([file]) => file.name)).toEqual([
      'Untitled',
      'Opened Replacement',
      'Template Replacement',
      'Draft Replacement',
    ])
    expect(canvas.showCanvasChrome).toHaveBeenCalledTimes(4)
    expect(canvas.zoomToFit).toHaveBeenCalledTimes(4)
    expect(workflowRunner.install).toHaveBeenCalledTimes(5)

    detach()
    expect(workflowRunner.dispose).toHaveBeenCalledOnce()
  })

  it('defers the Draft write until an attached replacement releases Scene authority', async () => {
    vi.useFakeTimers()
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      createDraftId: () => 'draft-replacement-save',
    })
    let replacementFinalizerActive = false
    const captureForPersistence = vi.fn((
      _metadata: CanvasRuntimeDocumentMetadata,
      document: CanopiFile,
    ) => {
      if (replacementFinalizerActive) throw new Error('capture reentered replacement')
      return persistenceCapture(document)
    })
    const canvas = testCanvasDocumentSurface({
      captureForPersistence,
      replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
        replacementFinalizerActive = true
        try {
          finalizeReplacement()
        } finally {
          replacementFinalizerActive = false
        }
        return { callerFinalizerInvoked: true }
      }),
    })
    const detach = controller.attachCanvasSession(canvas)
    const uninstall = controller.installContinuousSave(testPage())
    captureForPersistence.mockClear()

    try {
      await expect(controller.openCanopiTemplate({
        name: 'Template Garden',
        file: makeCanopiFile({ name: 'Template Garden' }),
      })).resolves.toBe('opened')
      expect(captureForPersistence).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)
      expect(captureForPersistence).toHaveBeenCalledOnce()
      expect(appDataStore.loadDraft('draft-replacement-save')?.name).toBe('Template Garden')
    } finally {
      uninstall()
      detach()
      vi.useRealTimers()
    }
  })

  it('reports a Draft capture failure and saves the still-dirty Design after the next change', async () => {
    vi.useFakeTimers()
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({
      id: 'draft-save-retry',
      file: makeCanopiFile({ name: 'Save Retry Garden' }),
      now: NOW.toISOString(),
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })
    const captureFailure = new CanvasAuthorityBusyError('document-settlement')
    let captureIsBusy = true
    const canvas = testCanvasDocumentSurface({
      captureForPersistence: vi.fn((_metadata, document) => {
        if (captureIsBusy) throw captureFailure
        return persistenceCapture(document)
      }),
    })
    const detach = controller.attachCanvasSession(canvas)
    expect(controller.restoreLatestDraft()).toBe(true)
    const uninstall = controller.installContinuousSave(testPage())
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      editDesignSessionForTest(store, (design) => ({
        ...design,
        description: 'First save attempt',
      }))
      await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)

      expect(logError).toHaveBeenCalledWith('Continuous save failed:', captureFailure)
      expect(store.isDesignDirty()).toBe(true)
      expect(controller.continuousSave.status.value).toBe('error')
      expect(appDataStore.loadDraft('draft-save-retry')?.description).toBeNull()

      captureIsBusy = false
      editDesignSessionForTest(store, (design) => ({
        ...design,
        description: 'Saved after Canvas settled',
      }))
      await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)

      expect(store.isDesignDirty()).toBe(false)
      expect(controller.continuousSave.status.value).toBe('draft')
      expect(appDataStore.loadDraft('draft-save-retry')?.description).toBe(
        'Saved after Canvas settled',
      )
    } finally {
      captureIsBusy = false
      uninstall()
      logError.mockRestore()
      detach()
      vi.useRealTimers()
    }
  })

  it('rejects overlapping browser Canvas attachments before hydrating stale store state', () => {
    const initial = makeCanopiFile({ name: 'Leased Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      now: () => NOW,
    })
    const firstCanvas = testCanvasDocumentSurface()
    const secondCanvas = testCanvasDocumentSurface()
    const detachFirst = controller.attachCanvasSession(firstCanvas)

    expect(() => controller.attachCanvasSession(secondCanvas)).toThrow(
      'Canvas persistence lease',
    )
    expect(secondCanvas.loadDocument).not.toHaveBeenCalled()

    detachFirst()
  })

  it('rejects duplicate attachment of the same Canvas without rehydrating or releasing it', () => {
    const initial = makeCanopiFile({ name: 'Leased Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const workflowRunner: DesignSessionWorkflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    }
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner,
      now: () => NOW,
    })
    const canvas = testCanvasDocumentSurface()
    const detach = controller.attachCanvasSession(canvas)

    expect(() => controller.attachCanvasSession(canvas)).toThrow('already attached')
    expect(canvas.loadDocument).toHaveBeenCalledOnce()

    expect(detach).not.toThrow()
    expect(canvas.captureForPersistence).toHaveBeenCalledOnce()
    expect(workflowRunner.dispose).toHaveBeenCalledOnce()
  })

  it('writes again when an intervening draft acknowledgement publishes a newer edit', async () => {
    const initial = makeCanopiFile({ name: 'Continuous Save Garden' })
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      createDraftId: () => 'draft-reentrant-edit',
      now: () => NOW,
    })
    appDataStore.saveDraft({ id: 'draft-reentrant-edit', file: initial, now: NOW.toISOString() })
    const acknowledgeSaved = vi.fn()
      .mockImplementationOnce(() => {
        editDesignSessionForTest(store, (design) => ({
          ...design,
          description: 'Edit published during acknowledgement',
        }))
        return 'applied' as const
      })
      .mockReturnValue('applied' as const)
    const canvas = testCanvasDocumentSurface({
      captureForPersistence: vi.fn((_metadata, document) => ({
        content: document,
        isCurrent: () => true,
        acknowledgeSaved,
      })),
    })
    const detach = controller.attachCanvasSession(canvas)
    vi.useFakeTimers()
    expect(controller.restoreLatestDraft()).toBe(true)
    const uninstall = controller.installContinuousSave(testPage())

    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: 'First queued edit',
    }))
    await controller.continuousSave.flush()
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)

    expect(appDataStore.loadDraft('draft-reentrant-edit')?.description).toBe(
      'Edit published during acknowledgement',
    )
    expect(store.isDesignDirty()).toBe(false)
    expect(acknowledgeSaved).toHaveBeenCalledTimes(2)

    uninstall()
    detach()
    vi.useRealTimers()
  })

  it('writes again when an intervening acknowledgement commits a Canvas-only edit', async () => {
    const initial = makeCanopiFile({ name: 'Canvas Continuous Save Garden' })
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      createDraftId: () => 'draft-canvas-reentrant-edit',
      now: () => NOW,
    })
    appDataStore.saveDraft({ id: 'draft-canvas-reentrant-edit', file: initial, now: NOW.toISOString() })
    const acknowledgeSaved = vi.fn()
      .mockImplementationOnce(() => {
        store.setCanvasClean(true)
        store.setCanvasClean(false)
        return 'applied' as const
      })
      .mockImplementation(() => {
        store.setCanvasClean(true)
        return 'applied' as const
      })
    let captureNumber = 0
    const canvas = testCanvasDocumentSurface({
      captureForPersistence: vi.fn((_metadata, document) => {
        captureNumber += 1
        return {
          content: {
            ...document,
            plants: [{
              id: `scene-${captureNumber}`,
              locked: false,
              canonical_name: 'Malus domestica',
              common_name: null,
              color: null,
              symbol: null,
              pinned_name: false,
              position: { lon: 13 + captureNumber * 0.001, lat: 23 },
              rotation: null,
              scale: null,
              notes: null,
              planted_date: null,
              quantity: null,
            }],
          },
          isCurrent: () => true,
          acknowledgeSaved,
        }
      }),
    })
    const detach = controller.attachCanvasSession(canvas)
    vi.useFakeTimers()
    expect(controller.restoreLatestDraft()).toBe(true)
    const uninstall = controller.installContinuousSave(testPage())

    store.setCanvasClean(false)
    await controller.continuousSave.flush()
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS)

    expect(appDataStore.loadDraft('draft-canvas-reentrant-edit')?.plants).toEqual([
      expect.objectContaining({ id: 'scene-2' }),
    ])
    expect(store.isDesignDirty()).toBe(false)
    expect(acknowledgeSaved).toHaveBeenCalledTimes(2)

    uninstall()
    detach()
    vi.useRealTimers()
  })

  it('preserves draft ownership when an attached draft replacement fails', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      createDraftId: () => 'active-draft',
      now: () => NOW,
    })
    await controller.newDesign()
    const target = makeCanopiFile({ name: 'Target Draft' })
    expect(appDataStore.saveDraft({
      id: 'target-draft',
      file: target,
      now: NOW.toISOString(),
    }).ok).toBe(true)
    const canvas = testCanvasDocumentSurface({
      replaceDocument: vi.fn()
        .mockImplementationOnce(() => {
          throw new Error('canvas replacement failed')
        })
        .mockImplementation((_file, _token, finalizeReplacement) => {
          finalizeReplacement()
          return { callerFinalizerInvoked: true }
        }),
    })
    const detach = controller.attachCanvasSession(canvas)

    await expect(controller.openDraft('target-draft')).rejects.toThrow('canvas replacement failed')
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: 'Old Design remains active',
    }))
    await controller.continuousSave.flush()

    expect(appDataStore.loadDraft('active-draft')?.description).toBe(
      'Old Design remains active',
    )
    expect(appDataStore.loadDraft('target-draft')?.name).toBe('Target Draft')
    expect(appDataStore.loadDraft('target-draft')?.description).toBeNull()
    detach()
  })

  it('commits draft ownership with Design finalization before a later stage fails', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      createDraftId: () => 'active-draft',
      now: () => NOW,
    })
    await controller.newDesign()
    markDesignSessionDirtyForTest(store)
    await controller.continuousSave.flush()
    const target = makeCanopiFile({ name: 'Finalized Target Draft' })
    expect(appDataStore.saveDraft({
      id: 'target-draft',
      file: target,
      now: NOW.toISOString(),
    }).ok).toBe(true)
    const canvas = testCanvasDocumentSurface()
    const detach = controller.attachCanvasSession(canvas)
    vi.mocked(canvas.showCanvasChrome).mockImplementationOnce(() => {
      throw new Error('chrome publication failed')
    })

    await expect(controller.openDraft('target-draft')).rejects.toThrow('chrome publication failed')
    editDesignSessionForTest(store, (design) => ({ ...design, description: 'after failure' }))
    await controller.continuousSave.flush()

    expect(store.readDesignName()).toBe('Finalized Target Draft')
    expect(appDataStore.loadDraft('target-draft')?.description).toBe('after failure')
    expect(appDataStore.loadDraft('active-draft')?.name).toBe('Untitled')
    expect(appDataStore.loadDraft('active-draft')?.description).toBeNull()

    detach()
  })

  it('keeps the browser Canvas lease when handoff capture fails', () => {
    const initial = makeCanopiFile({ name: 'Handoff Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const workflowRunner: DesignSessionWorkflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    }
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner,
      now: () => NOW,
    })
    const captureForPersistence = vi.fn((
      _metadata: CanvasRuntimeDocumentMetadata,
      _document: CanopiFile,
    ): CanvasPersistenceCapture => {
      throw new Error('handoff capture failed')
    })
    const canvas = testCanvasDocumentSurface({ captureForPersistence })
    const detach = controller.attachCanvasSession(canvas)

    expect(detach).toThrow('exact persistence settlement failed')
    expect(workflowRunner.dispose).not.toHaveBeenCalled()

    captureForPersistence.mockImplementation((_metadata, document) =>
      persistenceCapture(document))
    expect(detach).not.toThrow()
    expect(workflowRunner.dispose).toHaveBeenCalledOnce()
  })

  it('retains the browser Canvas lease until workflow cleanup succeeds on retry', () => {
    const initial = makeCanopiFile({ name: 'Workflow Cleanup Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const cleanupFailure = new Error('workflow cleanup failed')
    const workflowRunner: DesignSessionWorkflowRunner = {
      install: vi.fn(),
      dispose: vi.fn()
        .mockImplementationOnce(() => {
          throw cleanupFailure
        })
        .mockImplementation(() => undefined),
    }
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner,
      now: () => NOW,
    })
    let canvasDescription = 'Captured before cleanup failure'
    const captureForPersistence = vi.fn((
      _metadata: CanvasRuntimeDocumentMetadata,
      document: CanopiFile,
    ) => persistenceCapture({
      ...document,
      description: canvasDescription,
    }))
    const canvas = testCanvasDocumentSurface({ captureForPersistence })
    const replacementCanvas = testCanvasDocumentSurface()
    const detach = controller.attachCanvasSession(canvas)

    expect(detach).toThrow(cleanupFailure)
    expect(captureForPersistence).toHaveBeenCalledOnce()
    expect(() => controller.attachCanvasSession(replacementCanvas)).toThrow(
      'Canvas persistence lease',
    )

    canvasDescription = 'Edited while cleanup remained retryable'
    expect(detach).not.toThrow()
    expect(workflowRunner.dispose).toHaveBeenCalledTimes(2)
    expect(captureForPersistence).toHaveBeenCalledTimes(2)
    expect(store.readCurrentDesign()?.description).toBe(
      'Edited while cleanup remained retryable',
    )
    expect(() => controller.attachCanvasSession(replacementCanvas)).not.toThrow()
  })

  it('settles an interrupted replacement before detach without erasing a newer Design edit', async () => {
    const initial = makeCanopiFile({
      name: 'Interrupted Replacement Garden',
      description: 'Before replacement',
    })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const workflowRunner: DesignSessionWorkflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    }
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner,
      now: () => NOW,
      createDraftId: () => 'interrupted-replacement-draft',
    })
    let sceneFile = initial
    let replacementSettling = false
    let retainedReplacementToken: unknown
    let retainedReplacementFinalizer: (() => void) | null = null
    const replaceDocument = vi.fn((
      file: CanopiFile,
      token,
      finalizeReplacement: () => void,
    ) => {
      if (!replacementSettling) {
        replacementSettling = true
        retainedReplacementToken = token
        retainedReplacementFinalizer = finalizeReplacement
        throw new Error('replacement publication interrupted')
      }
      expect(token).toBe(retainedReplacementToken)
      sceneFile = file
      retainedReplacementFinalizer?.()
      replacementSettling = false
      return { callerFinalizerInvoked: false }
    })
    const captureForPersistence = vi.fn((
      _metadata: CanvasRuntimeDocumentMetadata,
      document: CanopiFile,
    ) => {
      if (replacementSettling) {
        throw new CanvasAuthorityBusyError('document-settlement')
      }
      return persistenceCapture({
        ...document,
        plants: sceneFile.plants,
      })
    })
    const canvas = testCanvasDocumentSurface({
      loadDocument: vi.fn((file) => {
        sceneFile = file
      }),
      replaceDocument,
      captureForPersistence,
    })
    const detach = controller.attachCanvasSession(canvas)

    await expect(controller.newDesign()).rejects.toThrow(
      'replacement publication interrupted',
    )
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: 'Edited after replacement was interrupted',
    }))

    expect(detach).not.toThrow()

    expect(replaceDocument).toHaveBeenCalledTimes(2)
    expect(sceneFile.name).toBe('Untitled')
    expect(store.readCurrentDesign()).toMatchObject({
      name: 'Interrupted Replacement Garden',
      description: 'Edited after replacement was interrupted',
    })

    const remountedCanvas = testCanvasDocumentSurface()
    const detachRemounted = controller.attachCanvasSession(remountedCanvas)
    expect(remountedCanvas.loadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Interrupted Replacement Garden',
        description: 'Edited after replacement was interrupted',
      }),
    )
    expect(detachRemounted).not.toThrow()
  })

  it('hands off the old browser Scene after replacement preparation is rejected', async () => {
    const initial = makeCanopiFile({ name: 'Prepared Browser Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner: { install: vi.fn(), dispose: vi.fn() },
      now: () => NOW,
    })
    const preparationError = new Error('browser replacement preparation failed')
    let sceneColor: string | undefined
    const replaceDocument = vi.fn(() => {
      throw new CanvasDocumentReplacementNotAdmittedError(preparationError)
    })
    const canvas = testCanvasDocumentSurface({
      replaceDocument,
      captureForPersistence: vi.fn((_metadata, document) => persistenceCapture({
        ...document,
        plant_species_colors: sceneColor
          ? { 'Malus domestica': sceneColor }
          : {},
      })),
    })
    const detach = controller.attachCanvasSession(canvas)

    await expect(controller.openCanopiTemplate({
      name: 'Rejected Browser Target',
      file: makeCanopiFile({ name: 'Rejected Browser Target' }),
    })).rejects.toBe(preparationError)

    sceneColor = '#335577'
    store.setCanvasClean(false)
    expect(detach).not.toThrow()

    expect(replaceDocument).toHaveBeenCalledOnce()
    expect(store.readDesignName()).toBe('Prepared Browser Garden')
    expect(store.readCurrentDesign()?.plant_species_colors)
      .toEqual({ 'Malus domestica': '#335577' })
  })

  it('settles a retained replacement before a later Open reaches the picker', async () => {
    const initial = makeCanopiFile({ name: 'Initial Browser Garden' })
    const opened = makeCanopiFile({ name: 'Picked After Recovery' })
    const openCanopiFile = vi.fn(async () => ({
      fileName: 'picked-after-recovery.canopi',
      text: JSON.stringify(opened),
    }))
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    let nextDraftId = 0
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter({ openCanopiFile }),
      workflowRunner: { install: vi.fn(), dispose: vi.fn() },
      now: () => NOW,
      createDraftId: () => `recovery-draft-${++nextDraftId}`,
    })
    let settling = false
    let retainedToken: unknown
    let retainedFinalizer: (() => void) | null = null
    let failFirstReplacement = true
    const replaceDocument = vi.fn((
      _file: CanopiFile,
      token,
      finalizeReplacement: () => void,
    ) => {
      if (settling) {
        expect(token).toBe(retainedToken)
        retainedFinalizer?.()
        settling = false
        return { callerFinalizerInvoked: false }
      }
      if (failFirstReplacement) {
        failFirstReplacement = false
        settling = true
        retainedToken = token
        retainedFinalizer = finalizeReplacement
        throw new Error('retained browser hydration publication failed')
      }
      finalizeReplacement()
      return { callerFinalizerInvoked: true }
    })
    const canvas = testCanvasDocumentSurface({
      replaceDocument,
      captureForPersistence: vi.fn((_metadata, document) => {
        if (settling) throw new CanvasAuthorityBusyError('document-settlement')
        return persistenceCapture(document)
      }),
    })
    controller.attachCanvasSession(canvas)

    await expect(controller.openCanopiTemplate({
      name: 'Interrupted Target',
      file: makeCanopiFile({ name: 'Interrupted Target' }),
    })).rejects.toThrow('retained browser hydration publication failed')

    await expect(controller.openCanopi()).resolves.toBe(false)
    expect(openCanopiFile).not.toHaveBeenCalled()
    expect(replaceDocument).toHaveBeenCalledTimes(2)

    await expect(controller.openCanopi()).resolves.toBe(true)
    expect(openCanopiFile).toHaveBeenCalledOnce()
    expect(replaceDocument).toHaveBeenCalledTimes(3)
    expect(store.readDesignName()).toBe('Picked After Recovery')
  })

  it('quarantines a competing browser replacement from a finalized pending identity', async () => {
    const initial = makeCanopiFile({ name: 'Initial Browser Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const createDraftId = vi.fn()
      .mockReturnValueOnce('first-target-draft')
      .mockReturnValueOnce('second-target-draft')
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner: { install: vi.fn(), dispose: vi.fn() },
      now: () => NOW,
      createDraftId,
    })
    let settling = false
    let acceptedToken: unknown
    let retainedFinalizer: (() => void) | null = null
    const replaceDocument = vi.fn((
      _file: CanopiFile,
      token,
      finalizeReplacement: () => void,
    ) => {
      settling = true
      if (!acceptedToken) {
        acceptedToken = token
        retainedFinalizer = finalizeReplacement
        finalizeReplacement()
        throw new Error('post-finalizer browser publication failed')
      }
      expect(token).toBe(acceptedToken)
      retainedFinalizer?.()
      settling = false
      return { callerFinalizerInvoked: false }
    })
    const canvas = testCanvasDocumentSurface({
      replaceDocument,
      captureForPersistence: vi.fn((_metadata, document) => {
        if (settling) throw new CanvasAuthorityBusyError('document-settlement')
        return persistenceCapture(document)
      }),
    })
    const detach = controller.attachCanvasSession(canvas)
    const firstTarget = makeCanopiFile({ name: 'First Browser Target' })
    const secondTarget = makeCanopiFile({ name: 'Second Browser Target' })

    await expect(controller.openCanopiTemplate({
      name: firstTarget.name,
      file: firstTarget,
    })).rejects.toThrow('post-finalizer browser publication failed')
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: 'Browser edit after First Target finalized',
    }))

    await expect(controller.openCanopiTemplate({
      name: secondTarget.name,
      file: secondTarget,
    })).rejects.toBeInstanceOf(CanvasAuthorityBusyError)
    expect(detach).not.toThrow()
    expect(store.readDesignName()).toBe('First Browser Target')
    expect(store.readCurrentDesign()?.description).toBe(
      'Browser edit after First Target finalized',
    )
    expect(replaceDocument).toHaveBeenCalledTimes(2)
  })

  it('snapshots canvas-owned state and dirty status before detaching', () => {
    const initial = makeCanopiFile({ name: 'Remount Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const workflowRunner: DesignSessionWorkflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    }
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner,
      now: () => NOW,
    })
    const canvasOwnedPlant = {
      id: 'canvas-owned-plant',
      locked: false,
      canonical_name: 'Malus domestica',
      common_name: null,
      color: null,
      position: { lon: 13.0001, lat: 23.0002 },
      rotation: null,
      scale: 1,
      notes: null,
      planted_date: null,
      quantity: null,
    }
    const captureForPersistence = vi.fn((
      _metadata: CanvasRuntimeDocumentMetadata,
      document: CanopiFile,
    ) =>
      persistenceCapture({
        ...document,
        plants: [canvasOwnedPlant],
      }))
    const firstCanvas = testCanvasDocumentSurface({ captureForPersistence })
    const detach = controller.attachCanvasSession(firstCanvas)
    store.setCanvasClean(false)

    detach()

    expect(captureForPersistence).toHaveBeenCalledOnce()
    expect(store.readCurrentDesign()?.plants).toEqual([canvasOwnedPlant])
    expect(store.isDesignDirty()).toBe(true)
    expect(workflowRunner.dispose).toHaveBeenCalledOnce()

    const remountedCanvas = testCanvasDocumentSurface()
    controller.attachCanvasSession(remountedCanvas)
    expect(remountedCanvas.loadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ plants: [canvasOwnedPlant] }),
    )
  })

  it('recaptures browser handoff when snapshot publication commits a newer Scene', () => {
    const initial = makeCanopiFile({ name: 'Reactive Handoff Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner: { install: vi.fn(), dispose: vi.fn() },
      now: () => NOW,
    })
    let sceneVersion = 0
    const captureForPersistence = vi.fn((
      _metadata: CanvasRuntimeDocumentMetadata,
      document: CanopiFile,
    ): CanvasPersistenceCapture => {
      const capturedVersion = sceneVersion
      return {
        content: {
          ...document,
          description: `Scene version ${capturedVersion}`,
        },
        isCurrent: () => capturedVersion === sceneVersion,
        acknowledgeSaved: vi.fn(() => 'applied' as const),
      }
    })
    const canvas = testCanvasDocumentSurface({ captureForPersistence })
    const detach = controller.attachCanvasSession(canvas)
    let commitDuringPublication = false
    const disposeEffect = effect(() => {
      void store.currentDesign.value
      if (!commitDuringPublication) return
      commitDuringPublication = false
      sceneVersion += 1
      store.setCanvasClean(false)
    })

    try {
      commitDuringPublication = true
      detach()

      expect(captureForPersistence).toHaveBeenCalledTimes(2)
      expect(store.readCurrentDesign()?.description).toBe('Scene version 1')
      expect(store.isDesignDirty()).toBe(true)
    } finally {
      disposeEffect()
    }
  })

  it('does not retain a canvas when attachment fails', async () => {
    const initial = makeCanopiFile({ name: 'Existing Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner: { install: vi.fn(), dispose: vi.fn() },
      now: () => NOW,
    })
    const failedCanvas = testCanvasDocumentSurface({
      loadDocument: vi.fn(() => {
        throw new Error('canvas hydration failed')
      }),
    })

    expect(() => controller.attachCanvasSession(failedCanvas)).toThrow('canvas hydration failed')
    await controller.newDesign()

    expect(failedCanvas.replaceDocument).not.toHaveBeenCalled()
    expect(failedCanvas.captureForPersistence).not.toHaveBeenCalled()
    expect(store.readCurrentDesign()?.name).toBe('Untitled')
  })

  it('retries retained workflow cleanup after Canvas attachment fails during install', () => {
    const initial = makeCanopiFile({ name: 'Workflow Install Garden' })
    const store = createDesignSessionStore({
      file: initial,
      path: null,
      name: initial.name,
    })
    const installFailure = new Error('workflow install failed')
    const cleanupFailure = new Error('workflow cleanup remained pending')
    let cleanupAttempts = 0
    const retainedCleanup = vi.fn(() => {
      cleanupAttempts += 1
      if (cleanupAttempts <= 2) throw cleanupFailure
    })
    const laterCleanup = vi.fn()
    let failInstall = true
    const workflowRunner = createDesignSessionWorkflowRunner([
      {
        id: 'retained-cleanup',
        install: () => retainedCleanup,
      },
      {
        id: 'fallible-install',
        install: () => {
          if (failInstall) {
            failInstall = false
            throw installFailure
          }
          return laterCleanup
        },
      },
    ])
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      workflowRunner,
      now: () => NOW,
    })
    const failedCanvas = testCanvasDocumentSurface()
    const replacementCanvas = testCanvasDocumentSurface()
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      let attachmentError: unknown
      try {
        controller.attachCanvasSession(failedCanvas)
      } catch (error) {
        attachmentError = error
      }

      expect(attachmentError).toMatchObject({
        name: 'DesignSessionWorkflowInstallError',
        installError: installFailure,
        cleanupErrors: [cleanupFailure],
      })
      expect(retainedCleanup).toHaveBeenCalledTimes(2)
      expect(logError).toHaveBeenCalledWith(
        'Failed to clean up browser Design Session workflows after Canvas attachment failure:',
        cleanupFailure,
      )

      const detach = controller.attachCanvasSession(replacementCanvas)

      expect(retainedCleanup).toHaveBeenCalledTimes(3)
      expect(failedCanvas.captureForPersistence).not.toHaveBeenCalled()
      expect(detach).not.toThrow()
      expect(retainedCleanup).toHaveBeenCalledTimes(4)
      expect(laterCleanup).toHaveBeenCalledOnce()
    } finally {
      logError.mockRestore()
    }
  })
})

describe('Web Draft persistence request and Draft download (2.1-Q82, Step 2.0.3 persist)', () => {
  it('L3: New and Open request persistence synchronously in their click, before any await; opening a template never does (2.1-Q198)', async () => {
    const requestDraftPersistence = vi.fn()
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      requestDraftPersistence,
    })

    const creating = controller.newDesign()
    expect(requestDraftPersistence).toHaveBeenCalledTimes(1)
    await creating
    const opening = controller.openCanopi()
    expect(requestDraftPersistence).toHaveBeenCalledTimes(2)
    await opening
    const templating = controller.openCanopiTemplate({ name: 'Template', file: makeCanopiFile({ name: 'Template' }) })
    expect(requestDraftPersistence).toHaveBeenCalledTimes(2)
    await templating
  })

  it('reopening a Draft or restoring the newest at launch never requests persistence', async () => {
    const requestDraftPersistence = vi.fn()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({ id: 'draft-kept', file: makeCanopiFile({ name: 'Kept' }), now: NOW.toISOString() })
    const controller = createBrowserDesignSessionController({
      store: createDesignSessionStore(),
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      requestDraftPersistence,
    })

    expect(controller.restoreLatestDraft()).toBe(true)
    await controller.openDraft('draft-kept')
    expect(requestDraftPersistence).not.toHaveBeenCalled()
  })

  // P3-1 (2.1-Q198): Open template never asks; Templates are off in builds and leave in 2.1, and their surface shows
  // no reason line, so an ask there could never be explained.
  it('P3-1: Open template never asks for persistence', () => {
    const requestOnce = vi.spyOn(browserDraftPersistence, 'requestOnce')
    const keep = vi.spyOn(browserDraftPersistence, 'keep')
    try {
      const fetchTemplateAsset = vi.fn(() => new Promise<never>(() => undefined))
      const workflow = createBrowserDesignTemplateImportWorkflow({ baseUrl: 'https://web.canopi.test/', fetchTemplateAsset })
      void workflow.importTemplate({
        id: 'forest-edge', title: 'Forest Edge', author: 'Canopi', description: 'A static bundled template',
        location: { lat: 45.5, lon: -73.6 }, plant_count: 18, climate_zone: 'Temperate', tags: ['forest'],
        screenshot_url: null, download_url: '/templates/forest-edge.canopi',
      })
      expect(fetchTemplateAsset).toHaveBeenCalledOnce()
      expect(requestOnce).not.toHaveBeenCalled()
      expect(keep).not.toHaveBeenCalled()
      workflow.dispose()
    } finally {
      requestOnce.mockRestore()
      keep.mockRestore()
    }
  })

  it('L19: Download a copy of a Draft downloads its .canopi without opening it', async () => {
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({ id: 'draft-orchard', file: makeCanopiFile({ name: 'Orchard/north' }), now: NOW.toISOString() })
    appDataStore.saveDraft({ id: 'draft-hedge', file: makeCanopiFile({ name: 'Hedge' }), now: new Date(NOW.getTime() + 60_000).toISOString() })
    const downloadCanopiFile = vi.fn<(download: BrowserCanopiDownload) => Promise<void>>(async () => undefined)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter({ downloadCanopiFile }),
      now: () => NOW,
    })

    // Two Drafts: the second row's, not the newest, is the one downloaded (review F6).
    const rows = controller.listDrafts()
    expect(rows.map((row) => row.id)).toEqual(['draft-hedge', 'draft-orchard'])
    await controller.downloadDraft(rows[1]!.id)

    expect(store.hasCurrentDesign()).toBe(false)
    expect(downloadCanopiFile).toHaveBeenCalledOnce()
    const download = downloadCanopiFile.mock.calls[0]![0]
    expect(download.fileName).toBe('Orchard north.canopi')
    expect(decodeCanopiDesign(JSON.parse(download.text)).name).toBe('Orchard/north')
    await expect(controller.downloadDraft('draft-missing')).rejects.toThrow('No browser Draft draft-missing')
    expect(downloadCanopiFile).toHaveBeenCalledOnce()
  })

  // canopi-eon8.15 (S2): one Download a copy for the open Design (save status, Reload's save problem) and for a stored
  // Draft (the welcome row, Q193): the same file name rule and the same bytes, from one encoder.
  it('canopi-eon8.15: Download a copy of a Draft and of the same Design open give one file name and one encoding', async () => {
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    appDataStore.saveDraft({ id: 'draft-orchard', file: makeCanopiFile({ name: 'Orchard/north' }), now: NOW.toISOString() })
    const downloadCanopiFile = vi.fn<(download: BrowserCanopiDownload) => Promise<void>>(async () => undefined)
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter({ downloadCanopiFile }),
      now: () => NOW,
    })

    await controller.downloadDraft('draft-orchard')
    await controller.openDraft('draft-orchard')
    await controller.downloadCanopi()

    const [fromRow, fromStatus] = downloadCanopiFile.mock.calls.map(([download]) => download)
    expect(fromRow!.fileName).toBe('Orchard north.canopi')
    expect(fromStatus!.fileName).toBe(fromRow!.fileName)
    expect(fromRow!.text.endsWith('}\n'), 'pretty JSON with one trailing newline').toBe(true)
    expect(fromRow!.text).toBe(`${JSON.stringify(JSON.parse(fromRow!.text), null, 2)}\n`)
    expect(fromStatus!.text, 'the same Design downloads the same bytes from either surface').toBe(fromRow!.text)
  })

  // canopi-eon8.15 (H4, S1's second case): the Draft a release Reload recorded is deleted in another tab before the
  // reload; none reopens, yet the other stored Draft still lists, so the launch reads Drafts stored, not a first visit.
  it('canopi-eon8.15: a reload whose Draft another tab deleted reopens none and still lists the stored Drafts', async () => {
    const storage = memoryStorage()
    const session = memoryStorage()
    const seed = createBrowserAppDataStore({ storage, session: memoryStorage() })
    seed.saveDraft({ id: 'draft-orchard', file: makeCanopiFile({ name: 'Orchard' }), now: NOW.toISOString() })
    seed.saveDraft({ id: 'draft-hedge', file: makeCanopiFile({ name: 'Hedge' }), now: new Date(NOW.getTime() + 60_000).toISOString() })
    const tab = () => createBrowserDesignSessionController({
      store: createDesignSessionStore(),
      appDataStore: createBrowserAppDataStore({ storage, session }),
      fileAdapter: testFileAdapter(),
      now: () => NOW,
      reload: vi.fn(),
    })

    const before = tab()
    expect(await before.openDraft('draft-orchard')).toBe(true)
    expect(await before.reloadForRelease()).toBe(true)
    expect(seed.deleteDraft('draft-orchard').ok, 'another tab deletes the recorded Draft').toBe(true)

    const after = tab()
    expect(after.restoreLatestDraft(), 'the recorded Draft is gone: the start screen, never the newest').toBe(false)
    expect(after.listDrafts().map((draft) => draft.id), 'the other Draft is still stored').toEqual(['draft-hedge'])
  })
})

function testFileAdapter(
  overrides: Partial<BrowserDesignFileAdapter> = {},
): BrowserDesignFileAdapter {
  return {
    openCanopiFile: vi.fn(async () => null),
    downloadCanopiFile: vi.fn(async () => undefined),
    ...overrides,
  }
}

function testPage(): BrowserPageLifecycleTarget & {
  readonly document: EventTarget & { visibilityState: DocumentVisibilityState }
  readonly window: EventTarget
} {
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  })
  return { document, window: new EventTarget() }
}

function testCanvasDocumentSurface(
  overrides: Partial<CanvasDocumentSurface> = {},
): CanvasDocumentSurface {
  return {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
    showCanvasChrome: vi.fn(),
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    loadDocument: vi.fn(),
    replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
      finalizeReplacement()
      return { callerFinalizerInvoked: true }
    }),
    hasLoadedDocument: vi.fn(() => true),
    captureForPersistence: vi.fn((_metadata, doc) => persistenceCapture(doc)),
    resize: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  }
}

function persistenceCapture(content: CanopiFile): CanvasPersistenceCapture {
  return {
    content,
    isCurrent: () => true,
    acknowledgeSaved: vi.fn(() => 'applied' as const),
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

interface MemoryStorage extends BrowserStorageAdapter {
  failWrites: boolean
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>()
  return {
    failWrites: false,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.failWrites) throw new Error('storage unavailable')
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

function makeCanopiFile(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Test Design',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    ...overrides,
  }
}

function plantAt(position: { lon: number; lat: number }): CanopiFile['plants'][number] {
  return {
    id: 'plant-at',
    locked: false,
    canonical_name: 'Malus domestica',
    common_name: null,
    color: null,
    position,
    rotation: null,
    scale: null,
    notes: null,
    planted_date: null,
    quantity: 1,
  }
}
