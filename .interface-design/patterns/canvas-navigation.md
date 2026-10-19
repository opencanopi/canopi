# Canvas navigation

Read the [design system](../system.md) first. Decisions: [ADR 0015](../../docs/adr/0015-rotating-map-and-canvas-controls.md) (rotation and controls), [ADR 0017](../../docs/adr/0017-input-pipeline-and-gestures.md) (gestures), [ADR 0020](../../docs/adr/0020-focus-and-keyboard-ownership.md) (keys). Boards: Navigation, NavigationSettings, NavigationPhone, Shortcuts, Menus, Rules.

## Moving the view

- Left click and left drag always select or draw; a left drag never pans, except with the Pan tool. Shift + drag is never box zoom.
- Right-drag, middle-drag and Space + drag pan in every tool. A right or middle press during a drawing, move or band drag is ignored; the wheel and keys stay live; Space must be held before the press. A still right-click (under 3 px) opens the canvas menu on release; a right-drag never opens it. On a Mac, Control-click is a right-click and Control-drag pans.
- Pointing device (Settings › Canvas): Mouse, the wheel zooms about the pointer and Shift + wheel pans; Trackpad, two fingers pan. Pinch and Ctrl + wheel always zoom. The wheel and a pinch zoom continuously; the zoom buttons and + / − change zoom by one step. On Linux a trackpad pinch does not reach the map; F1 says to use Ctrl + scroll.
- Touch: one finger edits, acting when it lifts; two fingers pan, pinch and turn the view and never change the selection; press and hold opens the menu, which stays open after the lift. Handles are 44 px targets after a touch, 20 px after a mouse or pen.
- Pan tool (H) is for pens without a barrel button and one-finger use: a left drag pans. Not on the main rail: View and Tools, the palette and the phone tool strip. Armed, it presses no rail button and its card says "Drag to move the map" with the Esc line.

## Turning the map

- The map turns like a map app; editing stays top-down. North up is the default: a new or empty Design opens north up; a Design reopens at the view it was saved with, and one saved without it opens on the fit at the live bearing.
- Only deliberate gestures turn it: Shift + right-drag or Shift + middle-drag about the press point (horizontal travel), the compass, a two-finger twist past 25 px of arc, a macOS trackpad twist past 10°. Adding Ctrl (Cmd on Mac) during a turn drag steps by 15°; on the compass Shift steps. No setting turns rotation off.
- Keys: Shift ← and Shift → turn to the next 15° step; N, Shift N (always, even with single keys off), Shift ↑ and a compass click reset north. Every turn jumps, with no animation. Esc during a turn drag restores the starting view.
- A free turn (drag, twist, compass ring) that ends within 7° of north settles on north. Explicit targets never snap: saved views, stories, Turn view to this edge, the view a Design was saved with.
- Turns with the map: imagery, zones, text notes, measurement guides, the grid and snapping (true east and north). Stays upright: plant symbols and names, measurements, stack badges, handles, chips and all chrome. The hillshade light stays top-left on screen, so relief reads the same at any bearing.
- Arrows nudge and pan along the screen. Rectangles, ellipses, notes and saved-stamp picks start level to the screen, and an Object stamp pick keeps its source's orientation (a Print Area takes the layout's angle); Shift keeps squares, circles and 45° against the screen axes. With Snap on, a level shape's corners still snap to the true-north grid, so on a turned map its shape may differ from the drag; Snap off keeps the drag.
- Turn view to this edge: a polygon, rectangle or line zone right-clicked within 8 px of an edge (22 px for a long press) adds this item to the canvas menu, as the first group of the empty-map menu and before Lock in the selection menu; the edge is not highlighted. Choosing it turns the view by the smaller angle until that edge is level. Pointer-only, the one exception to the keyboard-path rule (keys: Shift ← and Shift →).
- Saved views, stories and snapshots keep their bearing; the inspection lens turns with the view; the World map for finding a site stays north up.

## Compass

- Always visible, never folded: the last button of the zoom group and of the phone zoom column. It shares the group's layer and visible-map-area registration; it adds none of its own.
- A 28 px ghost icon button (44 px on touch) with a 20 px glyph: a fixed ring and a needle whose north half is filled and south half outlined, turned by the view's bearing so it always points to true north. No "N" letter.
- North up: the needle is `--color-text-muted`, the button stays enabled (a drag still turns the view). Turned: the north half is `--color-accent`, the south half `--color-text`. Hover uses the icon-button hover; during a drag the face takes `--color-accent-soft` and a grabbing cursor. Light and dark come from tokens only.
- A click (under 3 px travel, 8 px for a finger) turns back to north; at north it does nothing. A drag anywhere on the face turns the view about the map centre, the needle following the pointer; Shift steps 15°; release within 7° settles on north.
- Keyboard: a stop in the zoom group; Enter or Space resets north; Shift ← and → turn as anywhere; the blue focus ring as on every control.
- Name "Reset north" with its keys; the tooltip adds the drag hint; the description reads the bearing ("View turned 30° from north", "North is up"; degrees through `Intl`).

## Show my location

- Web only in 2.0, with a secure context and geolocation: a ghost icon button (44 px on touch) before the compass, named "Show my location" in every state.
- A click from Off shows the dot and follows it: the camera jumps to the fix at max(zoom, 17), centred on the whole map. Pressed only while following; a click then turns it off, as does closing the Design. Any other move (a pan, a pointer zoom, a Design, view or story) is Moved away: the dot stays and a click re-centres.
- Blocked (permission denied): disabled; the tooltip says how to allow it. Lost signal: a hollow dot, "unavailable" in the tooltip, still watching. On touch screens a tap shows either reason for 4 s.
- The dot: a platform blue core in a cream ring over its accuracy area, above every map overlay, hidden while a story is presented; never stored (map workspace guide).

## Settings › Canvas

One setting: Pointing device as a segmented Mouse: the wheel zooms / Trackpad: two fingers pan, with the hint "Pinch and Ctrl + wheel always zoom. Shift + wheel pans." The Select tool card follows it ("wheel zooms" or "pinch zooms").

## Keyboard shortcuts (F1)

- Keys: the tools heading reads "(anywhere except text fields)"; Map and workspace adds Turn the view 15° (Shift ← · Shift →), Reset north (N · Shift N · Shift ↑), nudge 10 cm on screen (arrows) and 1 m (Ctrl or Cmd + arrows), Labels (Shift L), zoom one step (+ · −), Fit the Design (Home · Shift F · Ctrl 0), Zoom to selection (Shift 2).
- Mouse, trackpad and pen, then Touch (on every device): one row per gesture above (pan, turn with its 15° step, compass, menu, zoom, Alt + click; one finger, two fingers, press and hold).
- Notes under the lists: "Shift N works even when single-key shortcuts are off."; the Linux pinch note on Linux only.

## Export planting plan

Map orientation, a segmented North up (default) / As on screen, sits under Plant colours; it is not the paper Orientation of a page. The north arrow always points to true north: upright on north-up pages, turned on others. From 2.1 each page has its own angle (2.1-Q151): also a view's bearing, an edge or typed; each area turns about its centre.

## Phones

The zoom column holds the inspection launcher, zoom in, zoom out, Fit to Design, Show my location and the compass (44 px, no scale); a short landscape canvas packs them between top bar and sheet; without room the column hides. The phone View menu has Reset north. The tool strip keeps Pan. Two-finger twist turns the view; nothing on a phone turns it by accident.
