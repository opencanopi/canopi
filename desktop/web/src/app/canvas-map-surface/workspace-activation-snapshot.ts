import { designSessionStore, type DesignSessionStore } from '../document-session/store'
import { locale } from '../settings/state'
import type { MapLayersState } from '../settings/state'
import { backgroundPresentationOf } from '../map-layers/background-presentation'
import { presentedMapLayers } from '../story-presentation/overrides'
import type { MapBackgroundPresentation } from '../../maplibre/map-background'
import type { WorkspaceActivationSnapshot } from './workspace-activation'

export interface WorkspaceActivationSnapshotReaderOptions {
  readonly store?: Pick<DesignSessionStore, 'hasCurrentDesign' | 'sessionIdentity'>
  readonly readMapLayers?: () => MapLayersState
}

/** The background band as the map layer store (or a presented story step) and locale describe it. */
export function readWorkspaceBackgroundPresentation(
  options: WorkspaceActivationSnapshotReaderOptions = {},
): MapBackgroundPresentation {
  return backgroundPresentationOf((options.readMapLayers ?? presentedMapLayers)(), locale.value)
}

export function readWorkspaceActivationSnapshot(
  options: WorkspaceActivationSnapshotReaderOptions & {
    /** Initial map centre: the runtime's session plane origin. */
    readonly readInitialCenter: () => { readonly lat: number; readonly lon: number }
  },
): WorkspaceActivationSnapshot | null {
  const store = options.store ?? designSessionStore
  if (!store.hasCurrentDesign()) return null
  const center = options.readInitialCenter()
  return Object.freeze({
    sessionIdentity: store.sessionIdentity.peek(),
    map: Object.freeze({
      initialCenter: Object.freeze({ lat: center.lat, lon: center.lon }),
      background: readWorkspaceBackgroundPresentation(options),
    }),
  })
}
