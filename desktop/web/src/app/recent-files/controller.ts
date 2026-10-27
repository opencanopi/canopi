import { signal, type Signal } from '@preact/signals'
import {
  getRecentDesignPreviews,
  getRecentFiles,
  removeRecentDesign,
  showRecentDesignInFolder,
} from '../../ipc/design'
import type { DesignSummary, RecentDesignPreview } from '../../types/design'

export interface RecentFilesController {
  recentFiles: Signal<DesignSummary[]>
  /**
   * What each listed Design's file says about it (counts and sketch), by path.
   * A path is missing until its file has been read, or when reading failed as
   * a whole; the row then shows the name only.
   */
  previews: Signal<ReadonlyMap<string, RecentDesignPreview>>
  /** Lists the Designs, then reads their previews without holding up the list. */
  load(): Promise<void>
  /** Forget a Design on the list; the file is untouched. */
  remove(path: string): Promise<void>
  /**
   * Open the folder of a Design on the list, with the file selected. It never rejects: a failure (no file manager,
   * the file gone) raises `revealFailure`, which the Start screen shows as a toast that names no path (2.1-Q227).
   */
  showInFolder(path: string): Promise<void>
  /** The latest failed Show in folder, until dismissed; a new failure replaces it with a new token. */
  revealFailure: Signal<RevealFailure | null>
  /** Clears `failure` if it is still the one shown; an older token leaves a newer failure in place. */
  dismissRevealFailure(failure: RevealFailure): void
  dispose(): void
}

/** One failed Show in folder: an opaque token, so a toast keyed on it restarts for each new failure. */
export interface RevealFailure {
  readonly id: number
}

interface CreateRecentFilesControllerOptions {
  loadRecentFiles?: typeof getRecentFiles
  loadPreviews?: typeof getRecentDesignPreviews
  removeRecentFile?: typeof removeRecentDesign
  showRecentFileInFolder?: typeof showRecentDesignInFolder
  maxItems?: number
}

export function createRecentFilesController(
  options: CreateRecentFilesControllerOptions = {},
): RecentFilesController {
  const loadRecentFiles = options.loadRecentFiles ?? getRecentFiles
  const loadPreviews = options.loadPreviews ?? getRecentDesignPreviews
  const removeRecentFile = options.removeRecentFile ?? removeRecentDesign
  const revealInFolder = options.showRecentFileInFolder ?? showRecentDesignInFolder
  const maxItems = options.maxItems ?? 5
  const recentFiles = signal<DesignSummary[]>([])
  const previews = signal<ReadonlyMap<string, RecentDesignPreview>>(new Map())
  const revealFailure = signal<RevealFailure | null>(null)
  let nextRevealFailure = 0

  let disposed = false
  let generation = 0

  async function load(): Promise<void> {
    const requestGeneration = ++generation
    const current = () => !disposed && requestGeneration === generation
    let files: DesignSummary[]
    try {
      files = (await loadRecentFiles()).slice(0, maxItems)
    } catch {
      if (current()) recentFiles.value = []
      return
    }
    if (!current()) return
    recentFiles.value = files
    const missing = files.map((file) => file.path).filter((path) => !previews.value.has(path))
    if (missing.length === 0) return
    void loadPreviews(missing).then((summaries) => {
      if (disposed) return
      const next = new Map(previews.value)
      for (const summary of summaries) next.set(summary.path, summary.preview)
      previews.value = next
    }, (error: unknown) => {
      // The list stays usable with names only.
      console.warn('Recent Design previews are unavailable:', error)
    })
  }

  async function remove(path: string): Promise<void> {
    await removeRecentFile(path)
    if (disposed) return
    // A load in flight may still list it; the next one will not.
    recentFiles.value = recentFiles.value.filter((file) => file.path !== path)
    await load()
  }

  async function showInFolder(path: string): Promise<void> {
    try {
      await revealInFolder(path)
    } catch (error) {
      // The host's message may name the path; it stays in the log, never on the page.
      console.warn('Show in folder failed:', error)
      if (!disposed) revealFailure.value = { id: ++nextRevealFailure }
    }
  }

  function dismissRevealFailure(failure: RevealFailure): void {
    if (revealFailure.value === failure) revealFailure.value = null
  }

  function dispose(): void {
    disposed = true
    generation += 1
  }

  return {
    recentFiles,
    previews,
    load,
    remove,
    showInFolder,
    revealFailure,
    dismissRevealFailure,
    dispose,
  }
}
