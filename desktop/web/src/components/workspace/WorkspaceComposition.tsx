import type { ComponentChildren, ComponentType } from 'preact'
import { Suspense } from 'preact/compat'
import { useEffect, useMemo, useRef } from 'preact/hooks'
import { usePlanningViewState } from '../../app/planning-view/state'
import { phoneLayout } from '../../app/shell/phone-layout'
import { siteLocateOpen } from '../../app/site-onboarding/state'
import { storyPresentationActive } from '../../app/story-presentation'
import type { ShellPanelBarProjection } from '../../app/shell-commands'
import {
  activePanel,
  isSidePanel,
  navigateTo,
  sidePanel,
  type Panel,
  type SidePanel,
} from '../../app/shell/state'
import { CanvasPdfDialog } from '../canvas-pdf/CanvasPdfDialog'
import { SavedViewDialogs } from '../shared/SavedViewDialogs'
import { StoryPresenter } from '../stories/StoryPresenter'
import { RenameZoneDialog } from '../canvas/RenameZoneDialog'
import { RotateSelectionDialog } from '../canvas/RotateSelectionDialog'
import { GettingStartedDialog } from '../shared/GettingStartedDialog'
import type { PanelRailCommand } from '../shared/PanelRail'
import { PhoneSheet } from '../shared/PhoneSheet'
import { SidePanelDock } from '../shared/SidePanelDock'
import { SurfaceBoundary } from '../shared/SurfaceBoundary'
import { useModalInertRegion } from '../shared/useModalLayer'
import styles from './WorkspaceComposition.module.css'

type PrimaryPanel = Exclude<Panel, SidePanel>
type WorkspaceSurface = ComponentType<Record<string, never>>

export type WorkspacePanelProjection = {
  readonly [Group in keyof ShellPanelBarProjection]: readonly Pick<
    ShellPanelBarProjection[Group][number],
    'panel'
  >[]
}

export interface WorkspaceSurfaces {
  readonly primary: Partial<Record<PrimaryPanel, WorkspaceSurface>>
  readonly side: Partial<Record<SidePanel, WorkspaceSurface>>
}

export function WorkspaceComposition({
  panelProjection,
  surfaces,
  responsive = false,
  phoneTabs,
  phoneBar,
  phoneOptions,
}: {
  readonly panelProjection: WorkspacePanelProjection
  readonly surfaces: WorkspaceSurfaces
  readonly responsive?: boolean
  /**
   * The side panel commands as the phone sheet's tabs. An edition that passes
   * them shows its panels in the phone sheet while `phoneLayout` is set.
   */
  readonly phoneTabs?: readonly PanelRailCommand[]
  /** The phone sheet's context bar, its first row (PhoneContextBar). */
  readonly phoneBar?: ComponentChildren
  /** The armed tool's options, which the phone sheet shows in place of its panel (ToolOptions). */
  readonly phoneOptions?: ComponentChildren
}) {
  const registrations = useMemo(
    () => validateWorkspaceSurfaces(panelProjection, surfaces),
    [panelProjection, surfaces],
  )
  const currentPrimary = activePanel.value
  const requestedSide = sidePanel.value
  const primary = registrations.primary.has(currentPrimary)
    ? currentPrimary as PrimaryPanel
    : 'canvas'
  // "Where is your site?" is the one task: the dock steps aside, as the tool
  // rail does, and comes back once the site is found or skipped.
  const locating = siteLocateOpen.value
  // A presented story fills the window; the dock comes back when it ends.
  const presenting = storyPresentationActive.value
  const mountedSide = primary === 'canvas'
    && !locating
    && !presenting
    && requestedSide
    && registrations.side.has(requestedSide)
      ? requestedSide
      : null
  const planningView = usePlanningViewState()
  // The map, its chrome and the dock sit behind every modal dialog.
  const root = useRef<HTMLDivElement>(null)
  useModalInertRegion(root)
  const PrimarySurface = surfaces.primary[primary]
  const SideSurface = mountedSide ? surfaces.side[mountedSide] : undefined
  const phone = phoneTabs ? phoneLayout.value : null
  const sidePanelContent = mountedSide && SideSurface ? (
    <div className={styles.sidePanel} data-workspace-side-panel={mountedSide}>
      <SurfaceBoundary key={mountedSide} surface="workspace-side">
        <Suspense fallback={<WorkspaceLoading />}>
          <SideSurface />
        </Suspense>
      </SurfaceBoundary>
    </div>
  ) : null

  useEffect(() => {
    if (
      registrations.primary.has(currentPrimary)
      && (!requestedSide || registrations.side.has(requestedSide))
    ) return
    navigateTo('canvas')
  }, [currentPrimary, registrations, requestedSide])

  if (!PrimarySurface) {
    throw new Error(`Workspace is missing its '${primary}' primary surface.`)
  }

  return (
    <div
      ref={root}
      className={styles.root}
      data-workspace-composition
      data-workspace-primary-panel={primary}
      data-workspace-sidebar-open={mountedSide ? 'true' : undefined}
    >
      <div className={styles.primary}>
        <SurfaceBoundary key={primary} surface="workspace-primary">
          <Suspense fallback={<WorkspaceLoading />}>
            <PrimarySurface />
          </Suspense>
        </SurfaceBoundary>
      </div>
      {phone && phoneTabs ? (
        // The phone sheet stands in for the dock and the panel rail; it steps aside with the dock.
        !locating && !presenting && (
          <PhoneSheet layout={phone} tabs={phoneTabs} bar={phoneBar} options={phoneOptions}>{sidePanelContent}</PhoneSheet>
        )
      ) : mountedSide && sidePanelContent ? (
        <SidePanelDock
          responsive={responsive}
          wide={isWidePanel(mountedSide)}
          expanded={mountedSide === 'calendar' && planningView.calendarExpanded.value}
          onManualResize={() => { planningView.calendarExpanded.value = false }}
        >
          {sidePanelContent}
        </SidePanelDock>
      ) : null}
    </div>
  )
}

