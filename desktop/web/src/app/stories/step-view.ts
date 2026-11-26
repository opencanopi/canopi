import { currentCanvasQuerySurface } from '../../canvas/session'
import { t } from '../../i18n'
import type { SavedView } from '../../types/design'
import { savedViewPresentedLabels } from '../saved-views/snapshot'

/** One "This step shows" tag: what the step's view shows, in words. */
interface StepViewTag {
  readonly key: string
  readonly label: string
  readonly kind: 'view' | 'background' | 'terrain' | 'species' | 'objects' | 'labels'
}

/**
 * What a step's view shows, in order: the view, its background, terrain, the
 * highlighted species (by their common name in the interface language when
 * the map knows one) and objects, and the plant labels.
 */
export function stepViewTags(view: SavedView): StepViewTag[] {
  const names = currentCanvasQuerySurface.peek()?.getLocalizedCommonNames()
  const tags: StepViewTag[] = [{ key: 'view', kind: 'view', label: t('stories.showsView', { name: view.name }) }]
  const background = view.visible_layers.background.kind
  tags.push({
    key: 'background',
    kind: 'background',
    label: t(background === 'satellite' ? 'stories.backgroundSatellite' : background === 'basemap' ? 'stories.backgroundMap' : 'stories.backgroundNone'),
  })
  if (view.visible_layers.terrain.contours) tags.push({ key: 'contours', kind: 'terrain', label: t('stories.contours') })
  if (view.visible_layers.terrain.hillshade) tags.push({ key: 'hillshade', kind: 'terrain', label: t('stories.hillshade') })
  for (const species of view.highlighted.species) {
    tags.push({ key: `species:${species}`, kind: 'species', label: t('stories.highlighted', { name: names?.get(species) ?? species }) })
  }
  if (view.highlighted.objects.length > 0) {
    tags.push({ key: 'objects', kind: 'objects', label: t('stories.objects', { count: view.highlighted.objects.length }) })
  }
  const labels = savedViewPresentedLabels(view)
  tags.push({
    key: 'labels',
    kind: 'labels',
    label: t(labels === 'none' ? 'stories.labelsNone' : labels === 'codes' ? 'stories.labelsCodes' : 'stories.labelsNames'),
  })
  return tags
}

/** The species a view highlights, by name in the interface language, with how many plants the Design has of each. */
export function highlightedSpeciesSummary(view: SavedView): { readonly canonicalName: string; readonly name: string; readonly count: number }[] {
  const queries = currentCanvasQuerySurface.peek()
  const names = queries?.getLocalizedCommonNames()
  const plants = queries?.getPlacedPlants() ?? []
  return view.highlighted.species.map((canonicalName) => ({
    canonicalName,
    name: names?.get(canonicalName) ?? canonicalName,
    count: plants.filter((plant) => plant.canonical_name === canonicalName).length,
  }))
}
