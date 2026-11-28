/**
 * editions/install-app-lifetime.ts: Owner of shared app-lifetime installers for Desktop and Web edition roots
 * (2.1-Q45, ADR 0022, ADR 0024). Invariant: Desktop and Web boot modules call `installAppLifetime(...)` once rather
 * than importing these installers directly.
 */
import { installCanvasHostRuntime } from '../app/canvas-map-surface/use-canvas-host'
import { installLiveSessionCore, type SessionCore } from '../app/document-session/live-core'
import { registerDesignOpenFailurePresenter, type DesignOpenFailurePresenter } from '../app/document-session/open-failure'
import { installPlaceSearchSession } from '../app/geocoding/place-search-session'
import { installSpeciesCatalogWorkbench, type SpeciesCatalogWorkbench } from '../app/plant-browser'
import { registerCloseGuard, type CloseGuardOptions } from '../app/shell/close-guard'
import { installToolRailLearning } from '../app/tool-rail/learning'
import { installFailureHooks } from '../failures/report'
import { installEditionPorts, type EditionPorts } from '../platform/edition-ports'

export interface AppLifetimeInstallOptions {
  readonly failureStorage: 'disk' | 'device'
  readonly ports: EditionPorts
  readonly speciesCatalog: SpeciesCatalogWorkbench
  readonly createCanvasHostRuntime: Parameters<typeof installCanvasHostRuntime>[0]
  readonly sessionCore: SessionCore
  readonly closeGuard?: CloseGuardOptions
  readonly openFailurePresenter: DesignOpenFailurePresenter
  readonly target?: Window
}

export function installAppLifetime(options: AppLifetimeInstallOptions): () => void {
  const target = options.target ?? window
  const disposers: Array<() => void> = [
    // Window error hooks first so any failure during startup reaches the failure ring (ADR 0025).
    installFailureHooks({ storage: options.failureStorage }, target),
    installEditionPorts(options.ports),
    installSpeciesCatalogWorkbench(options.speciesCatalog),
    installCanvasHostRuntime(options.createCanvasHostRuntime),
    installLiveSessionCore(options.sessionCore),
  ]
  const closeGuard = registerCloseGuard(options.closeGuard)
  registerDesignOpenFailurePresenter(options.openFailurePresenter)
  disposers.push(
    () => closeGuard.dispose(),
    () => registerDesignOpenFailurePresenter(null),
    installPlaceSearchSession(),
    installToolRailLearning(),
  )
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (let i = disposers.length; i--;) disposers[i]!()
  }
}
