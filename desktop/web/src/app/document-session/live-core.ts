// app/document-session/live-core.ts
// Live Session Core installation and v10 Format Core codec bridge for Desktop, Web and Gallery (2b-3, 2b-5; contracts §4, §10, ADR 0024, ADR 0026).

import { signal, type ReadonlySignal } from '@preact/signals'
import type { GeoPointV10, LidarColourRangeV10 } from '../../generated/contracts'
import {
  CURRENT_CANOPI_FILE_VERSION,
  WEB_MERCATOR_MAX_LATITUDE_DEG,
} from '../../generated/canopi-design-format'
import type { DesignCore } from '../../platform/design-core'
import { ingestionErrorFromFormatRefusal } from '../contracts/canopi-design-errors'
import {
  flattenDocumentForJson,
  normalizeLoadedDocument,
} from '../contracts/document'
import { mapViewProblem, viewsAndStoriesProblem } from '../contracts/views-admission'
import {
  createSessionCore,
  type DecodedDesignPayload,
  type SessionCore,
  type SessionCoreCodec,
} from './core'
import { installSessionCoreEditAuthority } from './edit-authority'
import type { DesignSaveStatus } from './save-status'

export {
  createSessionCore,
  normalizeLoadedDocument,
  type DecodedDesignPayload,
  type DesignSaveStatus,
  type SessionCore,
  type SessionCoreCodec,
}

const activeSessionCoreSignal = signal<SessionCore | null>(null)

export const activeSessionCore: ReadonlySignal<SessionCore | null> = activeSessionCoreSignal

export function getLiveSessionCore(): SessionCore | null {
  return activeSessionCoreSignal.peek()
}

export function requireLiveSessionCore(): SessionCore {
  const core = activeSessionCoreSignal.peek()
  if (!core) throw new Error('No live Session Core installed')
  return core
}

/**
 * Installs the active edition's live Session Core and binds the Design Edit authority to it.
 * Returns a disposer that tears down the authority and core.
 */
export function installLiveSessionCore(core: SessionCore): () => void {
  const previous = activeSessionCoreSignal.peek()
  if (previous && previous !== core) previous.dispose()
  activeSessionCoreSignal.value = core
  const disposeAuthority = installSessionCoreEditAuthority(core)

  return () => {
    disposeAuthority()
    if (activeSessionCoreSignal.peek() === core) activeSessionCoreSignal.value = null
    core.dispose()
  }
}

async function decodeWithDesignCore(
  designCore: DesignCore,
  bytes: Uint8Array,
): Promise<DecodedDesignPayload> {
  const answer = await designCore.decode(bytes)
  if ('ok' in answer) {
    return {
      file: normalizeLoadedDocument(answer.ok.design),
      migratedFrom: answer.ok.migrated_from ?? null,
    }
  }
  throw ingestionErrorFromFormatRefusal(answer.err)
}

/** Synchronous v10 write-admission check shared by SessionCore and synchronous unload flushes. */
export function admitCanopiWrite(file: WriteFile): string | null {
  if (file.version !== CURRENT_CANOPI_FILE_VERSION) {
    return `unsupported_version:${file.version}`
  }
  const extra = (file as { readonly extra?: Record<string, unknown> }).extra
  if (extra && Object.prototype.hasOwnProperty.call(extra, 'extra')) {
    return "$.extra: reserved root field 'extra' is not allowed"
  }
  const identityAndRange = designIdentitiesAndRangesProblem(file)
  if (identityAndRange) return identityAndRange
  const views = (file.views ?? []) as Parameters<typeof viewsAndStoriesProblem>[0]
  const stories = (file.stories ?? []) as Parameters<typeof viewsAndStoriesProblem>[1]
  return viewsAndStoriesProblem(views, stories) ?? mapViewProblem(file.map_view)
}

/** Production `.canopi` codec shared by Desktop, Web and Gallery Session Cores (2b-3, 2b-5, ADR 0026, contracts §4, §10). */
export function createJsonSessionCodec(options: {
  readonly designCore: DesignCore
  readonly decode?: (bytes: Uint8Array) => Promise<DecodedDesignPayload>
}): SessionCoreCodec {
  return {
    async decode(bytes) {
      if (options.decode) return options.decode(bytes)
      return decodeWithDesignCore(options.designCore, bytes)
    },
    admitWrite: admitCanopiWrite,
    async encode(file) {
      const encoded = await options.designCore.encode(flattenDocumentForJson(file))
      if ('err' in encoded) throw ingestionErrorFromFormatRefusal(encoded.err)
      const bytes = encoded.ok
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
      const version = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
      return { bytes, version }
    },
  }
}

type WriteFile = Parameters<NonNullable<SessionCoreCodec['admitWrite']>>[0]

