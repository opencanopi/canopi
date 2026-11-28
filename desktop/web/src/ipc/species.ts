import { invokeTyped, mintOperationId } from './transport';
export { resolveAssetUrl } from '../types/command-transport';
import type {
  SpeciesListItem,
  SpeciesDetail,
  SpeciesSearchRequest,
  FilterOptions,
  PaginatedResult,
  DynamicFilterOptions,
  CommonNameEntry,
  SpeciesImage,
} from '../types/species';

// Plain transport: the plant DB health gate lives in app/plant-browser/live.desktop.ts.

export async function searchSpecies(
  request: SpeciesSearchRequest,
): Promise<PaginatedResult<SpeciesListItem>> {
  return invokeTyped('search_species', { request }, mintOperationId('u'));
}

export async function supersedeSpeciesSearch(): Promise<void> {
  return invokeTyped('supersede_species_search', undefined, mintOperationId('u'));
}

export async function getSpeciesDetail(
  canonicalName: string,
  locale = 'en',
): Promise<SpeciesDetail> {
  return invokeTyped('get_species_detail', { canonicalName, locale }, mintOperationId('u'));
}

export async function getFilterOptions(): Promise<FilterOptions> {
  return invokeTyped('get_filter_options', undefined, mintOperationId('u'));
}

export async function getDynamicFilterOptions(
  fields: string[],
  locale: string,
): Promise<DynamicFilterOptions[]> {
  return invokeTyped('get_dynamic_filter_options', { fields, locale }, mintOperationId('u'));
}

/** Batch lookup: returns canonical_name → common_name map for the given locale. */
export async function getCommonNames(
  canonicalNames: string[],
  locale: string,
): Promise<Record<string, string>> {
  return invokeTyped('get_common_names', { canonicalNames, locale }, mintOperationId('u'));
}

/** Batch lookup: returns canonical_name → catalog habit (`Tree`, `Shrub`, ...) where the catalog has one. */
export async function getSpeciesHabits(canonicalNames: string[]): Promise<Record<string, string>> {
  return invokeTyped('get_species_habits', { canonicalNames }, mintOperationId('u'));
}

/** Batch-fetch full detail records for multiple species. */
export async function getSpeciesBatch(
  canonicalNames: string[],
  locale: string,
): Promise<SpeciesDetail[]> {
  return invokeTyped('get_species_batch', { canonicalNames, locale }, mintOperationId('u'));
}

/** Returns all common names for a species in the given locale. */
export async function getLocaleCommonNames(
  canonicalName: string,
  locale: string,
): Promise<CommonNameEntry[]> {
  return invokeTyped('get_locale_common_names', { canonicalName, locale }, mintOperationId('u'));
}

/** Returns images for a species by canonical name. */
export async function getSpeciesImages(
  canonicalName: string,
): Promise<SpeciesImage[]> {
  return invokeTyped('get_species_images', { canonicalName }, mintOperationId('u'));
}

/** Ensures an image is cached locally and returns the cache file path. */
export async function getCachedImagePath(url: string): Promise<string> {
  return invokeTyped('get_cached_image_path', { url }, mintOperationId('u'));
}
