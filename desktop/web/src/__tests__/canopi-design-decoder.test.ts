import { describe, expect, it } from 'vitest'
import { pickCancelled } from '../ipc/dialogs'
import {
  CanopiDesignIngestionError,
  decodeCanopiDesign,
} from '../app/contracts/design-ingestion'
import {
  designLoadFailureMessageKey,
  designLoadFailureOf,
} from '../app/contracts/canopi-design-errors'
import {
  STORY_IMAGE_MAX_BYTES,
  STORY_IMAGES_MAX_TOTAL_BYTES,
} from '../generated/canopi-design-format'

describe('Canopi Design decoder', () => {
  it('rejects malformed nested fields with an actionable path', () => {
    const input = currentDesign({
      plants: [{
        id: 'plant-1',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        symbol: null,
        pinned_name: false,
        position: { lon: 'east', lat: 20 },
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
      }],
    })

    expect(() => decodeCanopiDesign(input)).toThrow(
      '$.plants[0].position.lon: expected a finite number',
    )
  })

  it.each([
    { version: undefined, displayed: 1 },
    { version: 1, displayed: 1 },
    { version: 6, displayed: 6 },
    { version: 7, displayed: 7 },
    { version: 8, displayed: 8 },
    { version: 10, displayed: 10 },
  ])('refuses any version but the current one: $displayed', ({ version, displayed }) => {
    const input = currentDesign()
    if (version === undefined) delete input.version
    else input.version = version

    expect(() => decodeCanopiDesign(input)).toThrow(
      `$.version: unsupported Canopi Design version ${displayed}; Canopi 2.0 and later open only version 9`,
    )
    expectKind(() => decodeCanopiDesign(input), 'unsupported_version')
  })

  it.each([
    { version: 7, kind: 'older_version' },
    { version: 8, kind: 'older_version' },
    { version: 10, kind: 'newer_version' },
  ])('tells a Design from before Canopi 2.0 apart from a newer one: v$version', ({ version, kind }) => {
    try {
      decodeCanopiDesign(currentDesign({ version }))
      expect.fail('expected the version to be refused')
    } catch (error) {
      expect(designLoadFailureOf(error)?.kind).toBe(kind)
    }
    expect(designLoadFailureMessageKey('older_version')).toBe('start.cantReadOlderVersion')
  })

  it('refuses a Canopi 1.2 Design (v6 with a spatial frame) as an older version, never as damaged', () => {
    const canopi12 = currentDesign({
      version: 6,
      spatial_frame: { anchor_longitude_deg: 13, anchor_latitude_deg: 23, north_bearing_deg: 0, placement_status: 'confirmed' },
    })
    expect(() => decodeCanopiDesign(canopi12)).toThrow(
      '$.version: unsupported Canopi Design version 6; Canopi 2.0 and later open only version 9',
    )
    expectKind(() => decodeCanopiDesign(canopi12), 'unsupported_version')
  })

  it.each([0, 1.5, Number.NaN])('rejects invalid version %s', (version) => {
    expect(() => decodeCanopiDesign(currentDesign({ version }))).toThrow(
      '$.version: expected a positive integer',
    )
  })

  it('admits a current-version Design with lon/lat positions', () => {
    const decoded = decodeCanopiDesign(currentDesign({
      plants: [plant('plant-1', 'Malus domestica')],
      zones: [{ id: 'zone-bed', name: 'Bed', zone_type: 'polygon', points: [{ lon: 2.35, lat: 48.85 }, { lon: 2.351, lat: 48.851 }] }],
    }))

    expect(decoded.version).toBe(9)
    expect(decoded.plants[0]!.position).toEqual({ lon: 13.0001, lat: 23.0002 })
    expect(decoded.zones[0]!.points).toEqual([{ lon: 2.35, lat: 48.85 }, { lon: 2.351, lat: 48.851 }])
  })

  it('caps embedded story images at 1 MiB each and 10 MiB per Design', () => {
    expect(STORY_IMAGE_MAX_BYTES).toBe(1024 * 1024)
    expect(STORY_IMAGES_MAX_TOTAL_BYTES).toBe(10 * STORY_IMAGE_MAX_BYTES)
    const full = dataUri(STORY_IMAGE_MAX_BYTES)
    const withImages = (sizes: readonly string[][]) => currentDesign({
      views: [savedView('view-1')],
      stories: [{
        id: 'story-1',
        name: 'Visit',
        steps: sizes.map((images, index) => ({
          id: `step-${index}`,
          view_id: 'view-1',
          title: 'Step',
          images: images.map((src) => ({ src, alt: '' })),
        })),
      }],
    })

    expect(decodeCanopiDesign(withImages([[full]])).stories?.[0]?.steps[0]?.images?.[0]?.src).toBe(full)
    expect(() => decodeCanopiDesign(withImages([[dataUri(STORY_IMAGE_MAX_BYTES + 1)]]))).toThrow(
      `$.stories[0].steps[0].images[0].src: an embedded image holds at most ${STORY_IMAGE_MAX_BYTES} bytes`,
    )
    const tenFull = Array.from({ length: 10 }, () => [full])
    expect(() => decodeCanopiDesign(withImages(tenFull))).not.toThrow()
    expectKind(() => decodeCanopiDesign(withImages([...tenFull, [dataUri(1)]])), 'invalid_document')
    expect(() => decodeCanopiDesign(withImages([...tenFull, [dataUri(1)]]))).toThrow(
      `$.stories[0].steps[10].images[0].src: a Design embeds at most ${STORY_IMAGES_MAX_TOTAL_BYTES} bytes of images`,
    )
  })

  it.each([
    ['data:image/png;base64,not base64!', 'an embedded image must be valid base64 data'],
    ['data:image/png;base64,AAA', 'an embedded image must be valid base64 data'],
    ['data:image/png,raw', 'an embedded image must be base64 data'],
    ['http://example.org/a.png', 'images must be https: links or embedded PNG, JPEG, WebP or GIF data'],
  ])('refuses the story image source %s', (src, reason) => {
    const input = currentDesign({
      views: [savedView('view-1')],
      stories: [{ id: 'story-1', name: 'Visit', steps: [{ id: 'step-1', view_id: 'view-1', title: 'Step', images: [{ src }] }] }],
    })
    expect(() => decodeCanopiDesign(input)).toThrow(`$.stories[0].steps[0].images[0].src: ${reason}`)
  })

  it('admits the view a Design was saved with and refuses one outside the saved-view rules at $.map_view', () => {
    const mapView = { lon: 2.2944812345, lat: 48.8583701234, zoom: 19.25, bearing: 30.5, ground_size_m: { width: 312.5, height: 187.5 } }
    expect(decodeCanopiDesign(currentDesign({ map_view: mapView })).map_view).toEqual(mapView)
    expect('map_view' in decodeCanopiDesign(currentDesign()), 'a Design without it has none').toBe(false)

    const zeroWidth = currentDesign({ map_view: { ...mapView, ground_size_m: { width: 0, height: 187.5 } } })
    expect(() => decodeCanopiDesign(zeroWidth)).toThrow(
      '$.map_view.ground_size_m: expected a finite width and height above 0 and at most 100000000 m',
    )
    expectKind(() => decodeCanopiDesign(zeroWidth), 'invalid_document')
    expectKind(() => decodeCanopiDesign(currentDesign({ map_view: { ...mapView, zoom: 27.5 } })), 'invalid_document')
  })

  it.each(['location', 'north_bearing_deg', 'spatial_frame'])('keeps an earlier root field %s as unknown data in a current Design', (key) => {
    // Canopi 2.0 positions are lon/lat on each object; the 1.x root fields are no longer refused, only carried.
    expect(decodeCanopiDesign(currentDesign({ [key]: null })).extra).toEqual({ [key]: null })
  })

  it.each([
    {
      position: { lon: 180.0001, lat: 0 },
      message: '$.plants[0].position.lon: expected a number less than or equal to 180',
    },
    {
      position: { lon: -180.0001, lat: 0 },
      message: '$.plants[0].position.lon: expected a number greater than or equal to -180',
    },
    {
      position: { lon: 0, lat: 85.0511287798067 },
      message: '$.plants[0].position.lat: expected a number less than or equal to 85.0511287798066',
    },
    {
      position: { lon: 0, lat: -85.0511287798067 },
      message: '$.plants[0].position.lat: expected a number greater than or equal to -85.0511287798066',
    },
    {
      position: { lon: 0, lat: Number.POSITIVE_INFINITY },
      message: '$.plants[0].position.lat: expected a finite number',
    },
  ])('rejects out-of-range lon/lat $message', ({ position, message }) => {
    const input = currentDesign({
      plants: [{ ...plant('plant-1', 'Malus domestica'), position }],
    })
    expect(() => decodeCanopiDesign(input)).toThrow(message)
    expectKind(() => decodeCanopiDesign(input), 'invalid_document')
  })

  it('rejects local-metre {x, y} positions', () => {
    const input = currentDesign({
      plants: [{ ...plant('plant-1', 'Malus domestica'), position: { x: 10, y: 20 } }],
    })
    expect(() => decodeCanopiDesign(input)).toThrow(/^\$\.plants\[0\]\.position\.(lon|lat): missing required value$/)
    expectKind(() => decodeCanopiDesign(input), 'invalid_document')
  })

  it('materializes serde defaults and keeps only root unknown fields in extra', () => {
    const input = currentDesign({
      description: undefined,
      future_top_level: { enabled: true },
      zones: [{
        id: 'zone-orchard',
        zone_type: 'bed',
        points: [],
        future_nested: 'ignored like serde',
      }],
    })
    delete input.description

    const decoded = decodeCanopiDesign(input)

    expect(decoded.description).toBeNull()
    expect(decoded.zones[0]).toEqual({
      id: 'zone-orchard',
      name: null,
      locked: false,
      zone_type: 'bed',
      points: [],
      rotation: 0,
      fill_color: null,
      notes: null,
    })
    expect(decoded.extra).toEqual({
      future_top_level: { enabled: true },
    })
  })

  it('refuses a root extra key: unknown fields are carried at the root, never nested', () => {
    const input = currentDesign({ extra: { preserved: 'no' } })
    expect(() => decodeCanopiDesign(input)).toThrow(/^\$\.extra: /)
    expectKind(() => decodeCanopiDesign(input), 'invalid_document')
  })

  it('rejects malformed tagged targets at their discriminator', () => {
    const input = currentDesign({
      timeline: [{
        id: 'action-1',
        action_type: 'plant',
        description: 'Plant',
        targets: [{ kind: 'future-kind' }],
        completed: false,
        order: 0,
      }],
    })

    expect(() => decodeCanopiDesign(input)).toThrow(
      '$.timeline[0].targets[0].kind: expected one of "placed_plant", "species", "zone", "manual", "none"',
    )
  })

  it('preserves unsafe-looking root keys as data without changing prototypes', () => {
    const input = currentDesign()
    Object.defineProperty(input, '__proto__', {
      enumerable: true,
      value: { polluted: true },
    })

    const decoded = decodeCanopiDesign(input)

    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(decoded.extra)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(decoded.extra, '__proto__')).toBe(true)
    expect(decoded.extra?.['__proto__']).toEqual({ polluted: true })
  })

  it('rejects missing required root fields', () => {
    const input = currentDesign()
    delete input.name

    expect(() => decodeCanopiDesign(input)).toThrow('$.name: missing required value')
  })

  it.each([
    {
      input: () => currentDesign({
        plants: [{ ...plant('plant-1', 'Malus domestica'), quantity: 4_294_967_296 }],
      }),
      message: '$.plants[0].quantity: expected an unsigned 32-bit integer',
    },
    {
      input: () => currentDesign({
        timeline: [{
          id: 'action-1',
          action_type: 'plant',
          description: 'Plant',
          completed: false,
          order: 2_147_483_648,
        }],
      }),
      message: '$.timeline[0].order: expected a signed 32-bit integer',
    },
    {
      input: () => currentDesign({
        layers: [{ name: 'plants', visible: true, locked: false, opacity: Number.MAX_VALUE }],
      }),
      message: '$.layers[0].opacity: expected a finite 32-bit number',
    },
  ])('enforces generated Rust numeric bounds at runtime', ({ input, message }) => {
    expect(() => decodeCanopiDesign(input())).toThrow(message)
  })
})

