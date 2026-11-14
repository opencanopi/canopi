// The read half of the 2.1 browser records (Step 2.0.4 R3-2, canopi-f47t.52.272; contracts §11, 2.1-M486, 2.1-Q320):
// settings record 2 and the species-list record 1 read from their 2.1 keys, from the frozen Web fixtures, and never
// written, moved aside or removed, whatever they hold.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSettingsRecord, readSpeciesListRecord, type BrowserStorage } from './browser-record'

interface FrozenRecord {
  readonly key: string
  readonly record: Record<string, unknown> & { readonly version: number }
}

function frozen(name: string): FrozenRecord {
  return JSON.parse(readFileSync(new URL(`../../../../spec/web/frozen/${name}`, import.meta.url), 'utf8')) as FrozenRecord
}

const SETTINGS = frozen('settings.json')
const SPECIES = frozen('species-lists.json')

/** A Storage over a map that fails any test whose read writes. */
function storage(entries: Record<string, string>): BrowserStorage & { readonly writes: string[] } {
  const map = new Map(Object.entries(entries))
  const writes: string[] = []
  return {
    writes,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key) => { writes.push(`set ${key}`) },
    removeItem: (key) => { writes.push(`remove ${key}`) },
  }
}

describe('browser records: the 2.1 settings and species-list records, read only', () => {
  it('reads the frozen settings record under its frozen key and version with every field, known or not, and writes nothing', () => {
    const store = storage({ [SETTINGS.key]: JSON.stringify(SETTINGS.record) })
    expect(readSettingsRecord(store)).toEqual({ state: 'current', record: SETTINGS.record })
    expect(store.writes).toEqual([])
  })

  it('reads the frozen species-list record under its frozen key and version and writes nothing', () => {
    const store = storage({ [SPECIES.key]: JSON.stringify(SPECIES.record) })
    expect(readSpeciesListRecord(store)).toEqual({ state: 'current', record: SPECIES.record })
    expect(store.writes).toEqual([])
  })

  it('reads a record above the frozen version for its known fields as newer', () => {
    const store = storage({
      [SETTINGS.key]: JSON.stringify({ ...SETTINGS.record, version: 3 }),
      [SPECIES.key]: JSON.stringify({ ...SPECIES.record, version: 2, folders: [{ name: 'Hedge' }] }),
    })
    expect(readSettingsRecord(store)).toEqual({ state: 'newer', version: 3, record: { ...SETTINGS.record, version: 3 } })
    expect(readSpeciesListRecord(store)).toEqual({ state: 'newer', version: 2, record: { ...SPECIES.record, version: 2 } })
    expect(store.writes).toEqual([])
  })

  it('reads an absent record as absent', () => {
    expect(readSettingsRecord(storage({}))).toEqual({ state: 'absent' })
    expect(readSpeciesListRecord(storage({}))).toEqual({ state: 'absent' })
  })

  it('keeps a record that is not JSON, not an object or below the frozen version as unreadable, never moved aside', () => {
    for (const raw of ['{not json', '[1]', 'null', JSON.stringify({ locale: 'de' }), JSON.stringify({ version: 0 }), JSON.stringify({ version: 1.5 }), JSON.stringify({ version: '2' })]) {
      const store = storage({ [SETTINGS.key]: raw, [SPECIES.key]: raw })
      expect(readSettingsRecord(store)).toEqual({ state: 'unreadable', raw })
      expect(readSpeciesListRecord(store)).toEqual({ state: 'unreadable', raw })
      expect(store.writes).toEqual([])
    }
    // Settings record 1 is 2.0's, kept under the v3 key: the 2.1 key never holds it.
    const one = JSON.stringify({ version: 1, locale: 'de' })
    expect(readSettingsRecord(storage({ [SETTINGS.key]: one }))).toEqual({ state: 'unreadable', raw: one })
  })

  it('leaves out a species entry that does not read and keeps at most 50 per list', () => {
    const many = Array.from({ length: 60 }, (_, at) => ({ canonical_name: `Species ${at}`, at: '2026-12-01T10:00:00.000Z' }))
    const store = storage({
      [SPECIES.key]: JSON.stringify({
        version: 1,
        favorites: [null, 'Malus domestica', { canonical_name: '', at: 'x' }, { canonical_name: 'Malus domestica' }, ...many],
        recently_viewed: 'Corylus avellana',
      }),
    })
    const read = readSpeciesListRecord(store)
    expect(read.state === 'current' && read.record.favorites).toEqual(many.slice(0, 50))
    expect(read.state === 'current' && read.record.recently_viewed).toEqual([])
  })
})
