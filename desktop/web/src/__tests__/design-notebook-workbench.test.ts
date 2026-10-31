import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import { createDesignNotebookWorkbench } from '../app/design-notebook/workbench'
import type { DesignSaveSettlement } from '../app/document-session/persistence'
import type { CanopiFile, DesignNotebookSnapshot, DesignSummary } from '../types/design'

describe('design notebook workbench', () => {
  function deferred<T>(): {
    readonly promise: Promise<T>
    readonly resolve: (value: T) => void
    readonly reject: (error: unknown) => void
  } {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  function testDesign(): CanopiFile {
    return {
      version: 9,
      name: 'Current Design',
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
      created_at: '',
      updated_at: '',
      extra: {},
    }
  }

  function appliedSave(
    content: CanopiFile,
    path: string,
  ): DesignSaveSettlement {
    return {
      status: 'applied',
      path,
      content,
    }
  }

  it('publishes relocation together and refreshes after failure without holding mutation admission', async () => {
    const entry = (path: string, sectionId: string | null, order: number) => ({
      path, name: path, section_id: sectionId, sort_order: order, plant_count: 0, updated_at: '',
    })
    const before: DesignNotebookSnapshot = {
      sections: [{ id: 'destination', name: 'Destination', sort_order: 0, created_at: '', updated_at: '' }],
      entries: [entry('first', null, 0), entry('second', null, 1)],
    }
    const pending = deferred<void>()
    const relocateEntry = vi.fn(() => pending.promise)
    const loadNotebook = vi.fn(async () => before)
    const workbench = createDesignNotebookWorkbench({ loadNotebook, relocateEntry })
    await workbench.load()
    const moving = workbench.relocateEntry('first', 'destination', ['second', 'first'])
    expect(workbench.view.value.entries).toEqual(before.entries)
    pending.resolve()
    await moving
    expect(workbench.view.value.entries).toEqual([entry('second', null, 0), entry('first', 'destination', 1)])
    relocateEntry.mockRejectedValueOnce(new Error('storage failed'))
    await expect(workbench.relocateEntry('first', null, ['first', 'second'])).rejects.toThrow('storage failed')
    expect(workbench.view.value.entries).toEqual(before.entries)
    expect(loadNotebook).toHaveBeenCalledTimes(2)
    await expect(workbench.relocateEntry('first', 'deleted', ['first', 'second'])).rejects.toThrow('no longer available')
    expect(relocateEntry).toHaveBeenCalledTimes(2)
    workbench.dispose()
  })

  it('loads a saved-design ledger and opens rows through the document seam', async () => {
    const activePath = signal<string | null>('/designs/terrace.canopi')
    const openDesign = vi.fn().mockImplementation(async (path: string) => {
      activePath.value = path
    })
    const workbench = createDesignNotebookWorkbench({
      activePath,
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [],
        entries: [
          {
            path: '/designs/terrace.canopi',
            name: 'Terrace Guild',
            updated_at: '2026-06-20T08:00:00.000Z',
            plant_count: 12,
            section_id: null,
            sort_order: 0,
          },
          {
            path: '/designs/forest-edge.canopi',
            name: 'Forest Edge',
            updated_at: '2026-06-22T08:00:00.000Z',
            plant_count: 7,
            section_id: null,
            sort_order: 1,
          },
        ],
      }),
      openDesign,
    })

    await workbench.load()

    expect(workbench.view.value.entries.map((entry) => entry.path)).toEqual([
      '/designs/terrace.canopi',
      '/designs/forest-edge.canopi',
    ])
    expect(workbench.view.value.activePath).toBe('/designs/terrace.canopi')
    expect(workbench.view.value.visibleEntries.map((entry) => entry.name)).toEqual([
      'Terrace Guild',
      'Forest Edge',
    ])

    await workbench.openEntry('/designs/forest-edge.canopi')

    expect(openDesign).toHaveBeenCalledWith('/designs/forest-edge.canopi')
    expect(workbench.view.value.activePath).toBe('/designs/forest-edge.canopi')
  })

  it('treats load failures as an empty ledger with an error state', async () => {
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockRejectedValue(new Error('unavailable')),
      openDesign: vi.fn(),
    })

    await workbench.load()

    expect(workbench.view.value.entries).toEqual([])
    expect(workbench.view.value.loadError).toBe(true)
  })

  it('manages Notebook Sections and one-section entry membership', async () => {
    const createSection = vi.fn().mockResolvedValue({
      id: 'section-client',
      name: 'Client work',
      sort_order: 1,
      created_at: '2026-06-22T08:00:00.000Z',
      updated_at: '2026-06-22T08:00:00.000Z',
    })
    const renameSection = vi.fn().mockResolvedValue(undefined)
    const deleteSection = vi.fn().mockResolvedValue(undefined)
    const moveEntryToSection = vi.fn().mockResolvedValue(undefined)
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [
          {
            id: 'section-home',
            name: 'Home',
            sort_order: 0,
            created_at: '2026-06-20T08:00:00.000Z',
            updated_at: '2026-06-20T08:00:00.000Z',
          },
        ],
        entries: [
          {
            path: '/designs/forest-edge.canopi',
            name: 'Forest Edge',
            updated_at: '2026-06-22T08:00:00.000Z',
            plant_count: 7,
            section_id: null,
            sort_order: 0,
          },
        ],
      }),
      openDesign: vi.fn(),
      createSection,
      renameSection,
      deleteSection,
      moveEntryToSection,
    })

    await workbench.load()
    await workbench.createSection(' Client work ')
    await workbench.moveEntryToSection('/designs/forest-edge.canopi', 'section-client')
    await workbench.renameSection('section-client', 'Consulting')
    await workbench.deleteSection('section-client')

    expect(createSection).toHaveBeenCalledWith('Client work')
    expect(moveEntryToSection).toHaveBeenCalledWith('/designs/forest-edge.canopi', 'section-client')
    expect(renameSection).toHaveBeenCalledWith('section-client', 'Consulting')
    expect(deleteSection).toHaveBeenCalledWith('section-client')
    expect(workbench.view.value.sections.map((section) => section.id)).toEqual(['section-home'])
    expect(workbench.view.value.entries[0]?.section_id).toBeNull()
  })

  it('publishes overlapping Notebook mutations in admission order', async () => {
    const firstRename = deferred<void>()
    const renameSection = vi.fn((_: string, name: string) => (
      name === 'First name' ? firstRename.promise : Promise.resolve()
    ))
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [{
          id: 'section-home',
          name: 'Home',
          sort_order: 0,
          created_at: '2026-06-20T08:00:00.000Z',
          updated_at: '2026-06-20T08:00:00.000Z',
        }],
        entries: [],
      }),
      openDesign: vi.fn(),
      renameSection,
    })
    await workbench.load()

    const first = workbench.renameSection('section-home', 'First name')
    const second = workbench.renameSection('section-home', 'Second name')
    await Promise.resolve()

    expect(renameSection.mock.calls.map(([, name]) => name)).toEqual(['First name'])

    firstRename.resolve()
    await Promise.all([first, second])

    expect(renameSection.mock.calls.map(([, name]) => name)).toEqual([
      'First name',
      'Second name',
    ])
    expect(workbench.view.value.sections[0]?.name).toBe('Second name')
  })

  it('queues a mutation synchronously re-entered by the first adapter', async () => {
    const events: string[] = []
    let reentrantRename: Promise<void> | null = null
    const workbench: ReturnType<typeof createDesignNotebookWorkbench> = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [{
          id: 'section-home',
          name: 'Home',
          sort_order: 0,
          created_at: '2026-06-20T08:00:00.000Z',
          updated_at: '2026-06-20T08:00:00.000Z',
        }],
        entries: [],
      }),
      openDesign: vi.fn(),
      createSection: (name) => {
        events.push('create:start')
        reentrantRename = workbench.renameSection('section-home', 'Renamed')
        events.push('create:end')
        return Promise.resolve({
          id: 'section-new',
          name,
          sort_order: 1,
          created_at: '2026-06-21T08:00:00.000Z',
          updated_at: '2026-06-21T08:00:00.000Z',
        })
      },
      renameSection: () => {
        events.push('rename')
        return Promise.resolve()
      },
    })
    await workbench.load()

    await workbench.createSection('New')
    if (!reentrantRename) throw new Error('Expected re-entrant rename admission')
    await reentrantRename

    expect(events).toEqual(['create:start', 'create:end', 'rename'])
    expect(workbench.view.value.sections.find(({ id }) => id === 'section-home')?.name)
      .toBe('Renamed')
  })

  it('continues queued Notebook mutations after a predecessor throws synchronously', async () => {
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [{
          id: 'section-home',
          name: 'Home',
          sort_order: 0,
          created_at: '2026-06-20T08:00:00.000Z',
          updated_at: '2026-06-20T08:00:00.000Z',
        }],
        entries: [],
      }),
      openDesign: vi.fn(),
      renameSection: (_sectionId, name) => {
        if (name === 'Rejected name') throw new Error('rename failed')
        return Promise.resolve()
      },
    })
    await workbench.load()

    const rejected = workbench.renameSection('section-home', 'Rejected name')
    const recovered = workbench.renameSection('section-home', 'Recovered name')

    await expect(rejected).rejects.toThrow('rename failed')
    await expect(recovered).resolves.toBeUndefined()
    expect(workbench.view.value.sections[0]?.name).toBe('Recovered name')
  })

  it('does not publish a Notebook mutation continuation after disposal', async () => {
    const pendingRename = deferred<void>()
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [{
          id: 'section-home',
          name: 'Home',
          sort_order: 0,
          created_at: '2026-06-20T08:00:00.000Z',
          updated_at: '2026-06-20T08:00:00.000Z',
        }],
        entries: [],
      }),
      openDesign: vi.fn(),
      renameSection: () => pendingRename.promise,
    })
    await workbench.load()

    const rename = workbench.renameSection('section-home', 'Renamed')
    await Promise.resolve()
    workbench.dispose()
    pendingRename.resolve()
    await rename

    expect(workbench.view.value.sections[0]?.name).toBe('Home')
  })

  it('does not invoke an already queued Notebook mutation after disposal', async () => {
    const pendingRename = deferred<void>()
    const renameSection = vi.fn((_sectionId: string, name: string) => (
      name === 'First name' ? pendingRename.promise : Promise.resolve()
    ))
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [{
          id: 'section-home',
          name: 'Home',
          sort_order: 0,
          created_at: '2026-06-20T08:00:00.000Z',
          updated_at: '2026-06-20T08:00:00.000Z',
        }],
        entries: [],
      }),
      openDesign: vi.fn(),
      renameSection,
    })
    await workbench.load()

    const inFlight = workbench.renameSection('section-home', 'First name')
    const queued = workbench.renameSection('section-home', 'Queued name')
    expect(renameSection).toHaveBeenCalledTimes(1)

    workbench.dispose()
    pendingRename.resolve()
    await Promise.all([inFlight, queued])

    expect(renameSection).toHaveBeenCalledTimes(1)
    expect(workbench.view.value.sections[0]?.name).toBe('Home')
  })

  it('removes a saved Design reference without changing the active Design Session path', async () => {
    const activePath = signal<string | null>('/designs/forest-edge.canopi')
    const removeEntry = vi.fn().mockResolvedValue(undefined)
    const workbench = createDesignNotebookWorkbench({
      activePath,
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [],
        entries: [
          {
            path: '/designs/forest-edge.canopi',
            name: 'Forest Edge',
            updated_at: '2026-06-22T08:00:00.000Z',
            plant_count: 7,
            section_id: null,
            sort_order: 0,
          },
          {
            path: '/designs/home.canopi',
            name: 'Home',
            updated_at: '2026-06-20T08:00:00.000Z',
            plant_count: 3,
            section_id: null,
            sort_order: 1,
          },
        ],
      }),
      openDesign: vi.fn(),
      removeEntry,
    })

    await workbench.load()
    await workbench.removeEntry('/designs/forest-edge.canopi')

    expect(removeEntry).toHaveBeenCalledWith('/designs/forest-edge.canopi')
    expect(workbench.view.value.entries.map((entry) => entry.path)).toEqual(['/designs/home.canopi'])
    expect(workbench.view.value.activePath).toBe('/designs/forest-edge.canopi')
  })

  it('does not publish a load snapshot older than an admitted removal', async () => {
    const pendingLoad = deferred<DesignNotebookSnapshot>()
    const pendingRemoval = deferred<void>()
    const loadNotebook = vi.fn(() => pendingLoad.promise)
    const workbench = createDesignNotebookWorkbench({
      loadNotebook,
      openDesign: vi.fn(),
      removeEntry: () => pendingRemoval.promise,
    })

    const load = workbench.load()
    expect(loadNotebook).toHaveBeenCalledTimes(1)
    const removal = workbench.removeEntry('/designs/forest-edge.canopi')
    pendingLoad.resolve({
      sections: [],
      entries: [{
        path: '/designs/forest-edge.canopi',
        name: 'Forest Edge',
        updated_at: '2026-06-22T08:00:00.000Z',
        plant_count: 7,
        section_id: null,
        sort_order: 0,
      }],
    })
    await load

    expect(workbench.view.value.entries).toEqual([])
    expect(workbench.view.value.loading).toBe(false)

    pendingRemoval.resolve()
    await removal
  })

  it('does not publish a load snapshot older than an admitted section move', async () => {
    const pendingLoad = deferred<DesignNotebookSnapshot>()
    const pendingMove = deferred<void>()
    const initialSnapshot: DesignNotebookSnapshot = {
      sections: [{
        id: 'section-home',
        name: 'Home',
        sort_order: 0,
        created_at: '2026-06-20T08:00:00.000Z',
        updated_at: '2026-06-20T08:00:00.000Z',
      }],
      entries: [{
        path: '/designs/forest-edge.canopi',
        name: 'Forest Edge',
        updated_at: '2026-06-22T08:00:00.000Z',
        plant_count: 7,
        section_id: null,
        sort_order: 0,
      }],
    }
    const loadNotebook = vi.fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockReturnValueOnce(pendingLoad.promise)
    const workbench = createDesignNotebookWorkbench({
      loadNotebook,
      openDesign: vi.fn(),
      moveEntryToSection: () => pendingMove.promise,
    })
    await workbench.load()

    const load = workbench.load()
    expect(loadNotebook).toHaveBeenCalledTimes(2)
    const move = workbench.moveEntryToSection(
      '/designs/forest-edge.canopi',
      'section-home',
    )
    pendingLoad.resolve({
      ...initialSnapshot,
      entries: [{ ...initialSnapshot.entries[0]!, name: 'Stale name' }],
    })
    await load

    expect(workbench.view.value.entries[0]?.name).toBe('Forest Edge')
    expect(workbench.view.value.loading).toBe(false)

    pendingMove.resolve()
    await move
    expect(workbench.view.value.entries[0]?.section_id).toBe('section-home')
  })

  it('loads Recent Designs as a capped menu projection', async () => {
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({ sections: [], entries: [] }),
      loadRecentDesigns: vi.fn().mockResolvedValue([
        { path: '/a.canopi', name: 'A', updated_at: '2026-06-01T00:00:00.000Z' },
        { path: '/b.canopi', name: 'B', updated_at: '2026-06-02T00:00:00.000Z' },
        { path: '/c.canopi', name: 'C', updated_at: '2026-06-03T00:00:00.000Z' },
        { path: '/d.canopi', name: 'D', updated_at: '2026-06-04T00:00:00.000Z' },
        { path: '/e.canopi', name: 'E', updated_at: '2026-06-05T00:00:00.000Z' },
        { path: '/f.canopi', name: 'F', updated_at: '2026-06-06T00:00:00.000Z' },
      ]),
      openDesign: vi.fn(),
    })

    await workbench.loadRecentDesigns()

    expect(workbench.view.value.recentEntries.map((entry) => entry.name)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('keeps newer Recent Design refreshes when older loads resolve later', async () => {
    const firstLoad = deferred<DesignSummary[]>()
    const secondLoad = deferred<DesignSummary[]>()
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({ sections: [], entries: [] }),
      loadRecentDesigns: vi.fn()
        .mockReturnValueOnce(firstLoad.promise)
        .mockReturnValueOnce(secondLoad.promise),
      openDesign: vi.fn(),
    })

    const firstRefresh = workbench.loadRecentDesigns()
    const secondRefresh = workbench.loadRecentDesigns()

    secondLoad.resolve([
      { path: '/new.canopi', name: 'New', updated_at: '2026-06-02T00:00:00.000Z' },
    ])
    await secondRefresh

    expect(workbench.view.value.recentEntries.map((entry) => entry.name)).toEqual(['New'])

    firstLoad.resolve([
      { path: '/old.canopi', name: 'Old', updated_at: '2026-06-01T00:00:00.000Z' },
    ])
    await firstRefresh

    expect(workbench.view.value.recentEntries.map((entry) => entry.name)).toEqual(['New'])
  })

  it('saves an unsaved current Design before adding it to a Notebook Section', async () => {
    const activePath = signal<string | null>(null)
    const currentDesignBeforeSave = testDesign()
    const currentDesign = signal<CanopiFile | null>(currentDesignBeforeSave)
    const savedDesign = {
      ...testDesign(),
      name: 'Saved Current Design',
      plants: [{ id: 'persisted-canvas-plant' } as CanopiFile['plants'][number]],
    }
    const saveAsCurrent = vi.fn().mockImplementation(async () => {
      activePath.value = '/designs/current.canopi'
      return appliedSave(savedDesign, '/designs/current.canopi')
    })
    const addDesignReference = vi.fn().mockResolvedValue(undefined)
    const moveEntryToSection = vi.fn().mockResolvedValue(undefined)
    const loadNotebook = vi.fn()
      .mockResolvedValueOnce({
        sections: [
          {
            id: 'section-client',
            name: 'Client work',
            sort_order: 0,
            created_at: '2026-06-22T08:00:00.000Z',
            updated_at: '2026-06-22T08:00:00.000Z',
          },
        ],
        entries: [],
      })
      .mockResolvedValueOnce({
        sections: [
          {
            id: 'section-client',
            name: 'Client work',
            sort_order: 0,
            created_at: '2026-06-22T08:00:00.000Z',
            updated_at: '2026-06-22T08:00:00.000Z',
          },
        ],
        entries: [
          {
            path: '/designs/current.canopi',
            name: 'Current Design',
            updated_at: '2026-06-22T08:00:00.000Z',
            plant_count: 0,
            section_id: null,
            sort_order: 0,
          },
        ],
      })
    const workbench = createDesignNotebookWorkbench({
      activePath,
      currentDesign,
      loadNotebook,
      openDesign: vi.fn(),
      saveAsCurrent,
      saveCurrent: vi.fn(),
      addDesignReference,
      moveEntryToSection,
    })

    await workbench.load()
    const added = await workbench.addCurrentDesignToNotebook('section-client')

    expect(added).toBe(true)
    expect(saveAsCurrent).toHaveBeenCalledTimes(1)
    expect(addDesignReference).toHaveBeenCalledWith('/designs/current.canopi', savedDesign)
    expect(currentDesign.value).toBe(currentDesignBeforeSave)
    expect(moveEntryToSection).toHaveBeenCalledWith('/designs/current.canopi', 'section-client')
    expect(workbench.view.value.entries[0]?.path).toBe('/designs/current.canopi')
  })

  it('does not save a different Design Session while Add Current waits in the mutation queue', async () => {
    const activePath = signal<string | null>('/designs/admitted.canopi')
    const admittedDesign = testDesign()
    const currentDesign = signal<CanopiFile | null>(admittedDesign)
    const pendingRemoval = deferred<void>()
    const saveCurrent = vi.fn().mockResolvedValue(false)
    const saveAsCurrent = vi.fn().mockResolvedValue(null)
    const workbench = createDesignNotebookWorkbench({
      activePath,
      currentDesign,
      loadNotebook: vi.fn().mockResolvedValue({ sections: [], entries: [] }),
      openDesign: vi.fn(),
      removeEntry: () => pendingRemoval.promise,
      saveCurrent,
      saveAsCurrent,
    })

    const blockingRemoval = workbench.removeEntry('/designs/old.canopi')
    const adding = workbench.addCurrentDesignToNotebook(null)
    currentDesign.value = { ...testDesign(), name: 'Later Design' }
    activePath.value = '/designs/later.canopi'
    pendingRemoval.resolve()

    await blockingRemoval
    await expect(adding).resolves.toBe(false)
    expect(saveCurrent).not.toHaveBeenCalled()
    expect(saveAsCurrent).not.toHaveBeenCalled()
  })

  it('does not move Add Current into a deleted Notebook Section', async () => {
    const activePath = signal<string | null>('/designs/current.canopi')
    const savedDesign = testDesign()
    const currentDesign = signal<CanopiFile | null>(savedDesign)
    const addDesignReference = vi.fn().mockResolvedValue(undefined)
    const deleteSection = vi.fn().mockResolvedValue(undefined)
    const moveEntryToSection = vi.fn().mockResolvedValue(undefined)
    const loadNotebook = vi.fn()
      .mockResolvedValueOnce({
        sections: [
          {
            id: 'section-client',
            name: 'Client work',
            sort_order: 0,
            created_at: '2026-06-22T08:00:00.000Z',
            updated_at: '2026-06-22T08:00:00.000Z',
          },
        ],
        entries: [],
      })
      .mockResolvedValueOnce({
        sections: [],
        entries: [
          {
            path: '/designs/current.canopi',
            name: 'Current Design',
            updated_at: '2026-06-22T08:00:00.000Z',
            plant_count: 0,
            section_id: null,
            sort_order: 0,
          },
        ],
      })
    const workbench = createDesignNotebookWorkbench({
      activePath,
      currentDesign,
      loadNotebook,
      openDesign: vi.fn(),
      saveCurrent: vi.fn().mockResolvedValue(true),
      saveAsCurrent: vi.fn(),
      addDesignReference,
      deleteSection,
      moveEntryToSection,
    })

    await workbench.load()
    await workbench.deleteSection('section-client')
    const added = await workbench.addCurrentDesignToNotebook('section-client')

    expect(added).toBe(true)
    expect(addDesignReference).toHaveBeenCalledWith('/designs/current.canopi', savedDesign)
    expect(moveEntryToSection).not.toHaveBeenCalled()
    expect(workbench.view.value.entries[0]?.section_id).toBeNull()
  })

  it('does not create a notebook entry when Save As is cancelled', async () => {
    const activePath = signal<string | null>(null)
    const currentDesign = signal<CanopiFile | null>(testDesign())
    const loadNotebook = vi.fn().mockResolvedValue({ sections: [], entries: [] })
    const workbench = createDesignNotebookWorkbench({
      activePath,
      currentDesign,
      loadNotebook,
      openDesign: vi.fn(),
      saveAsCurrent: vi.fn().mockResolvedValue(null),
      saveCurrent: vi.fn(),
      moveEntryToSection: vi.fn(),
    })

    await workbench.load()
    const added = await workbench.addCurrentDesignToNotebook(null)

    expect(added).toBe(false)
    expect(loadNotebook).toHaveBeenCalledTimes(1)
    expect(workbench.view.value.entries).toEqual([])
  })

  it('hides the add-current affordance once the active saved path is listed', async () => {
    const activePath = signal<string | null>('/designs/current.canopi')
    const currentDesign = signal<CanopiFile | null>(testDesign())
    const workbench = createDesignNotebookWorkbench({
      activePath,
      currentDesign,
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [],
        entries: [
          {
            path: '/designs/current.canopi',
            name: 'Current Design',
            updated_at: '2026-06-22T08:00:00.000Z',
            plant_count: 0,
            section_id: null,
            sort_order: 0,
          },
        ],
      }),
      openDesign: vi.fn(),
    })

    await workbench.load()

    expect(workbench.view.value.canAddCurrentDesign).toBe(false)
  })

  it('persists manual Notebook Section and row order through public commands', async () => {
    const reorderSections = vi.fn().mockResolvedValue(undefined)
    const reorderEntries = vi.fn().mockResolvedValue(undefined)
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [
          {
            id: 'section-first',
            name: 'First',
            sort_order: 0,
            created_at: '2026-06-20T08:00:00.000Z',
            updated_at: '2026-06-20T08:00:00.000Z',
          },
          {
            id: 'section-second',
            name: 'Second',
            sort_order: 1,
            created_at: '2026-06-21T08:00:00.000Z',
            updated_at: '2026-06-21T08:00:00.000Z',
          },
        ],
        entries: [
          {
            path: '/designs/first.canopi',
            name: 'First Design',
            updated_at: '2026-06-20T08:00:00.000Z',
            plant_count: 1,
            section_id: null,
            sort_order: 0,
          },
          {
            path: '/designs/second.canopi',
            name: 'Second Design',
            updated_at: '2026-06-21T08:00:00.000Z',
            plant_count: 2,
            section_id: null,
            sort_order: 1,
          },
        ],
      }),
      openDesign: vi.fn(),
      reorderSections,
      reorderEntries,
    })

    await workbench.load()
    await workbench.reorderSections(['section-second', 'section-first'])
    await workbench.reorderEntries(['/designs/second.canopi', '/designs/first.canopi'])

    expect(reorderSections).toHaveBeenCalledWith(['section-second', 'section-first'])
    expect(reorderEntries).toHaveBeenCalledWith(['/designs/second.canopi', '/designs/first.canopi'])
    expect(workbench.view.value.sections.map((section) => section.id)).toEqual([
      'section-second',
      'section-first',
    ])
    expect(workbench.view.value.entries.map((entry) => entry.path)).toEqual([
      '/designs/second.canopi',
      '/designs/first.canopi',
    ])
    expect(workbench.view.value.sections.map((section) => section.sort_order)).toEqual([0, 1])
    expect(workbench.view.value.entries.map((entry) => entry.sort_order)).toEqual([0, 1])
  })
})
