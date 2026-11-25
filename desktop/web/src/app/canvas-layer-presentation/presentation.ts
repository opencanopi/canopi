import { NEW_DESIGN_LAYER_DEFAULTS } from '../../generated/new-design-defaults'
import { openLayerRow } from './open-row'
import { googleMapsApiKey, mapLayers } from '../settings/state'
import {
  setMapLayerOpacity,
  setMapLayerVisible,
  setContourIntervalMeters,
  type MapLayerId,
} from '../map-layers/actions'
import type { BasemapStyle } from '../../generated/contracts'
import { SETTINGS_BASEMAP_STYLES } from '../../generated/settings'
import { getCurrentCanvasLayerCommandSurface, currentCanvasQuerySurface } from '../../canvas/session'
import { t } from '../../i18n'

const SCENE_LAYER_ROW_IDS = ['annotations', 'plants', 'measurement-guides', 'zones'] as const
const MAP_LAYER_ROW_IDS: ReadonlySet<string> = new Set<MapLayerId>(['basemap', 'satellite', 'contours', 'hillshade'])

type CanvasLayerPresentationAuthority = 'scene' | 'map-layers'

/**
 * The Layers section a row belongs to: the Design's own objects, the Map's
 * online-elevation rows (contour lines and hillshading), and the background
 * the map draws under everything.
 */
type CanvasLayerPresentationGroup = 'design' | 'map' | 'background'

export type CanvasLayerPresentationDetail =
  | { readonly type: 'scene' }
  | {
      readonly type: 'basemap'
      readonly style: BasemapStyle
      readonly styles: readonly BasemapStyle[]
      readonly softenBackground: boolean
    }
  | {
      readonly type: 'satellite'
      readonly hasGoogleKey: boolean
      readonly softenBackground: boolean
    }
  | {
      readonly type: 'contours'
      readonly contourIntervalMeters: number
    }
  | { readonly type: 'hillshade' }

export interface CanvasLayerPresentationRow {
  readonly id: string
  readonly label: string
  readonly authority: CanvasLayerPresentationAuthority
  readonly group: CanvasLayerPresentationGroup
  /** The row is open: its settings show under it (one row at a time; `open-row.ts`). */
  readonly open: boolean
  readonly visible: boolean
  readonly opacity: number
  readonly locked: boolean
  readonly count?: number
  readonly canLock: boolean
  readonly detail: CanvasLayerPresentationDetail
}

export interface CanvasLayerPresentation {
  readonly rows: readonly CanvasLayerPresentationRow[]
}

/**
 * The Layers rows. Design rows read only the scene snapshot, the one authority
 * for a layer's eye, lock and opacity; before a scene exists they show the New
 * Design defaults.
 */
export function readCanvasLayerPresentation(): CanvasLayerPresentation {
  const runtime = currentCanvasQuerySurface.value
  void runtime?.revision.scene.value
  const scene = runtime?.getSceneSnapshot()
  const open = openLayerRow.value
  const layers = mapLayers.value

  const mapRow = (
    id: MapLayerId,
    label: string,
    state: { readonly visible: boolean; readonly opacity: number },
    detail: CanvasLayerPresentationDetail,
  ): CanvasLayerPresentationRow => ({
    id,
    label,
    authority: 'map-layers',
    group: id === 'basemap' || id === 'satellite' ? 'background' : 'map',
    open: open === id,
    visible: state.visible,
    opacity: state.opacity,
    locked: false,
    canLock: false,
    detail,
  })

  const rows: CanvasLayerPresentationRow[] = [
    ...SCENE_LAYER_ROW_IDS.map((id) => {
      const sceneLayer = scene?.layers.find((layer) => layer.name === id)
        ?? NEW_DESIGN_LAYER_DEFAULTS.find((layer) => layer.name === id)
      return {
        id,
        label: t(`canvas.layers.${id}`),
        authority: 'scene' as const,
        group: 'design' as const,
        count: (id === 'measurement-guides' ? scene?.measurementGuides : scene?.[id])?.length ?? 0,
        open: open === id,
        visible: sceneLayer?.visible ?? true,
        opacity: sceneLayer?.opacity ?? 1,
        locked: sceneLayer?.locked ?? false,
        canLock: true,
        detail: { type: 'scene' as const },
      }
    }),
    mapRow('basemap', t('canvas.layers.backgroundMap'), layers.basemap, {
      type: 'basemap',
      style: layers.basemap.style,
      styles: SETTINGS_BASEMAP_STYLES,
      softenBackground: layers.softenBackground,
    }),
    mapRow('satellite', t('canvas.layers.satellite'), layers.satellite, {
      type: 'satellite',
      hasGoogleKey: Boolean(googleMapsApiKey.value?.trim()),
      softenBackground: layers.softenBackground,
    }),
    mapRow('contours', t('canvas.terrain.contours'), layers.contours, {
      type: 'contours',
      contourIntervalMeters: layers.contours.intervalMeters,
    }),
    mapRow('hillshade', t('canvas.terrain.hillshade'), layers.hillshade, { type: 'hillshade' }),
  ]

  return { rows }
}

export function setCanvasLayerPresentationVisibility(id: string, visible: boolean): boolean {
  if (MAP_LAYER_ROW_IDS.has(id)) {
    setMapLayerVisible(id as MapLayerId, visible)
    return true
  }
  return getCurrentCanvasLayerCommandSurface()?.setSceneLayerVisibility(id, visible) ?? false
}

export function setCanvasLayerPresentationOpacity(id: string, opacity: number): boolean {
  if (!Number.isFinite(opacity)) return false
  const next = Math.min(1, Math.max(0, opacity))
  if (MAP_LAYER_ROW_IDS.has(id)) {
    setMapLayerOpacity(id as MapLayerId, next)
    return true
  }
  return getCurrentCanvasLayerCommandSurface()?.setSceneLayerOpacity(id, next) ?? false
}

export function setCanvasLayerPresentationLocked(id: string, locked: boolean): boolean {
  if (MAP_LAYER_ROW_IDS.has(id)) return false
  return getCurrentCanvasLayerCommandSurface()?.setSceneLayerLocked(id, locked) ?? false
}

export function setCanvasLayerPresentationContourIntervalMeters(interval: number): boolean {
  if (!Number.isFinite(interval) || interval < 0) return false
  setContourIntervalMeters(interval)
  return true
}
