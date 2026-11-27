// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSpeciesCatalogWorkbench, speciesCatalogWorkbench } from '../../app/plant-browser'
import { getCanvasPlantNameLabels } from '../../canvas/runtime/automatic-detail'
import { DEFAULT_PLANT_DISPLAY } from '../../canvas/runtime/plant-display'
import { createTestSceneRendererSnapshot } from '../../__tests__/support/scene-renderer-snapshot'
import { createBrowserCanvasRuntimeAppAdapter } from './browser-canvas-runtime'

describe('Web canvas common-name labels (2.1-Q25)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('canopi-f47t.52.69: the Web canvas label matches the plant panel\'s display name', async () => {
    const resolveDisplayNames = vi.fn(async (names: readonly string[], locale: string) => {
      const resolved: Record<string, string> = {}
      for (const name of names) {
        if (locale === 'fr' && name === 'Malus domestica') resolved[name] = 'Pommier'
      }
      return { names: resolved, englishFallbacks: [] as string[] }
    })
    const previousWorkbench = speciesCatalogWorkbench
    installSpeciesCatalogWorkbench({
      ...previousWorkbench,
      resolveDisplayNames,
    })

    try {
      const adapter = createBrowserCanvasRuntimeAppAdapter()
      const plantLabels = adapter.presentationData!.plantLabels!
      await plantLabels.ensureEntries(['Malus domestica'], 'fr')

      const localizedCommonNames = plantLabels.getLocaleSnapshot('fr')
      const snapshot = createTestSceneRendererSnapshot({
        scene: {
          plants: [{
            kind: 'plant',
            locked: false,
            id: 'plant-apple',
            canonicalName: 'Malus domestica',
            commonName: 'Apple',
            color: '#4E7D44',
            canopySpreadM: 4,
            position: { x: 0, y: 0 },
            rotationDeg: 0,
            notes: null,
            plantedDate: null,
            quantity: 1,
          }],
        },
        localizedCommonNames,
        plantDisplay: { ...DEFAULT_PLANT_DISPLAY, labels: 'names' },
      })

      const panelNames = await speciesCatalogWorkbench.resolveDisplayNames(['Malus domestica'], 'fr')
      const [canvasLabel] = getCanvasPlantNameLabels(snapshot, 120)

      expect(panelNames.names['Malus domestica']).toBe('Pommier')
      expect(canvasLabel?.text).toBe(panelNames.names['Malus domestica'])
    } finally {
      installSpeciesCatalogWorkbench(previousWorkbench)
    }
  })
})
