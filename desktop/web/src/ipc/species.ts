import { invokeCommand } from './transport';
import type {
  SpeciesListItem,
  SpeciesDetail,
  SpeciesSearchRequest,
  FilterOptions,
  PaginatedResult,
  DynamicFilterOptions,
  CommonNameEntry,
  SpeciesImage,
  FlowerColorResolution,
} from '../types/species';

// Plain transport: the plant DB health gate lives in app/plant-browser/live.desktop.ts.

export async function searchSpecies(
  request: SpeciesSearchRequest,
): Promise<PaginatedResult<SpeciesListItem>> {
  return invokeCommand('search_species', { request });
}

export async function supersedeSpeciesSearch(): Promise<void> {
  return invokeCommand('supersede_species_search');
}

export async function getSpeciesDetail(
  canonicalName: string,
  locale = 'en',
): Promise<SpeciesDetail> {
  return invokeCommand('get_species_detail', { canonicalName, locale });
}

export async function getFilterOptions(): Promise<FilterOptions> {
  return invokeCommand('get_filter_options');
}

export async function getDynamicFilterOptions(
  fields: string[],
  locale: string,
): Promise<DynamicFilterOptions[]> {
  return invokeCommand('get_dynamic_filter_options', { fields, locale });
}

/** Batch lookup: returns canonical_name → common_name map for the given locale. */
export async function getCommonNames(
  canonicalNames: string[],
  locale: string,
): Promise<Record<string, string>> {
  return invokeCommand('get_common_names', { canonicalNames, locale });
}

/** Batch lookup: returns canonical_name → catalog habit (`Tree`, `Shrub`, ...) where the catalog has one. */
export async function getSpeciesHabits(canonicalNames: string[]): Promise<Record<string, string>> {
  return invokeCommand('get_species_habits', { canonicalNames });
}

/** Batch-fetch full detail records for multiple species. */
export async function getSpeciesBatch(
  canonicalNames: string[],
  locale: string,
): Promise<SpeciesDetail[]> {
  return invokeCommand('get_species_batch', { canonicalNames, locale });
}

export async function getFlowerColorBatch(
  canonicalNames: string[],
): Promise<FlowerColorResolution[]> {
  return invokeCommand('get_flower_color_batch', { canonicalNames });
}

/** Returns all common names for a species in the given locale. */
export async function getLocaleCommonNames(
  canonicalName: string,
  locale: string,
): Promise<CommonNameEntry[]> {
  return invokeCommand('get_locale_common_names', { canonicalName, locale });
}

/** Returns images for a species by canonical name. */
export async function getSpeciesImages(
  canonicalName: string,
): Promise<SpeciesImage[]> {
  return invokeCommand('get_species_images', { canonicalName });
}

/** Ensures an image is cached locally and returns the cache file path. */
export async function getCachedImagePath(url: string): Promise<string> {
  return invokeCommand('get_cached_image_path', { url });
}
