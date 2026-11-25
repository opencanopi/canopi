import type { TemplateMeta } from '../../types/community'
import type { CanopiFile } from '../../types/design'
import type { DesignTemplateEnvelope, DesignTemplateImportResult } from './types'

export interface DesignTemplateImportCoordinatorAdapters {
  readonly acquire: (template: TemplateMeta) => Promise<CanopiFile>
  readonly open: (
    envelope: DesignTemplateEnvelope,
    isCancelled: () => boolean,
  ) => Promise<Exclude<DesignTemplateImportResult, 'superseded'>>
}

export interface DesignTemplateImportCoordinator {
  importTemplate(template: TemplateMeta): Promise<DesignTemplateImportResult>
  dispose(): void
}

export function createDesignTemplateImportCoordinator(
  adapters: DesignTemplateImportCoordinatorAdapters,
): DesignTemplateImportCoordinator {
  let latestIntent = 0
  let disposed = false

  return Object.freeze({
    async importTemplate(template: TemplateMeta) {
      if (disposed) throw new Error('Design Template import coordinator is disposed')

      const intent = ++latestIntent
      const request = cloneTemplateMeta(template)
      const isCancelled = () => disposed || intent !== latestIntent

      try {
        const file = await adapters.acquire(request)
        if (isCancelled()) return 'superseded'

        const result = await adapters.open({
          file,
          name: request.title,
        }, isCancelled)
        return isCancelled() ? 'superseded' : result
      } catch (error) {
        if (isCancelled()) return 'superseded'
        throw error
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      latestIntent += 1
    },
  })
}

function cloneTemplateMeta(template: TemplateMeta): TemplateMeta {
  return {
    ...template,
    location: { ...template.location },
    tags: [...template.tags],
  }
}
