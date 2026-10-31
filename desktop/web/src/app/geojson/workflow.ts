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
import { designSessionStore } from '../document-session/store'
import { t } from '../../i18n'
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

export type GeoJsonWriteOutcome = 'written' | 'cancelled'

/** Edition file I/O: a native dialog plus IPC on Desktop, picker and download on Web. */
export interface GeoJsonFileAdapter {
  pickGeoJsonFile(): Promise<GeoJsonSourceFile | null>
  writeGeoJsonFile(text: string, fileName: string): Promise<GeoJsonWriteOutcome>
}

export interface GeoJsonNotice {
  readonly tone: 'info' | 'error'
  readonly title: string
  readonly message: string
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
  | { readonly status: 'cancelled' | 'unavailable' | 'busy' | 'write-failed' }

export interface GeoJsonWorkflowDeps {
  readonly files: GeoJsonFileAdapter
  readonly notify: (notice: GeoJsonNotice) => void | Promise<void>
  readonly designName: () => string
  readonly canvas?: () => GeoJsonCanvas | null
  /** Identity of the open Design Session; an import applies only to the session it began in. */
  readonly sessionIdentity?: () => object | null
  readonly translate?: (key: LocaleKey, options?: Record<string, unknown>) => string
}

export interface GeoJsonWorkflow {
  isAvailable(): boolean
  importGeoJson(): Promise<GeoJsonImportOutcome>
  exportGeoJson(): Promise<GeoJsonExportOutcome>
}

function readCurrentGeoJsonCanvas(): GeoJsonCanvas | null {
  const session = getCurrentCanvasSession()
  return session ? { commands: session.commands, queries: session.queries } : null
}

export function createGeoJsonWorkflow({
  files,
  notify,
  designName,
  canvas = readCurrentGeoJsonCanvas,
  sessionIdentity = () => designSessionStore.sessionIdentity.peek(),
  translate = t,
}: GeoJsonWorkflowDeps): GeoJsonWorkflow {
  const importTitle = () => translate('geojson.importTitle')
  const exportTitle = () => translate('geojson.exportTitle')
  const error = async (title: string, message: string) => notify({ tone: 'error', title, message })

  async function importGeoJson(): Promise<GeoJsonImportOutcome> {
    if (!canvas()) return { status: 'unavailable' }
    const session = sessionIdentity()
    let file: GeoJsonSourceFile | null
    try {
      file = await files.pickGeoJsonFile()
    } catch (cause) {
      console.error('GeoJSON import could not read the file:', cause)
      await error(importTitle(), translate('geojson.readFailed'))
      return { status: 'read-failed' }
    }
    if (!file) return { status: 'cancelled' }

    let decoded
    try {
      decoded = parseDesignGeoJson(file.text)
    } catch (cause) {
      if (!(cause instanceof GeoJsonImportError)) throw cause
      await error(importTitle(), rejectionMessage(cause, translate))
      return { status: 'rejected', code: cause.code }
    }

    const { counts, skipped, objects } = decoded
    if (counts.plants + counts.zones + counts.annotations + counts.measurementGuides === 0) {
      await notify({ tone: 'info', title: importTitle(), message: withSkipped(translate('geojson.importNothing'), skipped, translate) })
      return { status: 'empty', skipped }
    }

    // The Design may have been replaced while the picker was open.
    const target = canvas()
    if (!target || sessionIdentity() !== session) return { status: 'unavailable' }
    const receipt = target.commands.sceneEdits.importDesignObjects(objects)
    if (!receipt.committed) {
      await error(importTitle(), translate('geojson.busy'))
      return { status: 'busy' }
    }
    target.commands.viewport.zoomToFit()
    await notify({
      tone: 'info',
      title: importTitle(),
      message: withSkipped(translate('geojson.importSummary', {
        plants: counts.plants,
        zones: counts.zones,
        annotations: counts.annotations,
        guides: counts.measurementGuides,
      }), skipped, translate),
    })
    return { status: 'imported', counts, skipped }
  }

  async function exportGeoJson(): Promise<GeoJsonExportOutcome> {
    const source = canvas()
    if (!source) return { status: 'unavailable' }
    const objects = source.queries.getSettledDesignObjects()
    if (!objects) {
      await error(exportTitle(), translate('geojson.busy'))
      return { status: 'busy' }
    }
    const text = serializeDesignGeoJson(objects)
    let outcome: GeoJsonWriteOutcome
    try {
      outcome = await files.writeGeoJsonFile(text, `${safeFileStem(designName())}.geojson`)
    } catch (cause) {
      console.error('GeoJSON export could not write the file:', cause)
      await error(exportTitle(), translate('geojson.writeFailed'))
      return { status: 'write-failed' }
    }
    if (outcome === 'cancelled') return { status: 'cancelled' }
    return {
      status: 'written',
      featureCount: objects.plants.length + objects.zones.length + objects.annotations.length
        + objects.measurementGuides.length,
    }
  }

  return {
    isAvailable: () => canvas() !== null,
    importGeoJson,
    exportGeoJson,
  }
}

function rejectionMessage(
  error: GeoJsonImportError,
  translate: NonNullable<GeoJsonWorkflowDeps['translate']>,
): string {
  return translate(`geojson.errors.${error.code}`, {
    feature: error.featureIndex === null ? '' : error.featureIndex + 1,
    max: GEOJSON_MAX_FEATURES,
  })
}

function withSkipped(
  message: string,
  skipped: number,
  translate: NonNullable<GeoJsonWorkflowDeps['translate']>,
): string {
  return skipped > 0 ? `${message} ${translate('geojson.importSkipped', { count: skipped })}` : message
}

function safeFileStem(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'Canopi'
}
