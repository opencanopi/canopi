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
    admitWrite(file) {
      if (file.version !== CURRENT_CANOPI_FILE_VERSION) {
        return `unsupported_version:${file.version}`
      }
      const identityAndRange = designIdentitiesAndRangesProblem(file)
      if (identityAndRange) return identityAndRange
      const views = (file.views ?? []) as Parameters<typeof viewsAndStoriesProblem>[0]
      const stories = (file.stories ?? []) as Parameters<typeof viewsAndStoriesProblem>[1]
      return viewsAndStoriesProblem(views, stories) ?? mapViewProblem(file.map_view)
    },
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

function designIdentitiesAndRangesProblem(file: WriteFile): string | null {
  return (
    uniqueIdsProblem(file)
    ?? plantsAndZonesRangesProblem(file)
    ?? annotationsAndLayersRangesProblem(file)
    ?? siteDataRangesProblem(file)
  )
}