function isAdmittedOpacityValue(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function isAdmittedRangeValue(range: LidarColourRangeV10 | null | undefined): boolean {
  if (!range || range.mode !== 'Custom') return true
  return Number.isFinite(range.min) && Number.isFinite(range.max) && range.min < range.max
}

function isAdmittedGeoPoint(point: Readonly<GeoPointV10> | undefined): boolean {
  return (
    point !== undefined
    && Number.isFinite(point.lon)
    && Number.isFinite(point.lat)
    && point.lon >= -180
    && point.lon <= 180
    && point.lat >= -WEB_MERCATOR_MAX_LATITUDE_DEG
    && point.lat <= WEB_MERCATOR_MAX_LATITUDE_DEG
  )
}

function uniqueIdsProblem(file: WriteFile): string | null {
  const lists = [
    ['plants', file.plants],
    ['zones', file.zones],
    ['annotations', file.annotations ?? []],
    ['groups', file.groups ?? []],
    ['measurement_guides', file.measurement_guides ?? []],
  ] as const
  for (const [field, items] of lists) {
    const seen = new Set<string>()
    for (let i = 0; i < items.length; i += 1) {
      const id = items[i]?.id
      if (!id) return `$.${field}[${i}].id: expected a non-empty id`
      if (seen.has(id)) return `$.${field}[${i}].id: expected a unique id`
      seen.add(id)
    }
  }
  return null
}

function plantsAndZonesRangesProblem(file: WriteFile): string | null {
  for (let i = 0; i < file.plants.length; i += 1) {
    const plant = file.plants[i]
    if (!plant) continue
    if (!isAdmittedGeoPoint(plant.position)) return `$.plants[${i}].position: expected a valid WGS84 point`
    if (plant.canopy_spread_m != null && (!Number.isFinite(plant.canopy_spread_m) || plant.canopy_spread_m <= 0)) {
      return `$.plants[${i}].canopy_spread_m: expected a positive finite number`
    }
    if (plant.rotation != null && !Number.isFinite(plant.rotation)) {
      return `$.plants[${i}].rotation: expected a finite number`
    }
  }
  for (let i = 0; i < file.zones.length; i += 1) {
    const zone = file.zones[i]
    if (!zone) continue
    if (!Number.isFinite(zone.rotation)) return `$.zones[${i}].rotation: expected a finite number`
    if (zone.opacity != null && !isAdmittedOpacityValue(zone.opacity)) {
      return `$.zones[${i}].opacity: expected a finite number in [0, 1]`
    }
    for (let j = 0; j < zone.points.length; j += 1) {
      if (!isAdmittedGeoPoint(zone.points[j])) {
        return `$.zones[${i}].points[${j}]: expected a valid WGS84 point`
      }
    }
  }
  return null
}

function annotationsAndLayersRangesProblem(file: WriteFile): string | null {
  for (let i = 0; i < file.layers.length; i += 1) {
    const layer = file.layers[i]
    if (!layer || !isAdmittedOpacityValue(layer.opacity)) {
      return `$.layers[${i}].opacity: expected a finite number in [0, 1]`
    }
  }
  const annotations = file.annotations ?? []
  for (let i = 0; i < annotations.length; i += 1) {
    const annotation = annotations[i]
    if (!annotation) continue
    if (!isAdmittedGeoPoint(annotation.position)) return `$.annotations[${i}].position: expected a valid WGS84 point`
    if (!Number.isFinite(annotation.font_size) || annotation.font_size <= 0) {
      return `$.annotations[${i}].font_size: expected a positive finite number`
    }
    if (annotation.rotation != null && !Number.isFinite(annotation.rotation)) {
      return `$.annotations[${i}].rotation: expected a finite number`
    }
  }
  return null
}

function siteDataRangesProblem(file: WriteFile): string | null {
  const siteEntries = file.site_data?.entries ?? []
  const seenSiteIds = new Set<string>()
  for (let i = 0; i < siteEntries.length; i += 1) {
    const entry = siteEntries[i]
    if (!entry) continue
    if (!entry.id) return `$.site_data.entries[${i}].id: expected a non-empty id`
    if (seenSiteIds.has(entry.id)) return `$.site_data.entries[${i}].id: expected a unique id`
    seenSiteIds.add(entry.id)
    if (!entry.name.trim()) return `$.site_data.entries[${i}].name: expected a non-empty name`
    if (!isAdmittedOpacityValue(entry.opacity)) {
      return `$.site_data.entries[${i}].opacity: expected a finite number in [0, 1]`
    }
    if (!isAdmittedRangeValue(entry.range)) {
      return `$.site_data.entries[${i}].range: expected a finite colour range with min < max`
    }
  }
  return null
}

function measurementGuidesAndBudgetProblem(file: WriteFile): string | null {
  const guides = file.measurement_guides ?? []
  for (let i = 0; i < guides.length; i += 1) {
    const guide = guides[i]
    if (!guide) continue
    if (!isAdmittedGeoPoint(guide.start)) return `$.measurement_guides[${i}].start: expected a valid WGS84 point`
    if (!isAdmittedGeoPoint(guide.end)) return `$.measurement_guides[${i}].end: expected a valid WGS84 point`
  }
  const budget = file.budget ?? []
  for (let i = 0; i < budget.length; i += 1) {
    const line = budget[i]
    if (!line) continue
    if (!Number.isFinite(line.unit_cost)) return `$.budget[${i}].unit_cost: expected a finite number`
    if (line.target?.kind === 'species') {
      const canonical = (line.target as { readonly canonical_name?: unknown }).canonical_name
      if (typeof canonical !== 'string' || canonical.trim().length === 0) {
        return `$.budget[${i}].target.canonical_name: expected a non-empty canonical_name for species budget line`
      }
    }
  }
  return null
}

function isPositiveFiniteSize(size: { readonly width_m: number; readonly height_m: number } | undefined): boolean {
  return size !== undefined
    && Number.isFinite(size.width_m) && size.width_m > 0
    && Number.isFinite(size.height_m) && size.height_m > 0
}

function printSetupProblem(file: WriteFile): string | null {
  const setup = file.print_setup
  if (!setup) return null
  const splits = setup.splits ?? []
  const splitIds = new Set<string>()
  for (let i = 0; i < splits.length; i += 1) {
    const split = splits[i]
    if (!split) continue
    if (!split.id) return `$.print_setup.splits[${i}].id: expected a non-empty id`
    if (splitIds.has(split.id)) return `$.print_setup.splits[${i}].id: expected a unique id`
    splitIds.add(split.id)
    if (!isAdmittedGeoPoint(split.pivot)) return `$.print_setup.splits[${i}].pivot: expected a valid WGS84 point`
    if (!Number.isFinite(split.angle_deg)) return `$.print_setup.splits[${i}].angle_deg: expected a finite number`
  }
  const pages = setup.pages ?? []
  const pageIds = new Set<string>()
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i]
    if (!page) continue
    if (!page.id) return `$.print_setup.pages[${i}].id: expected a non-empty id`
    if (pageIds.has(page.id)) return `$.print_setup.pages[${i}].id: expected a unique id`
    pageIds.add(page.id)
    const areaProblem = printAreaProblem(page.area, splitIds, `$.print_setup.pages[${i}].area`)
    if (areaProblem) return areaProblem
    const scaleProblem = printScaleProblem(page.scale, `$.print_setup.pages[${i}].scale`)
    if (scaleProblem) return scaleProblem
  }
  return null
}