describe('Design ingestion outcomes and typed load failures', () => {
  it('maps every load error to a kind and a Start-screen string, never "invalid" for an older file', () => {
    expect(designLoadFailureOf({ kind: 'older_version', message: 'too old' })).toEqual({ kind: 'older_version', message: 'too old' })
    expect(designLoadFailureOf({ kind: 'bogus', message: 'x' })).toBeNull()
    expect(designLoadFailureOf({ kind: 'toString', message: 'x' })).toBeNull()
    expect(designLoadFailureOf(pickCancelled('dialog.pick_open'))).toBeNull()
    const tooOld = (() => { try { decodeCanopiDesign(currentDesign({ version: 8 })) } catch (error) { return error } })()
    expect(tooOld).toBeInstanceOf(CanopiDesignIngestionError)
    expect(designLoadFailureOf(tooOld)).toMatchObject({ kind: 'older_version' })
    const tooNew = (() => { try { decodeCanopiDesign({ version: 10 }) } catch (error) { return error } })()
    expect(designLoadFailureOf(tooNew)).toMatchObject({ kind: 'newer_version' })
    expect(designLoadFailureOf(new CanopiDesignIngestionError('invalid_document', '$.plants'))).toMatchObject({ kind: 'invalid_document' })

    expect(designLoadFailureMessageKey('older_version')).toBe('start.cantReadOlderVersion')
    expect(designLoadFailureMessageKey('newer_version')).toBe('start.cantReadNewerVersion')
    expect(designLoadFailureMessageKey('missing')).toBe('start.cantReadMissing')
    expect(designLoadFailureMessageKey('invalid_json')).toBe('start.cantReadDamaged')
    expect(designLoadFailureMessageKey('invalid_document')).toBe('start.cantReadDamaged')
    expect(designLoadFailureMessageKey('too_large')).toBe('start.cantRead')
    expect(designLoadFailureMessageKey('internal')).toBe('start.cantRead')
  })
})

