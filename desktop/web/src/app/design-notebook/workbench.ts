import { computed, signal, type ReadonlySignal } from '@preact/signals'
import {
  addDesignReferenceToNotebook,
  createNotebookSection,
  deleteNotebookSection,
  getDesignNotebook,
  getRecentFiles,
  moveDesignReferenceToSection,
  renameNotebookSection,
  removeDesignReference,
  reorderDesignReferences,
  relocateDesignReference,
  reorderNotebookSections,
} from '../../ipc/design'
import {
  openDesignFromPath,
  saveAsCurrentDesign,
  saveCurrentDesignEdits,
} from '../document-session/actions'
import {
  currentDesign as currentDesignSignal,
  designPath,
  designRecentId,
} from '../document-session/store'
import type {
  CanopiFile,
  DesignNotebookEntry,
  DesignNotebookSection,
  DesignNotebookSnapshot,
  DesignSummary,
} from '../../types/design'
import { createMutationQueue } from '../mutation-queue'

const MAX_RECENT_DESIGNS = 5

interface DesignNotebookView {
  readonly entries: readonly DesignNotebookEntry[]
  readonly visibleEntries: readonly DesignNotebookEntry[]
  readonly sections: readonly DesignNotebookSection[]
  readonly recentEntries: readonly DesignSummary[]
  readonly canAddCurrentDesign: boolean
  readonly currentDesignPath: string | null
  readonly activePath: string | null
  readonly loading: boolean
  readonly loadError: boolean
}

export interface DesignNotebookWorkbench {
  readonly view: ReadonlySignal<DesignNotebookView>
  load(): Promise<void>
  loadRecentDesigns(): Promise<void>
  refresh(): Promise<void>
  openEntry(path: string): Promise<void>
  addCurrentDesignToNotebook(sectionId: string | null): Promise<boolean>
  removeEntry(path: string): Promise<void>
  createSection(name: string): Promise<void>
  renameSection(sectionId: string, name: string): Promise<void>
  deleteSection(sectionId: string): Promise<void>
  moveEntryToSection(path: string, sectionId: string | null): Promise<void>
  reorderSections(sectionIds: readonly string[]): Promise<void>
  reorderEntries(paths: readonly string[]): Promise<void>
  relocateEntry(path: string, sectionId: string | null, paths: readonly string[]): Promise<void>
  dispose(): void
}

interface CreateDesignNotebookWorkbenchOptions {
  readonly loadNotebook?: typeof getDesignNotebook
  readonly loadRecentDesigns?: typeof getRecentFiles
  readonly openDesign?: typeof openDesignFromPath
  readonly saveCurrent?: typeof saveCurrentDesignEdits
  readonly saveAsCurrent?: typeof saveAsCurrentDesign
  readonly addDesignReference?: typeof addDesignReferenceToNotebook
  readonly createSection?: typeof createNotebookSection
  readonly renameSection?: typeof renameNotebookSection
  readonly deleteSection?: typeof deleteNotebookSection
  readonly moveEntryToSection?: typeof moveDesignReferenceToSection
  readonly removeEntry?: typeof removeDesignReference
  readonly reorderSections?: typeof reorderNotebookSections
  readonly reorderEntries?: typeof reorderDesignReferences
  readonly relocateEntry?: typeof relocateDesignReference
  readonly activePath?: ReadonlySignal<string | null>
  readonly activeRecentId?: ReadonlySignal<string | null>
  readonly currentDesign?: ReadonlySignal<CanopiFile | null>
}

