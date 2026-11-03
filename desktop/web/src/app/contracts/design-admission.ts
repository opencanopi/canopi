import type { LidarColourRange } from '../../generated/contracts'
import type { CanopiFile } from '../../types/design'

/**
 * Identities and ranges of an admitted current-format Design: the Web mirror
 * of `admit_design_identities_and_ranges` in `canopi-types/src/design.rs`,
 * same rules and same messages: every plant, zone, annotation, measurement
 * guide and group has a unique, non-empty id (Canopi never invents one).
 * Returns the problem, or null.
 */
export function designIdentitiesAndRangesProblem(file: CanopiFile): string | null {
  return uniqueIdsProblem('plants', file.plants.map((plant) => plant.id))
    ?? plantRangesProblem(file)
    ?? uniqueIdsProblem('measurement_guides', (file.measurement_guides ?? []).map((guide) => guide.id))
    ?? uniqueIdsProblem('zones', file.zones.map((zone) => zone.id))
    ?? uniqueIdsProblem('annotations', file.annotations.map((annotation) => annotation.id))
    ?? uniqueIdsProblem('groups', file.groups.map((group) => group.id))
    ?? annotationRangesProblem(file)
    ?? layerRangesProblem(file)
    ?? lidarProblem(file)
}

function plantRangesProblem(file: CanopiFile): string | null {
  for (const [index, plant] of file.plants.entries()) {
    if (plant.scale != null && !(Number.isFinite(plant.scale) && plant.scale > 0)) {
      return `$.plants[${index}].scale: expected a finite number above 0`
    }
    if (plant.rotation != null && !Number.isFinite(plant.rotation)) {
      return `$.plants[${index}].rotation: expected a finite number`
    }
  }
  return null
}

function annotationRangesProblem(file: CanopiFile): string | null {
  for (const [index, annotation] of file.annotations.entries()) {
    if (!(Number.isFinite(annotation.font_size) && annotation.font_size > 0)) {
      return `$.annotations[${index}].font_size: expected a finite number above 0`
    }
    if (annotation.rotation != null && !Number.isFinite(annotation.rotation)) {
      return `$.annotations[${index}].rotation: expected a finite number`
    }
  }
  return null
}

function layerRangesProblem(file: CanopiFile): string | null {
  for (const [index, layer] of file.layers.entries()) {
    if (!isAdmittedOpacity(layer.opacity)) {
      return `$.layers[${index}].opacity: expected a number in [0, 1]`
    }
  }
  return null
}

/** Whether an opacity is admitted: a finite number in [0, 1]. */
export function isAdmittedOpacity(opacity: number): boolean {
  return Number.isFinite(opacity) && opacity >= 0 && opacity <= 1
}

/** Whether a Site data colour range is admitted: a Custom range is finite with min below max. */
export function isAdmittedColourRange(range: LidarColourRange | null): boolean {
  return range?.mode !== 'Custom' || (Number.isFinite(range.min) && Number.isFinite(range.max) && range.min < range.max)
}

function lidarProblem(file: CanopiFile): string | null {
  const lidar = file.lidar
  if (!lidar) return null
  for (const [index, entry] of lidar.entries.entries()) {
    if (!isAdmittedOpacity(entry.opacity)) {
      return `$.lidar.entries[${index}].opacity: expected a number in [0, 1]`
    }
    if (entry.name.trim() === '') {
      return `$.lidar.entries[${index}].name: expected a non-empty name`
    }
    if (!isAdmittedColourRange(entry.range)) {
      return `$.lidar.entries[${index}].range: expected finite min and max with min below max`
    }
  }
  return null
}

function uniqueIdsProblem(key: string, ids: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const [index, id] of ids.entries()) {
    if (id === '') return `$.${key}[${index}].id: expected a non-empty id`
    if (seen.has(id)) return `$.${key}[${index}].id: duplicate id ${JSON.stringify(id)}`
    seen.add(id)
  }
  return null
}