function expectKind(run: () => unknown, kind: CanopiDesignIngestionError['kind']): void {
  try {
    run()
    expect.fail(`expected ${kind}`)
  } catch (error) {
    expect(error).toBeInstanceOf(CanopiDesignIngestionError)
    expect((error as CanopiDesignIngestionError).kind).toBe(kind)
  }
}

function plant(id: string, canonicalName: string): Record<string, unknown> {
  return {
    id,
    canonical_name: canonicalName,
    position: { lon: 13.0001, lat: 23.0002 },
  }
}

function dataUri(decodedBytes: number): string {
  const tail = decodedBytes % 3 === 1 ? 'AA==' : decodedBytes % 3 === 2 ? 'AAA=' : ''
  return `data:image/png;base64,${'AAAA'.repeat(Math.floor(decodedBytes / 3))}${tail}`
}

function savedView(id: string): Record<string, unknown> {
  return {
    id,
    name: 'Orchard',
    camera: { lon: 2, lat: 48, zoom: 17, bearing: 0, ground_size_m: { width: 300, height: 200 } },
    visible_layers: {
      background: { kind: 'satellite' },
      terrain: { contours: false, hillshade: false },
      scene_layers: [],
      site_data: [],
    },
    highlighted: { species: [], objects: [] },
    title: null,
    text: [],
  }
}

function currentDesign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 9,
    name: 'Garden',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    ...overrides,
  }
}
