// app/geojson/workflow.ts
// Owner of the GeoJSON import and export outcomes (no-cancelled-literal, ADR 0025; §18 R14). Invariant: 'cancelled'
// is a GeoJsonWriteOutcome or import/export result status, built only from a dismissed pick or write; ast-grep
// skips this file, so a hand-written cancel guard added here goes uncounted and belongs to the catalogue's
// CancelToken instead.
//
// GeoJSON import/export orchestration shared by Desktop and Web.
//
// Editions supply file I/O and notice presentation; this module owns the
// sequence: read -> decode (reject before any mutation) -> one runtime import
// transaction -> summary notice, and canonical objects -> encode -> write.

import type { CanvasCommandSurface, CanvasQuerySurface } from '../../canvas/runtime/runtime'
import { getCurrentCanvasSession } from '../../canvas/session'
import { editionPorts, hasEditionPorts } from '../../platform/edition-ports'
import type { FileDeliveryPort } from '../../platform/file-delivery'
import { designSessionStore } from '../document-session/store'
import {
  GEOJSON_MAX_FEATURES,
  GeoJsonImportError,
  parseDesignGeoJson,
  serializeDesignGeoJson,
  type GeoJsonImportCounts,
  type GeoJsonImportErrorCode,
} from './codec'
import type { LocaleKey } from '../../generated/locale-keys'

export interface GeoJsonSourceFile {
  readonly name: string
  readonly text: string
}

type NoticeParams = Readonly<Record<string, string | number>>

/** An import or export outcome as locale keys, so each edition words it in the current locale. */
export interface GeoJsonNotice {
  readonly tone: 'info' | 'error'
  readonly title: LocaleKey
  readonly message: LocaleKey
  readonly params?: NoticeParams
  /** A second sentence: the features the import skipped. */
  readonly detail?: { readonly message: LocaleKey; readonly params?: NoticeParams }
}

interface GeoJsonCanvas {
  readonly commands: Pick<CanvasCommandSurface, 'sceneEdits' | 'viewport'>
  readonly queries: Pick<CanvasQuerySurface, 'getSettledDesignObjects'>
}

type GeoJsonImportOutcome =
  | { readonly status: 'imported'; readonly counts: GeoJsonImportCounts; readonly skipped: number }
  | { readonly status: 'empty'; readonly skipped: number }
  | { readonly status: 'rejected'; readonly code: GeoJsonImportErrorCode }
  | { readonly status: 'cancelled' | 'unavailable' | 'busy' | 'read-failed' }

type GeoJsonExportOutcome =
  | { readonly status: 'written'; readonly featureCount: number }
  | { readonly status: 'cancelled' | 'unavailable' | 'busy' | 'refused' | 'write-failed' }

export interface GeoJsonWorkflowDeps {
  readonly pickGeoJsonFile: () => Promise<GeoJsonSourceFile | null>
  readonly fileDelivery?: () => FileDeliveryPort
  readonly notify: (notice: GeoJsonNotice) => void | Promise<void>
  readonly designName: () => string
  readonly canvas?: () => GeoJsonCanvas | null
  /** Identity of the open Design Session; an import applies only to the session it began in. */
  readonly sessionIdentity?: () => object | null
}

export interface GeoJsonWorkflow {
  isAvailable(): boolean
  importGeoJson(): Promise<GeoJsonImportOutcome>
  exportGeoJson(): Promise<GeoJsonExportOutcome>
}

const UNAVAILABLE_GEOJSON_WORKFLOW: GeoJsonWorkflow = {
  isAvailable: () => false,
  importGeoJson: async () => ({ status: 'unavailable' }),
  exportGeoJson: async () => ({ status: 'unavailable' }),
}

const geoJsonWorkflowSlot: { current: GeoJsonWorkflow } = { current: UNAVAILABLE_GEOJSON_WORKFLOW }

/** Installs the active edition's GeoJSON workflow (called by L5 edition roots). */
export function installGeoJsonWorkflow(workflow: GeoJsonWorkflow): () => void {
  const previous = geoJsonWorkflowSlot.current
  geoJsonWorkflowSlot.current = workflow
  return () => {
    if (geoJsonWorkflowSlot.current === workflow) geoJsonWorkflowSlot.current = previous
  }
}

/** Lazy facade over the installed GeoJSON workflow. */
export const activeGeoJsonWorkflow: GeoJsonWorkflow = {
  isAvailable: () => geoJsonWorkflowSlot.current.isAvailable(),
  importGeoJson: () => geoJsonWorkflowSlot.current.importGeoJson(),
  exportGeoJson: () => geoJsonWorkflowSlot.current.exportGeoJson(),
}

