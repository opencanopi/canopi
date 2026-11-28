import { invokeTyped, mintOperationId } from './transport';
import type { SpeciesListItem } from '../types/species';

export async function toggleFavorite(canonicalName: string): Promise<boolean> {
  return invokeTyped('toggle_favorite', { canonicalName }, mintOperationId('u'));
}

export async function getFavorites(locale: string): Promise<SpeciesListItem[]> {
  return invokeTyped('get_favorites', { locale }, mintOperationId('u'));
}

export async function getRecentlyViewed(
  locale: string,
  limit = 50,
): Promise<SpeciesListItem[]> {
  return invokeTyped('get_recently_viewed', { locale, limit }, mintOperationId('u'));
}