export function createDesignNotebookWorkbench(
  options: CreateDesignNotebookWorkbenchOptions = {},
): DesignNotebookWorkbench {
  const loadNotebook = options.loadNotebook ?? getDesignNotebook
  const loadRecentDesignsAdapter = options.loadRecentDesigns ?? getRecentFiles
  const openDesign = options.openDesign ?? openDesignFromPath
  const saveCurrent = options.saveCurrent ?? saveCurrentDesignEdits
  const saveAsCurrent = options.saveAsCurrent ?? saveAsCurrentDesign
  const addDesignReferenceAdapter = options.addDesignReference ?? addDesignReferenceToNotebook
  const createSectionAdapter = options.createSection ?? createNotebookSection
  const renameSectionAdapter = options.renameSection ?? renameNotebookSection
  const deleteSectionAdapter = options.deleteSection ?? deleteNotebookSection
  const moveEntryToSectionAdapter = options.moveEntryToSection ?? moveDesignReferenceToSection
  const removeEntryAdapter = options.removeEntry ?? removeDesignReference
  const reorderSectionsAdapter = options.reorderSections ?? reorderNotebookSections
  const reorderEntriesAdapter = options.reorderEntries ?? reorderDesignReferences
  const relocateEntryAdapter = options.relocateEntry ?? relocateDesignReference
  const activePath = options.activePath ?? designPath
  const activeRecentId = options.activeRecentId ?? designRecentId
  const currentDesign = options.currentDesign ?? currentDesignSignal

  const entries = signal<readonly DesignNotebookEntry[]>([])
  const sections = signal<readonly DesignNotebookSection[]>([])
  const recentEntries = signal<readonly DesignSummary[]>([])
  const loading = signal(false)
  const loadError = signal(false)

  const queue = createMutationQueue()
  let generation = 0
  let recentGeneration = 0

  const view = computed<DesignNotebookView>(() => {
    const currentKey = activePath.value
    const currentRecentId = activeRecentId.value
    const matchedEntry = entries.value.find(
      (entry) =>
        (currentRecentId !== null && entry.recent_id === currentRecentId)
        || (currentKey !== null && (entry.grant === currentKey || entry.path === currentKey)),
    )
    const resolvedActivePath = matchedEntry ? matchedEntry.path : currentKey

    return {
      entries: entries.value,
      visibleEntries: entries.value,
      sections: sections.value,
      recentEntries: recentEntries.value,
      canAddCurrentDesign: currentDesign.value !== null && matchedEntry === undefined,
      currentDesignPath: resolvedActivePath,
      activePath: resolvedActivePath,
      loading: loading.value,
      loadError: loadError.value,
    }
  })

  async function load(): Promise<void> {
    if (queue.disposed) return
    const requestGeneration = ++generation
    const requestSnapshotEpoch = queue.epoch
    const admittedLifetime = queue.lifetime
    const mutationBarrier = queue.tail
    loading.value = true
    loadError.value = false

    try {
      if (mutationBarrier) {
        await mutationBarrier
        if (
          !queue.isCurrent(admittedLifetime)
          || isLoadStale(requestGeneration, requestSnapshotEpoch)
        ) return
      }
      const snapshot = await loadNotebook()
      if (
        !queue.isCurrent(admittedLifetime)
        || isLoadStale(requestGeneration, requestSnapshotEpoch)
      ) return
      writeSnapshot(snapshot)
      loadError.value = false
    } catch {
      if (isLoadStale(requestGeneration, requestSnapshotEpoch)) return
      entries.value = []
      sections.value = []
      loadError.value = true
    } finally {
      if (isCurrentLoad(requestGeneration)) {
        loading.value = false
      }
    }
  }

  async function loadRecentDesigns(): Promise<void> {
    if (queue.disposed) return
    const requestGeneration = ++recentGeneration
    const admittedLifetime = queue.lifetime
    try {
      const nextRecentEntries = (await loadRecentDesignsAdapter()).slice(0, MAX_RECENT_DESIGNS)
      if (
        !queue.isCurrent(admittedLifetime)
        || isRecentStale(requestGeneration)
      ) return
      recentEntries.value = nextRecentEntries
    } catch {
      if (
        !queue.isCurrent(admittedLifetime)
        || isRecentStale(requestGeneration)
      ) return
      recentEntries.value = []
    }
  }

  function isLoadStale(requestGeneration: number, requestSnapshotEpoch: number): boolean {
    return !isCurrentLoad(requestGeneration) || requestSnapshotEpoch !== queue.epoch
  }

  function isCurrentLoad(requestGeneration: number): boolean {
    return !queue.disposed && requestGeneration === generation
  }

  function isRecentStale(requestGeneration: number): boolean {
    return queue.disposed || requestGeneration !== recentGeneration
  }

  function writeSnapshot(snapshot: DesignNotebookSnapshot): void {
    entries.value = snapshot.entries
    sections.value = snapshot.sections
  }

  async function openEntry(path: string): Promise<void> {
    if (queue.disposed) return
    const admittedLifetime = queue.lifetime
    const notebook = entries.value.find((entry) => entry.path === path)
    const recent = recentEntries.value.find((entry) => entry.path === path)
    const grant = notebook?.grant ?? recent?.grant
    const recentId = notebook?.recent_id ?? recent?.recent_id
    const displayName = path.split(/[\\/]/).filter(Boolean).pop() ?? notebook?.name ?? recent?.name
    if (!grant) {
      await load()
      return
    }
    await openDesign(grant, {
      grant,
      ...(displayName ? { displayName } : {}),
      ...(recentId ? { recentId } : {}),
    })
    if (!queue.isCurrent(admittedLifetime)) return
  }

  function addCurrentDesignToNotebook(sectionId: string | null): Promise<boolean> {
    const admittedDesign = currentDesign.value
    if (admittedDesign === null) return Promise.resolve(false)
    const admittedPath = activePath.value

    return queue.enqueue(false, async (admittedLifetime) => {
      if (
        currentDesign.value !== admittedDesign
        || activePath.value !== admittedPath
      ) return false
      let savedKey: string
      let savedDesign: CanopiFile
      if (admittedPath) {
        // A file home holds every edit once continuous save flushes (not a Save: a clean file is not rewritten).
        const written = await saveCurrent()
        if (!queue.isCurrent(admittedLifetime)) return false
        const design = currentDesign.value
        if (!written || activePath.value !== admittedPath || !design) return false
        savedKey = admittedPath
        savedDesign = design
      } else {
        const settlement = await saveAsCurrent()
        if (!queue.isCurrent(admittedLifetime)) return false
        if (settlement?.status !== 'applied' || !settlement.path) return false
        savedKey = settlement.path
        savedDesign = settlement.content as unknown as Readonly<CanopiFile>
      }

      await addDesignReferenceAdapter(savedKey, savedDesign)
      if (!queue.isCurrent(admittedLifetime)) return false
      const snapshot = await loadNotebook()
      if (!queue.isCurrent(admittedLifetime)) return false
      writeSnapshot(snapshot)

      const currentRecentId = activeRecentId.value
      const addedEntry = snapshot.entries.find(
        (entry) =>
          (currentRecentId !== null && entry.recent_id === currentRecentId)
          || entry.grant === savedKey
          || entry.path === savedKey,
      )
      const storedPath = addedEntry?.path ?? savedKey
      const targetSectionId = validSectionId(sectionId, sections.value)
      if (targetSectionId) {
        await moveEntryToSectionAdapter(storedPath, targetSectionId)
        if (!queue.isCurrent(admittedLifetime)) return false
        entries.value = entries.value.map((entry) =>
          entry.path === storedPath
            ? { ...entry, section_id: targetSectionId }
            : entry
        )
      }

      return entries.value.some((entry) => entry.path === storedPath)
    })
  }

  function removeEntry(path: string): Promise<void> {
    if (path.trim().length === 0) return Promise.resolve()
    return queue.enqueue(undefined, async (admittedLifetime) => {
      await removeEntryAdapter(path)
      if (!queue.isCurrent(admittedLifetime)) return
      entries.value = entries.value.filter((entry) => entry.path !== path)
    })
  }

  function createSection(name: string): Promise<void> {
    const normalizedName = normalizeSectionName(name)
    if (!normalizedName) return Promise.resolve()
    return queue.enqueue(undefined, async (admittedLifetime) => {
      const section = await createSectionAdapter(normalizedName)
      if (!queue.isCurrent(admittedLifetime)) return
      sections.value = [...sections.value, section].sort(compareNotebookSections)
    })
  }

  function renameSection(sectionId: string, name: string): Promise<void> {
    const normalizedName = normalizeSectionName(name)
    if (!normalizedName) return Promise.resolve()
    return queue.enqueue(undefined, async (admittedLifetime) => {
      await renameSectionAdapter(sectionId, normalizedName)
      if (!queue.isCurrent(admittedLifetime)) return
      sections.value = sections.value.map((section) =>
        section.id === sectionId
          ? { ...section, name: normalizedName }
          : section
      )
    })
  }

  function deleteSection(sectionId: string): Promise<void> {
    return queue.enqueue(undefined, async (admittedLifetime) => {
      await deleteSectionAdapter(sectionId)
      if (!queue.isCurrent(admittedLifetime)) return
      sections.value = sections.value.filter((section) => section.id !== sectionId)
      entries.value = entries.value.map((entry) =>
        entry.section_id === sectionId
          ? { ...entry, section_id: null }
          : entry
      )
    })
  }

  function moveEntryToSection(path: string, sectionId: string | null): Promise<void> {
    return queue.enqueue(undefined, async (admittedLifetime) => {
      await moveEntryToSectionAdapter(path, sectionId)
      if (!queue.isCurrent(admittedLifetime)) return
      entries.value = entries.value.map((entry) =>
        entry.path === path
          ? { ...entry, section_id: sectionId }
          : entry
      )
    })
  }

  function reorderSections(sectionIds: readonly string[]): Promise<void> {
    const nextOrder = [...sectionIds]
    return queue.enqueue(undefined, async (admittedLifetime) => {
      await reorderSectionsAdapter(nextOrder)
      if (!queue.isCurrent(admittedLifetime)) return
      sections.value = applyManualOrder(
        sections.value,
        nextOrder,
        (section) => section.id,
        (section, sortOrder) => ({ ...section, sort_order: sortOrder }),
        compareNotebookSections,
      )
    })
  }

  function reorderEntries(paths: readonly string[]): Promise<void> {
    const nextOrder = [...paths]
    return queue.enqueue(undefined, async (admittedLifetime) => {
      await reorderEntriesAdapter(nextOrder)
      if (!queue.isCurrent(admittedLifetime)) return
      entries.value = applyManualOrder(
        entries.value,
        nextOrder,
        (entry) => entry.path,
        (entry, sortOrder) => ({ ...entry, sort_order: sortOrder }),
        compareNotebookEntries,
      )
    })
  }

  function relocateEntry(path: string, sectionId: string | null, paths: readonly string[]): Promise<void> {
    const nextOrder = [...paths]
    const lifetime = queue.lifetime
    return queue.enqueue(undefined, async (admittedLifetime) => {
      if (!entries.value.some((entry) => entry.path === path)
        || (sectionId !== null && !sections.value.some((section) => section.id === sectionId))) {
        throw new Error('Design Notebook relocation destination is no longer available')
      }
      await relocateEntryAdapter(path, sectionId, nextOrder)
      if (!queue.isCurrent(admittedLifetime)) return
      entries.value = applyManualOrder(
        entries.value.map((entry) => entry.path === path ? { ...entry, section_id: sectionId } : entry),
        nextOrder,
        (entry) => entry.path,
        (entry, sortOrder) => ({ ...entry, sort_order: sortOrder }),
        compareNotebookEntries,
      )
    }).catch(async (error) => {
      // Refresh only after releasing mutation admission: load joins that queue.
      if (queue.isCurrent(lifetime)) await load()
      throw error
    })
  }

  function dispose(): void {
    if (queue.disposed) return
    queue.dispose()
    generation += 1
    recentGeneration += 1
  }


  return {
    view,
    load,
    loadRecentDesigns,
    refresh: load,
    openEntry,
    addCurrentDesignToNotebook,
    removeEntry,
    createSection,
    renameSection,
    deleteSection,
    moveEntryToSection,
    reorderSections,
    reorderEntries,
    relocateEntry,
    dispose,
  }
}

