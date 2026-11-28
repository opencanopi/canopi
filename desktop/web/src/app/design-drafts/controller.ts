import { signal, type ReadonlySignal } from '@preact/signals'
import { deleteDesignDraft, listDesignDrafts } from '../../ipc/design'
import type { DesignDraftSummary } from '../../generated/contracts'

/** Desktop Design Drafts listed on the welcome screen. */
export interface DesignDraftsController {
  readonly drafts: ReadonlySignal<readonly DesignDraftSummary[]>
  load(): Promise<void>
  remove(id: string): Promise<void>
  dispose(): void
}

interface CreateDesignDraftsControllerOptions {
  readonly listDrafts?: typeof listDesignDrafts
  readonly deleteDraft?: typeof deleteDesignDraft
}

export function createDesignDraftsController(
  options: CreateDesignDraftsControllerOptions = {},
): DesignDraftsController {
  const listDrafts = options.listDrafts ?? listDesignDrafts
  const deleteDraft = options.deleteDraft ?? deleteDesignDraft
  const drafts = signal<readonly DesignDraftSummary[]>([])
  let disposed = false
  let generation = 0

  async function load(): Promise<void> {
    const requestGeneration = ++generation
    try {
      const listed = await listDrafts()
      if (disposed || requestGeneration !== generation) return
      drafts.value = listed
    } catch (error) {
      if (disposed || requestGeneration !== generation) return
      console.error('Failed to list Design Drafts:', error)
      drafts.value = []
    }
  }

  async function remove(id: string): Promise<void> {
    await deleteDraft(id)
    if (disposed) return
    drafts.value = drafts.value.filter((draft) => draft.id !== id)
  }

  return {
    drafts,
    load,
    remove,
    dispose() {
      disposed = true
      generation += 1
    },
  }
}
