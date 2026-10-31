import { signal } from '@preact/signals'
import { useEffect, useMemo } from 'preact/hooks'
import { speciesCatalogWorkbench } from '../plant-browser'

/**
 * The catalog habit of the species a list shows, for the finder's Form filter. Habits
 * load once per species through the workbench (Desktop plant DB, Web artifact rows) and
 * stay cached for the app's lifetime; a species the catalog gives no habit is cached as
 * null, and a failed load leaves its species out until the next list mount retries.
 */
const habitsBySpecies = new Map<string, string | null>()
const pending = new Set<string>()
const revision = signal(0)

/** Loaded habits by canonical name; a species not yet loaded is absent, one without a habit is null. */
export function useCatalogHabits(canonicalNames: readonly string[]): ReadonlyMap<string, string | null> {
  const key = [...new Set(canonicalNames)].sort().join('\n')
  useEffect(() => {
    if (key) void loadCatalogHabits(key.split('\n'))
  }, [key])
  const currentRevision = revision.value
  return useMemo(() => {
    void currentRevision
    const habits = new Map<string, string | null>()
    if (!key) return habits
    for (const name of key.split('\n')) {
      if (habitsBySpecies.has(name)) habits.set(name, habitsBySpecies.get(name)!)
    }
    return habits
  }, [key, currentRevision])
}

async function loadCatalogHabits(canonicalNames: readonly string[]): Promise<void> {
  const missing = canonicalNames.filter((name) => !habitsBySpecies.has(name) && !pending.has(name))
  if (missing.length === 0) return
  for (const name of missing) pending.add(name)
  try {
    const habits = await speciesCatalogWorkbench.resolveHabits(missing)
    for (const name of missing) habitsBySpecies.set(name, habits[name] ?? null)
    revision.value += 1
  } catch {
    // Left unloaded: the Form filter counts only what it knows until a list retries.
  } finally {
    for (const name of missing) pending.delete(name)
  }
}

/** Forgets every loaded habit on hot reload, so the next list mount asks the workbench again. */
function resetCatalogHabits(): void {
  habitsBySpecies.clear()
  pending.clear()
  revision.value += 1
}

if (import.meta.hot) import.meta.hot.dispose(resetCatalogHabits)
