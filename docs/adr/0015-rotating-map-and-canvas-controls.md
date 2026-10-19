# Rotating map and canvas controls

Status: Accepted (2026-09-29, Canopi v2); amended 2026-10-01, 2026-10-03 (phase-1 design check: stamp starts, line zones, Print Areas), 2026-10-04 (reopening restores the saved view, U28), 2026-10-05 (U33: rulers removed; no last-bearing fallback) and 2026-10-06 (U34: turns jump; a native menu with no pointer press opens nothing; U36: overview left-drag pans) and 2026-10-14 (canopi-n2cg: tools are never disabled by zoom; picking one in overview, the Design pin or a catalog drop there fits the Design) and 2026-10-19 (a page angle each, saved: 2.1-Q151, 2.1-Q152)

Amends [ADR 0010](0010-map-first-interface.md) (single-key shortcut scope, compass in the zoom group) and [ADR 0001](0001-geolocated-map-canvas.md), [0004](0004-one-renderer.md), [0008](0008-canvas-pdf-export.md) and [0011](0011-analyses-provenance-and-stories.md) where they assumed north-up or a tool that switches navigation off. The architecture that carries these rules is in ADRs [0016](0016-one-view-transform.md) to [0020](0020-focus-and-keyboard-ownership.md).

## Context

The canvas was north-up and left-drag panned in some modes but selected in others; right-drag opened the menu at press on Linux and macOS; Shift+drag meant different things per tool. Users compare Canopi with GeoLibre, where the map turns. The user asked for rotation like GeoLibre and for controls, rotation and canvas architecture to be planned together, without letting existing shortcuts hold the design back (decisions of 2026-09-29).

## Decision

