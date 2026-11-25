/**
 * platform/settings.ts: Settings platform adapter port (A8 path move from
 * app/settings/platform-adapter.ts; extended in 2e-1 for patch writes, per-field
 * reset metadata, and external-tab storage subscriptions).
 */
import type { Settings } from '../types/settings'

export interface SettingsPlatformAdapter {
  load(): Settings | Promise<Settings>
  save(settings: Settings): Promise<void>
  /** Persists a changed-fields patch so stores preserve unknown keys (ADR 0026); preferred over `save` when present. */
  savePatch?(patch: Readonly<Record<string, unknown>>, settings: Settings): Promise<void>
  /**
   * Field keys reset during the most recent `load()` (E2, 2.1-Q54), cleared once read so
   * `projection.ts` raises the one-time `fields_reset` notice.
   */
  takeResetFields?(): readonly string[]
  /**
   * What a new profile on this host starts with over the host-independent defaults (2.1-Q309: Trackpad on a Mac,
   * 2.1-Q345: browser language, 2.1-Q169: region unit system), for a session whose record cannot be read; the
   * projection holds it in memory and writes nothing (2.1-M473). An adapter with no host-specific first run omits it.
   */
  firstRunSettings?(): Partial<Settings> & Readonly<Record<string, unknown>>
  /** Subscribes to external settings changes (e.g. another browser tab's `storage` event). */
  subscribe?(onExternalChange: () => void): () => void
}

/**
 * `current` with the adapter's first-run settings, except those the session already changed (`changed`), so a choice
 * made while the record was being read stands; null when nothing would change.
 */
export function withFirstRunSettings<T extends Record<string, unknown>>(
  adapter: SettingsPlatformAdapter,
  current: T,
  changed: Readonly<Record<string, unknown>>,
): T | null {
  const untouched = Object.entries(adapter.firstRunSettings?.() ?? {}).filter(([key, value]) => (
    !Object.prototype.hasOwnProperty.call(changed, key) && !Object.is(current[key], value)
  ))
  return untouched.length === 0 ? null : { ...current, ...Object.fromEntries(untouched) }
}
