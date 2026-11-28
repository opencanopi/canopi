import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSavedObjectStampPayload } from './saved-object-stamp-payload'

describe('saved-object-stamp-payload v3 cross-boundary contract (#487 B1)', () => {
  it('canopi-f47t.52.49: parses the canonical Rust v3 stamp fixture returned by get_saved_object_stamps', () => {
    const fixturePath = fileURLToPath(
      new URL('../../../../canopi-format/spec/stamps/v3/fixture.json', import.meta.url),
    )
    const raw = readFileSync(fixturePath, 'utf8').trim()
    const parsed = parseSavedObjectStampPayload(raw)

    expect(parsed).not.toBeNull()
    expect(parsed?.version).toBe(3)
    expect(parsed?.anchor).toEqual({ x: 0, y: 0 })
    expect(parsed?.plants).toHaveLength(1)
    expect(parsed?.plants[0]).toMatchObject({
      id: 'p-1',
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#C44230',
      symbol: 'broadleaf',
      position: { x: 2, y: 3 },
      rotationDeg: 15,
      scale: 4.5,
    })
    expect(parsed?.zones).toHaveLength(1)
    expect(parsed?.zones[0]).toMatchObject({
      id: 'z-1',
      name: 'Guild bed',
      zoneType: 'polygon',
      fillColor: '#88AA44',
    })
    expect(parsed?.annotations).toHaveLength(1)
    expect(parsed?.annotations[0]).toMatchObject({
      id: 'a-1',
      annotationType: 'text',
      text: 'Mulch ring',
      fontSize: 14,
    })
    expect(parsed?.groups).toHaveLength(1)
    expect(parsed?.groups[0]).toEqual({
      id: 'grp-1',
      name: 'Apple guild',
      members: [
        { kind: 'plant', id: 'p-1' },
        { kind: 'measurement-guide', id: 'g-1' },
      ],
    })
  })

  it('refuses v4 (newer) and v1 (pre-2.0) stamp payloads', () => {
    expect(parseSavedObjectStampPayload(JSON.stringify({ version: 4, anchor: { x: 0, y: 0 }, plants: [], zones: [], annotations: [], groups: [] }))).toBeNull()
    expect(parseSavedObjectStampPayload(JSON.stringify({ version: 1, anchor: { x: 0, y: 0 }, plants: [], zones: [], annotations: [], groups: [] }))).toBeNull()
  })
})