export const designNotebookWorkbench = createDesignNotebookWorkbench()

function normalizeSectionName(value: string): string {
  return value.trim()
}

function validSectionId(
  sectionId: string | null,
  availableSections: readonly DesignNotebookSection[],
): string | null {
  const normalized = sectionId?.trim()
  if (!normalized) return null
  return availableSections.some((section) => section.id === normalized) ? normalized : null
}

function applyManualOrder<T>(
  items: readonly T[],
  orderedKeys: readonly string[],
  keyForItem: (item: T) => string,
  withSortOrder: (item: T, sortOrder: number) => T,
  compare: (left: T, right: T) => number,
): readonly T[] {
  const orderByKey = new Map(orderedKeys.map((key, index) => [key, index]))
  return items
    .map((item) => {
      const order = orderByKey.get(keyForItem(item))
      return order === undefined ? item : withSortOrder(item, order)
    })
    .sort(compare)
}

function compareNotebookSections(left: DesignNotebookSection, right: DesignNotebookSection): number {
  return left.sort_order - right.sort_order
    || left.created_at.localeCompare(right.created_at)
    || left.id.localeCompare(right.id)
}

function compareNotebookEntries(left: DesignNotebookEntry, right: DesignNotebookEntry): number {
  return left.sort_order - right.sort_order
    || right.updated_at.localeCompare(left.updated_at)
    || left.path.localeCompare(right.path)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    designNotebookWorkbench.dispose()
  })
}
