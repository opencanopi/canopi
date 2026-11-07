import type { PlantCatalogCause } from '../generated/contracts';

const PLANT_DB_UNAVAILABLE_PREFIX = 'Plant database unavailable';

export function plantDbUnavailableMessage(cause: PlantCatalogCause): string {
  if (cause === 'open_failed') {
    return 'Plant database unavailable: bundled plant database is corrupt';
  }
  return 'Plant database unavailable: bundled plant database is missing';
}

export function isPlantDbUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(PLANT_DB_UNAVAILABLE_PREFIX);
}
