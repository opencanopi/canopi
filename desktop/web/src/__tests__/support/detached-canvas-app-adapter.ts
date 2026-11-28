import type { CanopiFile } from '../../types/design'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type {
  CanvasRuntimeAppAdapter,
  CanvasRuntimeDocumentCompositionInput,
} from '../../canvas/runtime/app-adapter'
import {
  SceneCanvasRuntime,
  type SceneCanvasRuntimeOptions,
} from '../../canvas/runtime/scene-runtime'

/**
 * Detached `CanvasRuntimeAppAdapter` for tests that run `SceneCanvasRuntime` without an edition app host.
 */
export function createDetachedCanvasRuntimeAppAdapter(): CanvasRuntimeAppAdapter {
  let gridVisible = false
  let snapToGrid = false
  let plantSpacingIntervalM: number = DEFAULT_SETTINGS.plant_spacing_interval_m

  return {
    document: {
      composeDocumentForSave: composeDetachedCanvasDocument,
    },
    translate: detachedCanvasRuntimeTranslator,
    isReadOnly: () => false,
    settings: {
      readLocale: () => 'en',
      readChromeOverlay: () => ({ gridVisible }),
      readSnapToGridEnabled: () => snapToGrid,
      readScrollWheel: () => 'zoom',
      readPlantSpacingIntervalMeters: () => plantSpacingIntervalM,
      commitPlantSpacingIntervalMeters: (meters) => {
        plantSpacingIntervalM = meters
      },
      toggleGridVisible: () => {
        gridVisible = !gridVisible
      },
      toggleSnapToGrid: () => {
        snapToGrid = !snapToGrid
      },
      subscribeTheme: subscribeImmediately,
      subscribeLocale: subscribeImmediately,
      subscribeChromeOverlay: subscribeImmediately,
      subscribeMapBackdrop: (onChange) => {
        onChange('basemap')
        return () => {}
      },
    },
  }
}

/** Builds a `SceneCanvasRuntime` with the detached test app adapter when none is provided. */
export function createTestSceneCanvasRuntime(
  options: Partial<SceneCanvasRuntimeOptions> = {},
): SceneCanvasRuntime {
  return new SceneCanvasRuntime({
    ...options,
    appAdapter: options.appAdapter ?? createDetachedCanvasRuntimeAppAdapter(),
  })
}

function detachedCanvasRuntimeTranslator(
  key: string,
  options?: Readonly<Record<string, unknown>>,
): string {
  return typeof options?.defaultValue === 'string' ? options.defaultValue : key
}

function subscribeImmediately(onChange: () => void): () => void {
  onChange()
  return () => {}
}

function composeDetachedCanvasDocument({
  metadata,
  document,
  canvas,
}: CanvasRuntimeDocumentCompositionInput): CanopiFile {
  return {
    ...document,
    ...canvas,
    name: metadata.name,
    description: metadata.description ?? document.description ?? null,
    consortiums: document.consortiums,
    timeline: document.timeline,
    budget: document.budget,
    budget_currency: document.budget_currency,
    created_at: document.created_at,
    extra: normalizeDetachedExtra(document.extra),
  }
}

/** The Design's `extra`, all of it Design Edit's: the scene owns no `extra` key. */
function normalizeDetachedExtra(extra: CanopiFile['extra']): Record<string, unknown> {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {}
  return { ...extra }
}
