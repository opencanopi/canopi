import type { TemplateMeta } from '../../types/community'
import { WEB_STATIC_DESIGN_TEMPLATES } from '../design-template-import/static-design-templates'

export interface StaticDesignTemplateCatalog {
  hasConfiguredStaticDesignTemplates(): boolean
  getTemplateCatalog(): Promise<TemplateMeta[]>
  getTemplatePreview(id: string): Promise<TemplateMeta>
}

export interface StaticDesignTemplateCatalogOptions {
  readonly templates: readonly TemplateMeta[]
}

export function createStaticDesignTemplateCatalog({
  templates,
}: StaticDesignTemplateCatalogOptions): StaticDesignTemplateCatalog {
  const templatesById = new Map(templates.map((template) => [template.id, template]))

  return {
    hasConfiguredStaticDesignTemplates() {
      return templates.length > 0
    },

    async getTemplateCatalog() {
      return [...templates]
    },

    async getTemplatePreview(id: string) {
      const template = templatesById.get(id)
      if (!template) throw new Error(`Static Design Template is not configured: ${id}`)
      return template
    },
  }
}

const STATIC_DESIGN_TEMPLATE_CATALOG = createStaticDesignTemplateCatalog({
  templates: WEB_STATIC_DESIGN_TEMPLATES,
})

export const hasConfiguredStaticDesignTemplates = () =>
  STATIC_DESIGN_TEMPLATE_CATALOG.hasConfiguredStaticDesignTemplates()

export const getTemplateCatalog = () =>
  STATIC_DESIGN_TEMPLATE_CATALOG.getTemplateCatalog()

export const getTemplatePreview = (id: string) =>
  STATIC_DESIGN_TEMPLATE_CATALOG.getTemplatePreview(id)
