// Every catalogue code maps to one message or is silent (contracts §2, §13; 2.1-M413): the mapped type makes a missing
// kind a type error, and these cases pin which codes are silent, that every key exists, and the wording rules.
import { describe, expect, it } from 'vitest'
import type { FailureCode, IoFailureKind, Lane, LibraryReadOnlyReason, NetworkFailureKind, PlantCatalogCause, StoreId } from '../generated/contracts'
import en from '../i18n/en.json'
import { failureMessage } from './messages'

type Kind = FailureCode['kind']
type CodeOf<K extends Kind> = Extract<FailureCode, { kind: K }>

const keysOf = <T extends string>(table: Record<T, true>) => Object.keys(table) as T[]
const LANES = keysOf<Lane>({ catalog: true, user_data: true, library: true, local: true, network: true })
const CAUSES = keysOf<PlantCatalogCause>({ missing: true, open_failed: true })
const REASONS = keysOf<LibraryReadOnlyReason>({ refused_newer: true, unavailable: true })
const IO = keysOf<IoFailureKind>({ not_found: true, permission_denied: true, read_only: true, no_space: true, too_large: true, other: true })
const NETWORK = keysOf<NetworkFailureKind>({ timeout: true, offline: true, status: true, host_not_allowed: true, too_large: true })
const STORES = keysOf<StoreId>({
  plant_catalog: true, user_db: true, settings: true, library_catalogue: true, web_drafts: true, web_species_lists: true,
})

// One example per code and sub-kind; a kind the catalogue adds is a type error here until it has its examples.
const EXAMPLES: { readonly [K in Kind]: readonly CodeOf<K>[] } = {
  busy: LANES.map((lane) => ({ kind: 'busy', lane })),
  cancelled: [{ kind: 'cancelled' }],
  unavailable: [{ kind: 'unavailable' }],
  panicked: [{ kind: 'panicked' }],
  join_failed: [{ kind: 'join_failed' }],
  dialog_already_open: [{ kind: 'dialog_already_open' }],
  plant_db_unavailable: CAUSES.map((cause) => ({ kind: 'plant_db_unavailable', cause })),
  library_read_only: REASONS.map((reason) => ({ kind: 'library_read_only', reason })),
  io: IO.map((io) => ({ kind: 'io', io })),
  network: NETWORK.map((network) => ({ kind: 'network', network })),
  invalid: [{ kind: 'invalid' }],
  internal: [{ kind: 'internal' }],
  style_failed: [{ kind: 'style_failed' }],
  tile_source_failed: [{ kind: 'tile_source_failed', layer: 'satellite' }],
  update_signature_refused: [{ kind: 'update_signature_refused' }],
  update_no_channel_entry: [{ kind: 'update_no_channel_entry', os: 'linux', arch: 'x86_64', bundle: 'appimage' }],
  update_admin_prompt_unavailable: [{ kind: 'update_admin_prompt_unavailable' }],
  update_admin_prompt_dismissed: [{ kind: 'update_admin_prompt_dismissed' }],
  update_admin_prompt_refused: [{ kind: 'update_admin_prompt_refused' }],
  update_location_not_writable: [{ kind: 'update_location_not_writable' }],
  update_install_failed: [{ kind: 'update_install_failed', bundle: 'deb' }],
  format_core_unavailable: [{ kind: 'format_core_unavailable' }],
  format_core_trapped: [{ kind: 'format_core_trapped' }],
  store_read_only: STORES.map((store) => ({ kind: 'store_read_only', store })),
}
const ALL: readonly FailureCode[] = Object.values(EXAMPLES).flat()

function english(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en)
}

describe('failure messages', () => {
  it('[1b-c1 canopi-f47t.52.35] every_code_has_a_message_or_is_silent', () => {
    const silent = new Set<Kind>()
    for (const code of ALL) {
      for (const storage of ['disk', 'device'] as const) {
        const key = failureMessage(code, 'library.list', { storage })
        if (key === null) silent.add(code.kind)
        else expect(typeof english(key), `${JSON.stringify(code)} with ${storage} storage: ${key}`).toBe('string')
      }
    }
    // A cancel, a second file dialog (2.1-Q284), the map failures until 2d's map status (2.1-Q300) and a write a
    // newer-read-only store refused, which its store's one notice tells (2.1-M487).
    expect([...silent].sort()).toEqual(['cancelled', 'dialog_already_open', 'store_read_only', 'style_failed', 'tile_source_failed'])
  })

  it('names the part that opens Designs when the format core fails, never a file (ADR 0025)', () => {
    const say = (code: FailureCode) => english(failureMessage(code, 'design.open', { storage: 'device' }) ?? '')
    expect(say({ kind: 'format_core_unavailable' })).toBe('Canopi couldn’t load the part that opens Designs. Try again, and report a problem if this keeps happening.')
    expect(say({ kind: 'format_core_trapped' })).toBe('Canopi stopped while reading this Design. Try again, and report a problem if this keeps happening.')
  })

  it('says what happened and what to do, with no codes (2.1-Q299, 2.1-Q289)', () => {
    const say = (code: FailureCode, storage: 'disk' | 'device' = 'disk') => english(failureMessage(code, 'design.save', { storage }) ?? '')
    expect(say({ kind: 'busy', lane: 'library' })).toBe('Canopi is busy with other work. Try again in a moment.')
    expect(say({ kind: 'io', io: 'no_space' })).toBe('Your disk is full. Free some space and try again.')
    expect(say({ kind: 'network', network: 'offline' })).toBe('Couldn’t connect. Check your connection and try again.')
    expect(say({ kind: 'internal' })).toBe('Something went wrong. You can try again or report a problem.')
    // A capability refines: browser storage is freed on the device, not on a disk.
    expect(say({ kind: 'io', io: 'no_space' }, 'device')).toBe('Your device’s storage is full. Free some space and try again.')
    for (const code of ALL) {
      const text = english(failureMessage(code, 'design.save', { storage: 'disk' }) ?? '')
      if (typeof text === 'string') expect(text).not.toMatch(/[a-z]+_[a-z_]+|\bcode\b/)
    }
  })
})