function readCurrentGeoJsonCanvas(): GeoJsonCanvas | null {
  const session = getCurrentCanvasSession()
  return session ? { commands: session.commands, queries: session.queries } : null
}

export function createGeoJsonWorkflow({
  pickGeoJsonFile,
  fileDelivery: customFileDelivery,
  notify,
  designName,
  canvas = readCurrentGeoJsonCanvas,
  sessionIdentity = () => designSessionStore.sessionIdentity.peek(),
}: GeoJsonWorkflowDeps): GeoJsonWorkflow {
  const fileDelivery = customFileDelivery ?? (() => editionPorts().fileDelivery)
  const importTitle = 'geojson.importTitle'
  const exportTitle = 'geojson.exportTitle'
  const error = async (title: LocaleKey, message: LocaleKey, params?: NoticeParams) =>
    notify({ tone: 'error', title, message, ...(params ? { params } : {}) })

  async function importGeoJson(): Promise<GeoJsonImportOutcome> {
    if (!canvas()) return { status: 'unavailable' }
    const session = sessionIdentity()
    let file: GeoJsonSourceFile | null
    try {
      file = await pickGeoJsonFile()
    } catch (cause) {
      console.error('GeoJSON import could not read the file:', cause)
      await error(importTitle, 'geojson.readFailed')
      return { status: 'read-failed' }
    }
    if (!file) return { status: 'cancelled' }

    let decoded
    try {
      decoded = parseDesignGeoJson(file.text)
    } catch (cause) {
      if (!(cause instanceof GeoJsonImportError)) throw cause
      await error(importTitle, `geojson.errors.${cause.code}`, {
        feature: cause.featureIndex === null ? '' : cause.featureIndex + 1,
        max: GEOJSON_MAX_FEATURES,
      })
      return { status: 'rejected', code: cause.code }
    }

    const { counts, skipped, objects } = decoded
    if (counts.plants + counts.zones + counts.annotations + counts.measurementGuides === 0) {
      await notify({ tone: 'info', title: importTitle, message: 'geojson.importNothing', ...skippedDetail(skipped) })
      return { status: 'empty', skipped }
    }

    // The Design may have been replaced while the picker was open.
    const target = canvas()
    if (!target || sessionIdentity() !== session) return { status: 'unavailable' }
    const receipt = target.commands.sceneEdits.importDesignObjects(objects)
    if (!receipt.committed) {
      await error(importTitle, 'geojson.busy')
      return { status: 'busy' }
    }
    target.commands.viewport.zoomToFit()
    await notify({
      tone: 'info',
      title: importTitle,
      message: 'geojson.importSummary',
      params: {
        plants: counts.plants,
        zones: counts.zones,
        annotations: counts.annotations,
        guides: counts.measurementGuides,
      },
      ...skippedDetail(skipped),
    })
    return { status: 'imported', counts, skipped }
  }

  async function exportGeoJson(): Promise<GeoJsonExportOutcome> {
    const source = canvas()
    if (!source) return { status: 'unavailable' }
    const objects = source.queries.getSettledDesignObjects()
    if (!objects) {
      await error(exportTitle, 'geojson.busy')
      return { status: 'busy' }
    }
    const text = serializeDesignGeoJson(objects)
    let outcome: 'saved' | 'downloaded' | 'cancelled' | 'refused'
    try {
      const delivery = fileDelivery()
      outcome = await delivery.deliverFile('geojson', designName(), { text })
    } catch (cause) {
      console.error('GeoJSON export could not write the file:', cause)
      await error(exportTitle, 'geojson.writeFailed')
      return { status: 'write-failed' }
    }
    if (outcome === 'cancelled') return { status: 'cancelled' }
    if (outcome === 'refused') {
      await error(exportTitle, 'fileDelivery.refused')
      return { status: 'refused' }
    }
    return {
      status: 'written',
      featureCount: objects.plants.length + objects.zones.length + objects.annotations.length
        + objects.measurementGuides.length,
    }
  }

  return {
    isAvailable: () => canvas() !== null && (hasEditionPorts() || customFileDelivery !== undefined),
    importGeoJson,
    exportGeoJson,
  }
}

function skippedDetail(skipped: number): Pick<GeoJsonNotice, 'detail'> {
  return skipped > 0 ? { detail: { message: 'geojson.importSkipped', params: { count: skipped } } } : {}
}