type PrintPageWire = NonNullable<NonNullable<WriteFile['print_setup']>['pages']>[number]

function printAreaProblem(
  area: PrintPageWire['area'],
  splitIds: ReadonlySet<string>,
  path: string,
): string | null {
  if (area.kind === 'box') {
    if (!isAdmittedGeoPoint(area.centre)) return `${path}.centre: expected a valid WGS84 point`
    if (!isPositiveFiniteSize(area.size)) return `${path}.size: expected positive finite dimensions`
    if (!Number.isFinite(area.angle_deg)) return `${path}.angle_deg: expected a finite number`
    return null
  }
  if (area.kind === 'whole_design') {
    if (!Number.isFinite(area.angle_deg)) return `${path}.angle_deg: expected a finite number`
    if (area.fallback && !isAdmittedGeoPoint(area.fallback.centre)) {
      return `${path}.fallback.centre: expected a valid WGS84 point`
    }
    return null
  }
  if (!splitIds.has(area.split)) return `${path}.split: expected an existing print_setup split id`
  if (!Number.isFinite(area.along_page.right_m) || !Number.isFinite(area.along_page.down_m)) {
    return `${path}.along_page: expected finite numbers`
  }
  if (!isPositiveFiniteSize(area.size)) return `${path}.size: expected positive finite dimensions`
  return null
}

function printScaleProblem(
  scale: PrintPageWire['scale'],
  path: string,
): string | null {
  if (scale.kind === 'ratio') {
    if (!Number.isInteger(scale.denominator) || scale.denominator <= 0) {
      return `${path}.denominator: expected a positive integer denominator`
    }
    return null
  }
  if (scale.kind === 'customary') {
    if (!Number.isFinite(scale.inches) || scale.inches <= 0 || !Number.isFinite(scale.feet) || scale.feet <= 0) {
      return `${path}: expected positive finite customary scale values`
    }
  }
  return null
}

function designIdentitiesAndRangesProblem(file: WriteFile): string | null {
  return (
    uniqueIdsProblem(file)
    ?? plantsAndZonesRangesProblem(file)
    ?? annotationsAndLayersRangesProblem(file)
    ?? siteDataRangesProblem(file)
    ?? measurementGuidesAndBudgetProblem(file)
    ?? printSetupProblem(file)
  )
}