**Rotation (user).**
- The map rotates (bearing). Editing stays top-down; pitch, 3D and globe are not built now but the camera keeps a pitch slot. There is no setting to turn rotation off.
- Rotation starts only from deliberate gestures: Shift+right-drag and Shift+middle-drag about the pointer, dragging the compass ring, two-finger twist past a threshold, the macOS trackpad rotate gesture past 10°, Shift+←/→ (15° steps). No Alt+wheel.
- Reset north: compass click, N (follows the single-key switch), Shift+N (always on) and Shift+↑. Every turn jumps, with no animation: keys, the compass, "Turn view to this edge" and the snap to north (user, 2026-10-06, U34, replacing "keys and compass animate about 300 ms").
- Free gestures snap to north on release within 7°. While dragging, 15° absolute steps come from Ctrl (Cmd on Mac) added during a Shift+drag, and from Shift on the compass ring (recorded resolution: Shift is already held for the drag). Explicit targets (saved views, stories, "Turn view to this edge", a Design's saved view) are never snapped.
- Grid, grid snapping and measurement guides stay on true east/north and turn with the map. There are no rulers, ruler guides or Snap to guides (user, 2026-10-05, U33, replacing "rulers only when north is up, else a hint"): their north-up-only rule, the hint and its pill, the ruler drag through the input pipeline and the guide store cost more than the few uses they had; the scale bar and measurement guides stay.
- Zones and notes are map objects and turn with the map; a Print Area takes its page's angle and stays level on its page (2026-10-03, 2.1-Q151). Rectangles, ellipses and notes drawn on a rotated map are level with the screen and store the bearing as their rotation; polygons, lines and rows store their corners. Plant names, readouts, badges, handles and other labels stay upright.
- "Turn view to this edge" on a zone edge (canvas menu), with no edge highlight (user, 2026-10-01); line zones are included (convention, 2026-10-03). Saved views store bearing; reopening a Design restores the view it was saved with (`map_view`, by the saved-view rule; user, 2026-10-04), and a Design saved without one opens on the fit at the live bearing (user, 2026-10-05, U33, replacing the device's last bearing from `LastView.bearing`: since every save writes `map_view`, only development files lack it); a new or empty Design opens north-up (convention).
- PDF: each page has its own angle: North up (the default), As on screen, a saved view's bearing, Turn to edge or typed; the sheets of a split turn together (2.1-Q151, reversing the one layout angle of 2026-10-01). The north arrow always points to true north.
- One release (user, 2026-10-01): rotation, the controls and the architecture ship together as 2.0.

**Controls (user).**
- Left click and left drag always select or draw; left-drag never pans (the Pan tool and overview excepted) and Shift+drag is never box zoom. Overview draws no zones or notes, so its left drag pans and nothing is selectable there (user, 2026-10-06, U36).
- No tool is disabled by zoom (user, 2026-10-14, canopi-n2cg, replacing U36's disabled tools). In overview, picking a drawing tool by any path fits the Design as Fit to Design does, then arms it; Select and Pan keep the overview; an empty Design zooms in to working scale about the view centre (a Design whose fit stays in overview too: convention). A plant or saved stamp dragged onto the overview fits the Design, places nothing and stays picked for its stamp tool.
- The Design pin fits the Design on a click, a tap or Enter; a wheel, drag or pinch that starts on it is the map's. The map's input pipeline owns its pointer (user, 2026-10-14, canopi-n2cg): a click or tap it recognises on the pin's box fits, its hover sets the pointer cursor and the pin's tooltip, and the pin element is a keyboard and assistive-tech button only.
- Right-drag pans in every tool, as do middle-drag and Space+drag; a still right-click opens the canvas menu on release (release on every OS: convention). A native context menu with no right, pen-barrel or Mac Control press opens nothing; the Menu key and Shift+F10 reach the selection menu (user, 2026-10-06, U34). Wheel zoom and keys stay live during a drawing drag; a right or middle press during it is ignored (user, 2026-10-01).
- The Pan tool (H) stays for barrel-less pens and one-finger users, off the main rail: View and Tools menus, palette, phone strip.
- A "Pointing device: Mouse / Trackpad" setting reuses the stored `scroll_wheel` field. Linux trackpad pinch is unsupported for now (Ctrl+scroll zooms).
- Single-key shortcuts work anywhere except text fields and modals, and stay switchable off. Esc belongs to the active tool first.
- Arrows nudge the selection 10 cm along screen directions, or pan with nothing selected; Ctrl/Cmd+arrow is the large step.

**Conventions** (planner-decided; the user may overturn them): macOS Ctrl+click is a right-click and Ctrl+drag pans; Cycle labels moves from N to Shift+L; Shift+↓ is reserved for tilt; Shift constrains every drawing tool against screen axes; Plant a row's no-snap moves to Ctrl/Cmd; Esc drops a held stamp pick before leaving the tool; an Object stamp pick starts at 0, so copies keep their source's orientation like Paste, while a saved stamp's pick starts level with the screen (2026-10-03); the inspection lens turns with the view; the World map stays north-up.

## Options considered

- **MapLibre's own handlers** (left-drag pan, right-drag rotate, Shift box zoom): contradict "left always selects" and bypass tools.
- **A setting to disable rotation**: rejected by the user; deliberate gestures and snap-to-north keep accidental turns rare.
- **Snap every rotation to north**: would undo "Turn view to this edge" and near-north saved views.
- **Steps relative to the start bearing** (the old rotate-handle rule): north and the 15° grid become unreachable from, say, 22°.
- **Delete the Pan tool**: overruled; some pens and one-finger users have no other pan.
- **Polygon finishes on a still right-click**: contradicts the menu rule; the menu offers "Finish shape" first.
- **Single keys only while the map has focus** (ADR 0010 as written): the code never did this, and Esc after arming from the rail must work.
- **Hide the compass at north**: removes the ring users rotate with.
- **Right- or middle-drag pan inside a drawing drag**: a nested gesture with a two-level Esc that nobody asked for (user, 2026-10-01).
- **One angle for every page** (user, 2026-10-01; reversed by 2.1-Q151): a terraced slope's detail pages could not each follow their terrace's axis.

## Consequences

- Moved bindings: Shift+arrows no longer nudge; N no longer cycles labels; Shift+right-drag no longer opens the menu; Mac Ctrl+click no longer toggles selection.
- Stored data: `.canopi` gains the optional `map_view` (the view a Design was saved with, a saved-view camera; additive, version 9, 2026-10-04); settings `LastView.bearing` (2026-10-03) and `snap_to_guides` go, and ruler guides (`extra.guides`) are no longer read or written (2026-10-05, U33). Each page's angle is stored with the print setup in the Design (2.1-Q151, 2.1-Q152; the 2026-10-01 in-memory setup reversed).
- Phases, strings and tests are in `docs/plans/canvas-v2-plan.md` and `docs/plans/canvas-v2-spec.md` (deleted at the 2.0 release close; `git log -1 --diff-filter=D -- docs/plans/canvas-v2-spec.md` names the deleting commit, whose parent holds them).
