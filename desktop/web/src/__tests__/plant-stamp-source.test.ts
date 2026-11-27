import { afterEach, describe, expect, it } from 'vitest'
import {
  hasPlantStampDragData,
  readPlantStampDropSource,
  recentPlantStampSources,
  recordRecentPlantStampSource,
  writePlantStampDragData,
} from '../canvas/stamp-drag-data'

function species(overrides = {}) {
  return {
    canonical_name: 'Malus domestica',
    common_name: 'Apple',
    stratum: 'high',
    width_max_m: 4,
    ...overrides,
  }
}

function dragDataStore() {
  const values = new Map<string, string>()
  return {
    values,
    effectAllowed: 'none',
    setData(type: string, value: string) {
      values.set(type, value)
    },
    getData(type: string) {
      return values.get(type) ?? ''
    },
  }
}

function dropEvent(dataTransfer: unknown): DragEvent {
  return { dataTransfer } as DragEvent
}

describe('Plant Stamp drag data and recent sources', () => {
  afterEach(() => {
    recentPlantStampSources.value = []
  })

  it('records recent plant stamp sources newest-first without duplicates', () => {
    recentPlantStampSources.value = []
    expect(recentPlantStampSources.value).toEqual([])

    recordRecentPlantStampSource(species())
    recordRecentPlantStampSource(species({ canonical_name: 'Pyrus communis', common_name: 'Pear' }))
    recordRecentPlantStampSource(species())

    expect(recentPlantStampSources.value.map((entry) => entry.canonical_name)).toEqual([
      'Malus domestica',
      'Pyrus communis',
    ])
  })

  it('centralizes drag data serialization and parsing', () => {
    const dataTransfer = dragDataStore()

    writePlantStampDragData(dataTransfer, species())

    expect(dataTransfer.effectAllowed).toBe('copy')
    expect(readPlantStampDropSource(dropEvent(dataTransfer))).toEqual({
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      stratum: 'high',
      width_max_m: 4,
    })
  })

  it('detects drag data from MIME types while browser-protected payload data is hidden', () => {
    const values = new Map<string, string>()
    let protectedDragData = true
    const dataTransfer = {
      effectAllowed: 'none',
      get types() {
        return Array.from(values.keys())
      },
      setData(type: string, value: string) {
        values.set(type, value)
      },
      getData(type: string) {
        if (protectedDragData) return ''
        return values.get(type) ?? ''
      },
    }

    writePlantStampDragData(dataTransfer, species())

    expect(hasPlantStampDragData(dataTransfer)).toBe(true)
    expect(readPlantStampDropSource(dropEvent(dataTransfer))).toBeNull()

    protectedDragData = false
    expect(readPlantStampDropSource(dropEvent(dataTransfer))?.canonical_name).toBe('Malus domestica')
  })

  it('does not trust protected text drag types without readable plant payload data', () => {
    const values = new Map<string, string>()
    let protectedDragData = true
    const dataTransfer = {
      get types() {
        return Array.from(values.keys())
      },
      setData(type: string, value: string) {
        values.set(type, value)
      },
      getData(type: string) {
        if (protectedDragData) return ''
        return values.get(type) ?? ''
      },
    }
    dataTransfer.setData('text/plain', JSON.stringify(species()))

    expect(hasPlantStampDragData(dataTransfer)).toBe(false)

    protectedDragData = false
    expect(readPlantStampDropSource(dropEvent(dataTransfer))?.canonical_name).toBe('Malus domestica')
    expect(hasPlantStampDragData(dataTransfer)).toBe(true)
  })

  it('rejects invalid drag data at the seam', () => {
    const dataTransfer = dragDataStore()
    dataTransfer.setData('text/plain', JSON.stringify({ common_name: 'No identity' }))

    expect(readPlantStampDropSource(dropEvent(dataTransfer))).toBeNull()
  })
})
