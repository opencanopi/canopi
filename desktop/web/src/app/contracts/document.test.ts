import { describe, expect, it } from 'vitest'
import {
  composeDocumentForSave,
  extractDocumentExtra,
  flattenDocumentForJson,
  isCurrentCanopiDocument,
  normalizeLoadedDocument,
  normalizeNewDocument,
} from './document'
import { parseCanopiJsonText } from '../../__tests__/support/design-wire'
import { CanopiDesignIngestionError } from './canopi-design-errors'

describe('app/contracts/document v10 helpers', () => {
  it('normalizes a minimal raw record and preserves unknown root keys in extra', () => {
    const doc = normalizeLoadedDocument({
      version: 10,
      extra: { future_nested: 1, name: 'ignored-known-key' },
      future_root: 'kept',
      site_data: { imports: [] },
    })
    expect(doc.name).toBe('')
    expect(doc.description).toBeNull()
    expect(doc.budget_currency).toBe('EUR')
    expect(doc.plants).toEqual([])
    expect(doc.plant_species_colors).toEqual({})
    expect(doc.site_data).toEqual({ imports: [] })
    expect(doc.extra).toEqual({ future_nested: 1, future_root: 'kept' })
  })

  it('normalizes a new Design keeping only requested extra keys and composes scene/document ownership', () => {
    const raw = normalizeLoadedDocument({
      version: 10,
      name: 'Base',
      extra: { keep_me: true, drop_me: true },
    })
    const fresh = normalizeNewDocument(raw, ['keep_me'])
    expect(fresh.extra).toEqual({ keep_me: true })

    const composed = composeDocumentForSave({
      metadata: { name: 'Saved', description: 'Notes' },
      document: fresh,
      canvas: normalizeLoadedDocument({ version: 10, updated_at: '2026-10-01T00:00:00Z' }),
    })
    expect(composed.name).toBe('Saved')
    expect(composed.description).toBe('Notes')
    expect(composed.updated_at).toBe('2026-10-01T00:00:00Z')
    expect(composed.extra).toEqual({ keep_me: true })
  })

  it('flattens extra keys back to root JSON and omits null optional sections', () => {
    const doc = normalizeLoadedDocument({
      version: 10,
      name: 'Orchard',
      extra: { custom_flag: 42, version: 999 },
      map_view: undefined,
    })
    const wire = flattenDocumentForJson(doc)
    expect(wire.version).toBe(10)
    expect(wire.name).toBe('Orchard')
    expect(wire.custom_flag).toBe(42)
    expect('extra' in wire).toBe(false)
    expect('map_view' in wire).toBe(false)
    expect(extractDocumentExtra(wire)).toEqual({ custom_flag: 42 })
  })

  it('parses JSON text and wraps SyntaxError in CanopiDesignIngestionError', () => {
    expect(parseCanopiJsonText('{"version":10}')).toEqual({ version: 10 })
    expect(() => parseCanopiJsonText('{bad')).toThrow(CanopiDesignIngestionError)
  })

  it('validates v9/v10 structural document shape with isCurrentCanopiDocument', () => {
    const valid = flattenDocumentForJson(normalizeLoadedDocument({ version: 10, name: 'Ok' }))
    expect(isCurrentCanopiDocument(valid)).toBe(true)
    expect(isCurrentCanopiDocument({ ...valid, version: 9 })).toBe(true)
    expect(isCurrentCanopiDocument(null)).toBe(false)
    expect(isCurrentCanopiDocument([])).toBe(false)
    expect(isCurrentCanopiDocument({ ...valid, extra: {} })).toBe(false)
    expect(isCurrentCanopiDocument({ ...valid, version: 11 })).toBe(false)
    expect(isCurrentCanopiDocument({ ...valid, plants: 'not-array' })).toBe(false)
  })
})
