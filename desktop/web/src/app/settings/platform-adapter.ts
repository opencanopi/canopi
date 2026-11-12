import type { Settings } from '../../types/settings'

export interface SettingsPlatformAdapter {
  load(): Settings | Promise<Settings>
  save(settings: Settings): Promise<void>
  /**
   * What a new profile on this host starts with over the host-independent defaults (2.1-Q309: Trackpad on a Mac), for a
   * session whose record cannot be read; the projection holds it in memory and writes nothing (2.1-M473). An adapter
   * with no host-specific first run omits it.
   */
  firstRunSettings?(): Partial<Settings>
}

/**
 * `current` with the adapter's first-run settings, except those the session already changed (`changed`), so a choice
 * made while the record was being read stands; null when nothing would change.
 */
export function withFirstRunSettings(
  adapter: SettingsPlatformAdapter,
  current: Settings,
  changed: Partial<Settings>,
): Settings | null {
  const untouched = Object.entries(adapter.firstRunSettings?.() ?? {}).filter(([key, value]) => (
    !Object.prototype.hasOwnProperty.call(changed, key) && !Object.is(current[key as keyof Settings], value)
  ))
  return untouched.length === 0 ? null : { ...current, ...Object.fromEntries(untouched) }
}
