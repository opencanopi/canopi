import { describe, expect, it } from 'vitest'
import {
  createStaticDesignTemplateCatalog,
  hasConfiguredStaticDesignTemplates,
} from '../app/community/catalog.browser'
import type { TemplateMeta } from '../types/community'

const TEMPLATE: TemplateMeta = {
  id: 'forest-edge',
  title: 'Forest Edge',
  author: 'Canopi',
  description: 'A static bundled template',
  location: { lat: 45.5, lon: -73.6 },
  plant_count: 18,
  climate_zone: 'Temperate',
  tags: ['forest'],
  screenshot_url: null,
  download_url: '/app/templates/forest-edge.canopi',
}

describe('Web Edition static Design Template catalog', () => {
  it('reports no configured static templates by default', () => {
    expect(hasConfiguredStaticDesignTemplates()).toBe(false)
  })

  it('serves configured static template metadata and previews from memory', async () => {
    const catalog = createStaticDesignTemplateCatalog({ templates: [TEMPLATE] })

    await expect(catalog.getTemplateCatalog()).resolves.toEqual([TEMPLATE])
    await expect(catalog.getTemplatePreview('forest-edge')).resolves.toEqual(TEMPLATE)
    expect(catalog.hasConfiguredStaticDesignTemplates()).toBe(true)
  })
})
