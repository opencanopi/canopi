import { invokeCommand } from './transport';
import type { SpeciesListItem } from '../types/species';

export async function toggleFavorite(canonicalName: string): Promise<boolean> {
  return invokeCommand('toggle_favorite', { canonicalName });
}

export async function getFavorites(locale: string): Promise<SpeciesListItem[]> {
  return invokeCommand('get_favorites', { locale });
}

export async function getRecentlyViewed(
  locale: string,
  limit = 50,
): Promise<SpeciesListItem[]> {
  return invokeCommand('get_recently_viewed', { locale, limit });
}
