import { describe, expect, it, vi } from 'vitest'
import { createBrowserDesignTemplateImportWorkflow } from '../app/design-template-import/workflow.browser'
import type { TemplateMeta } from '../types/community'
import type { CanopiFile } from '../types/design'

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
  download_url: '/templates/forest-edge.canopi',
}

describe('Web Edition Design Template import workflow', () => {
  it('fetches a configured static .canopi asset and opens it as a browser template', async () => {
    const templateFile = makeCanopiFile({ name: 'Downloaded Template' })
    const templateText = JSON.stringify(templateFile)
    const fetchTemplateAsset = vi.fn(async () => new Response(templateText))
    const openCanopiTemplate = vi.fn(async () => 'opened' as const)
    const workflow = createBrowserDesignTemplateImportWorkflow({
      baseUrl: 'https://web.canopi.test/',
      fetchTemplateAsset,
      openCanopiTemplate,
    })

    await expect(workflow.importTemplate(TEMPLATE)).resolves.toBe('opened')

    expect(fetchTemplateAsset).toHaveBeenCalledWith('https://web.canopi.test/templates/forest-edge.canopi')
    expect(openCanopiTemplate).toHaveBeenCalledWith(
      {
        name: 'Forest Edge',
        file: { ...templateFile, extra: {} },
      },
      { isCancelled: expect.any(Function) },
    )
  })

  it('rejects malformed static assets at the Web ingestion boundary before opening', async () => {
    const fetchTemplateAsset = vi.fn(async () => new Response(JSON.stringify({
      ...makeCanopiFile(),
      zones: [{ id: 'zone-missing-fields' }],
    })))
    const openCanopiTemplate = vi.fn(async () => 'opened' as const)
    const workflow = createBrowserDesignTemplateImportWorkflow({
      baseUrl: 'https://web.canopi.test/',
      fetchTemplateAsset,
      openCanopiTemplate,
    })

    await expect(workflow.importTemplate(TEMPLATE))
      .rejects.toThrow('$.zones[0].points: missing required value')

    expect(openCanopiTemplate).not.toHaveBeenCalled()
  })

  it('rejects arbitrary remote template URLs before fetching', async () => {
    const fetchTemplateAsset = vi.fn(async () => new Response(''))
    const openCanopiTemplate = vi.fn(async () => 'opened' as const)
    const workflow = createBrowserDesignTemplateImportWorkflow({
      baseUrl: 'https://web.canopi.test/',
      fetchTemplateAsset,
      openCanopiTemplate,
    })

    await expect(workflow.importTemplate({
      ...TEMPLATE,
      download_url: 'https://templates.example.net/forest-edge.canopi',
    })).rejects.toThrow('Static Design Template asset origin is not allowed')

    expect(fetchTemplateAsset).not.toHaveBeenCalled()
    expect(openCanopiTemplate).not.toHaveBeenCalled()
  })
})

function makeCanopiFile(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Test Template',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: {},
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
    views: [],
    stories: [],
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    ...overrides,
  }
}
