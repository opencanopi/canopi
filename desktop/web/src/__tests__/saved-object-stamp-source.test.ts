import { describe, expect, it } from 'vitest'
import { parseSavedObjectStampPayload, type SavedObjectStampPayload } from '../canvas/saved-object-stamp-payload'
import { isSavedObjectStampPayloadFromBefore2_0 } from '../app/saved-object-stamps/row-state'
import type { SavedObjectStamp } from '../types/saved-object-stamps'
import {
  hasSavedObjectStampDragData,
  readSavedObjectStampDragData,
  writeSavedObjectStampDragData,
} from '../canvas/saved-object-stamp-source'

function payload(): SavedObjectStampPayload {
  return {
    version: 2,
    anchor: { x: 10, y: 20 },
    plants: [{
      id: 'plant-1',
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: null,
      symbol: null,
      position: { x: 10, y: 20 },
      rotationDeg: null,
      scale: 2,
    }],
    zones: [],
    annotations: [],
    groups: [],
  }
}

function stamp(overrides: Partial<SavedObjectStamp> = {}): SavedObjectStamp {
  return {
    id: 'stamp-1',
    name: 'Apple guild',
    payload_json: JSON.stringify(payload()),
    sort_order: 0,
    created_at: '2026-06-19T09:00:00Z',
    updated_at: '2026-06-19T09:00:00Z',
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

describe('Saved Object Stamp source', () => {
  it('centralizes drag data serialization and parsing', () => {
    const dataTransfer = dragDataStore()

    writeSavedObjectStampDragData(dataTransfer, stamp())

    expect(dataTransfer.effectAllowed).toBe('copy')
    expect(readSavedObjectStampDragData(dataTransfer)).toEqual(payload())
  })

  it('detects browser-protected drag data from the Saved Object Stamp MIME type', () => {
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

    writeSavedObjectStampDragData(dataTransfer, stamp())

    expect(hasSavedObjectStampDragData(dataTransfer)).toBe(true)
    expect(readSavedObjectStampDragData(dataTransfer)).toBeNull()

    protectedDragData = false
    expect(readSavedObjectStampDragData(dataTransfer)?.plants[0]?.canonicalName)
      .toBe('Malus domestica')
  })

  it('keeps a zone\'s display name apart from its id, and reads only the current payload version', () => {
    const zone = { id: 'zone-1', zoneType: 'rect', points: [{ x: 0, y: 0 }, { x: 2, y: 2 }], rotationDeg: 0, fillColor: null }
    const named = parseSavedObjectStampPayload(JSON.stringify({ ...payload(), zones: [{ ...zone, name: 'Kitchen bed' }] }))
    expect(named?.zones[0]).toMatchObject({ id: 'zone-1', name: 'Kitchen bed' })
    const unnamed = parseSavedObjectStampPayload(JSON.stringify({ ...payload(), zones: [zone] }))
    expect(unnamed?.zones[0]?.name).toBeNull()

    // Canopi 2.0 breaks stored data (ADR 0021): a version 1 payload, written
    // before 2.0, is not upgraded; neither is anything newer than the app.
    expect(parseSavedObjectStampPayload(JSON.stringify({ ...payload(), version: 1, zones: [{ ...zone, name: 'Kitchen bed' }] }))).toBeNull()
    expect(parseSavedObjectStampPayload(JSON.stringify({ ...payload(), version: 0 }))).toBeNull()
    expect(parseSavedObjectStampPayload(JSON.stringify({ ...payload(), version: 3 }))).toBeNull()
  })

  it('tells a payload saved before 2.0 (version 1) apart from a current or damaged one', () => {
    const before2_0 = JSON.stringify({ ...payload(), version: 1 })
    expect(isSavedObjectStampPayloadFromBefore2_0(before2_0)).toBe(true)
    expect(parseSavedObjectStampPayload(before2_0)).toBeNull()
    expect(isSavedObjectStampPayloadFromBefore2_0(JSON.stringify(payload()))).toBe(false)
    expect(isSavedObjectStampPayloadFromBefore2_0(JSON.stringify({ ...payload(), version: 3 }))).toBe(false)
    expect(isSavedObjectStampPayloadFromBefore2_0('{not json')).toBe(false)
    expect(isSavedObjectStampPayloadFromBefore2_0('')).toBe(false)
    expect(isSavedObjectStampPayloadFromBefore2_0('1')).toBe(false)
  })

  it('rejects invalid Saved Object Stamp drag payloads', () => {
    const dataTransfer = dragDataStore()
    dataTransfer.setData('application/x.canopi.saved-object-stamp+json', JSON.stringify({ version: 1 }))

    expect(readSavedObjectStampDragData(dataTransfer)).toBeNull()
    expect(hasSavedObjectStampDragData(dataTransfer)).toBe(false)
  })
})