export function WorkspaceDialogs() {
  return (
    <>
      <StoryPresenter />
      <CanvasPdfDialog />
      <SavedViewDialogs />
      <RotateSelectionDialog />
      <RenameZoneDialog />
      <GettingStartedDialog />
    </>
  )
}

export function validateWorkspaceSurfaces(
  panelProjection: WorkspacePanelProjection,
  surfaces: WorkspaceSurfaces,
): { readonly primary: ReadonlySet<Panel>; readonly side: ReadonlySet<SidePanel> } {
  const primary = projectedPanels(panelProjection.primary, 'primary')
  const side = projectedPanels(
    [...panelProjection.design, ...panelProjection.planning],
    'side',
  )
  const primarySurfaces = new Set(Object.keys(surfaces.primary) as PrimaryPanel[])
  const sideSurfaces = new Set(Object.keys(surfaces.side) as SidePanel[])

  assertSamePanels('primary', primary, primarySurfaces)
  assertSamePanels('side', side, sideSurfaces)
  if (!primary.has('canvas')) {
    throw new Error("Workspace command projection must include the 'canvas' primary panel.")
  }
  return { primary, side: side as ReadonlySet<SidePanel> }
}

function projectedPanels(
  commands: WorkspacePanelProjection['primary'],
  group: 'primary' | 'side',
): Set<Panel> {
  const panels = new Set<Panel>()
  for (const command of commands) {
    const panel = command.panel
    if (!panel) throw new Error(`Workspace ${group} command is missing a panel identity.`)
    if ((group === 'side') !== isSidePanel(panel)) {
      throw new Error(`Workspace command registers '${panel}' in the wrong panel group.`)
    }
    if (panels.has(panel)) {
      throw new Error(`Workspace command projection registers '${panel}' more than once.`)
    }
    panels.add(panel)
  }
  return panels
}

function assertSamePanels(
  group: string,
  projected: ReadonlySet<Panel>,
  registered: ReadonlySet<Panel>,
): void {
  const missing = [...projected].filter((panel) => !registered.has(panel))
  const unreachable = [...registered].filter((panel) => !projected.has(panel))
  if (missing.length === 0 && unreachable.length === 0) return

  const details = [
    missing.length > 0 ? `missing surfaces: ${missing.join(', ')}` : '',
    unreachable.length > 0 ? `unreachable surfaces: ${unreachable.join(', ')}` : '',
  ].filter(Boolean).join('; ')
  throw new Error(`Workspace ${group} registrations disagree with shell capabilities (${details}).`)
}

/** Site data, Budget, Consortium and Stories open at 440 px; every other panel at 380 px. */
function isWidePanel(panel: SidePanel): boolean {
  return panel === 'site-data' || panel === 'budget' || panel === 'consortium' || panel === 'stories'
}

function WorkspaceLoading() {
  return <div className={styles.loading} aria-hidden="true" />
}
