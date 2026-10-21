import type { ComponentChildren, FunctionComponent, RefObject } from 'preact'
import { useRef } from 'preact/hooks'
import { useFocusRegion } from '../shared/useFocusRegion'
import { useMapOccluder } from '../shared/useMapChrome'
import type { CanvasCommandProjection } from '../../app/canvas-commands'
import type { CanvasContextMenuProfileLine } from '../../app/canvas-context-menu/entries'
import { phoneLayout } from '../../app/shell/phone-layout'
import { siteLocateOpen } from '../../app/site-onboarding/state'
import { storyPresentationActive } from '../../app/story-presentation'
import { toolRailShowsNamesOnMap } from '../../app/tool-rail/learning'
import { CanvasContextMenu } from './CanvasContextMenu'
import { CanvasOverview, OverviewNotice } from './CanvasOverview'
import { DisplayLegend } from './DisplayLegend'
import { InspectionLens } from './InspectionLens'
import { LockedMoveToast } from './LockedMoveToast'
import { PlantAppearancePopovers } from './PlantAppearancePopovers'
import { PlantLabelsChip } from './PlantLabelsChip'
import { SelectionChip } from './SelectionChip'
import { SiteOnboarding } from './SiteOnboarding'
import { SpeciesFocusChip } from './SpeciesFocusChip'
import chipStyles from './SpeciesFocusChip.module.css'
import { ToolCard, type StampChooserProps } from './ToolCard'
import { ToolRail } from './ToolRail'
import { ViewChip } from './ViewChip'
import { ZoomControls } from './ZoomControls'

/**
 * The floating chrome over the map that both editions share: tool rail, tool card, view
 * chip, zoom group, the top-centre chip slot, the selection status chip, right-click menu, plant appearance popovers,
 * the overview pin, inspection, New-Design guidance and the lock toast. The edition hands over its canvas command projection.
 */
export function CanvasChrome({ projection, canvasRef, stampChooser, myLocation, profileLine, children }: {
  readonly projection: CanvasCommandProjection
  readonly canvasRef: RefObject<HTMLDivElement>
  /** Place a stamp's saved-stamp chooser (Desktop, where stamps are saved). */
  readonly stampChooser?: FunctionComponent<StampChooserProps>
  /** Show my location, a button of the zoom group before the compass (Web, U54 Q9). */
  readonly myLocation?: FunctionComponent<{ readonly className: string | undefined }>
  /** The canvas menu's "Profile this line" (Desktop, where Site data is). */
  readonly profileLine?: CanvasContextMenuProfileLine
  /** Edition-only chrome (Desktop: raster inspection). */
  readonly children?: ComponentChildren
}) {
  useFocusRegion(canvasRef, 'map')
  // A presented story shows the map alone, under its own card.
  if (storyPresentationActive.value) return null
  return (
    <CanvasChromeContent projection={projection} canvasRef={canvasRef} stampChooser={stampChooser} myLocation={myLocation} profileLine={profileLine}>
      {children}
    </CanvasChromeContent>
  )
}

function CanvasChromeContent({ projection, canvasRef, stampChooser, myLocation, profileLine, children }: {
  readonly projection: CanvasCommandProjection
  readonly canvasRef: RefObject<HTMLDivElement>
  readonly stampChooser?: FunctionComponent<StampChooserProps>
  readonly myLocation?: FunctionComponent<{ readonly className: string | undefined }>
  readonly profileLine?: CanvasContextMenuProfileLine
  readonly children?: ComponentChildren
}) {
  // "Where is your site?" is the one task until it is answered or skipped.
  const locating = siteLocateOpen.value
  return (
    <>
      {!locating && <ToolRail projection={projection} showNames={toolRailShowsNamesOnMap.value} />}
      {/* Phones show the card and the selection chip in the context bar (PhoneContextBar). */}
      {!phoneLayout.value && <ToolCard stampChooser={stampChooser} />}
      {/* Phones leave Grid and Snap to grid to the View menu. */}
      {!phoneLayout.value && <ViewChip toggles={projection.settingsToggles} />}
      <ZoomControls viewActions={projection.viewActions} myLocation={myLocation} />
      <InspectionLens canvasRef={canvasRef} />
      {children}
      {!locating && !phoneLayout.value && <SelectionChip />}
      {!locating && <CanvasOverview />}
      <DisplayLegend />
      {/* Phones show the top chips in the context bar. */}
      <SiteOnboarding>{!phoneLayout.value && <TopChipSlot locating={locating} />}</SiteOnboarding>
      <CanvasContextMenu profileLine={profileLine} />
      <PlantAppearancePopovers canvasRef={canvasRef} />
      <LockedMoveToast />
    </>
  )
}

/**
 * The one top-centre chip slot (canopi-23p2): the overview notice, the highlight chip and the labels chip stack in it as
 * flow children instead of covering each other, and it registers as chrome over the map's top edge, so fitting and
 * framing keep below it. SiteOnboarding places it: in the Start card's row while that card shows. Phones have none:
 * their chips are the context bar's (PhoneContextBar).
 */
function TopChipSlot({ locating }: { readonly locating: boolean }) {
  const slot = useRef<HTMLDivElement>(null)
  useMapOccluder(slot, 'top')
  return (
    <div ref={slot} className={chipStyles.topSlot} data-top-chip-slot>
      {!locating && <OverviewNotice />}
      <SpeciesFocusChip />
      {!locating && <PlantLabelsChip />}
    </div>
  )
}
