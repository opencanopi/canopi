# Analyses, provenance and stories

Status: Accepted (2026-09-26, Canopi v2); amended 2026-10-17 (Hillshade dropped and terrain engines open, ledger 2.1-Q37, 2.1-Q58, 2.1-Q65)

Amended by [ADR 0015](0015-rotating-map-and-canvas-controls.md) (2026-09-29): saved views and stories restore their bearing; 2026-10-03 (U21, U23): a view records the ground it frames and keeps that frame in any window; the extent record is deleted; 2026-10-05 (U33): the ground size is required; 2026-10-08 (canopi-f47t.42): results live in the Site data panel, and capture records site data visibility with the Layers eye folded in.

## Context

v2.0 ships one analysis (slope) wired directly into the LiDAR workflow. Planned work adds hydrology (from the Whitebox tools bundled in the pinned GeoLibre CLI), canopy analysis ([ADR 0012](0012-vegetation-analysis.md)) and story maps that are designed and presented inside Canopi. Without shared seams each would add its own dialog, result bookkeeping and file fields.

## Decision

- **Analysis registry.**
  - An analysis is an entry in an authored JSON contract (`common-types/analysis-registry.json`, generated into Rust and TypeScript): id, recipe version, input item types, parameters (typed, with defaults and units in metres, m² and degrees), output item types and a lane.
  - Executors stay handwritten in Rust.
  - Shapes: windowed (slope) or whole-grid (contours, hydrology, bounded by an extent cap), on the in-process engine ADR 0023's N0 check picks (the GeoLibre CLI sidecar until then, a Desktop test oracle at most afterwards); vegetation analysis ([ADR 0012](0012-vegetation-analysis.md)) is its own executor module.
  - The Analyze dialog is generated from the registry for the selected source. Slope (`terrain.slope`) is the only entry in v2.0.0; contours and hydrology become entries as they land ([plan](../plans/analysis-registry-and-hydrology.md)).
  - Unavailable entries say why (already in Site data, needs Desktop, needs a point cloud).
- **Typed library items.** Library and site-data items carry a kind: raster (elevation, height, slope, flow…), point cloud, or vector result (streams, watersheds, detected trees, crowns). Layers, legends and value readouts dispatch on kind; nothing assumes an elevation raster.
- **Provenance.** Every derived item records its input items and generations, analysis id and recipe version, parameters and tool version. Refresh re-runs a result in place (every Design that uses it sees the new result; the run stays in the processing history); stale results are flagged with their reason (input, recipe or tool changed); refresh is always explicit, never automatic.
- **Saved views.**
  - A Design can hold named views: camera (lon, lat, zoom, bearing, and the ground the whole map framed, width × height in metres in the view's turned frame, each side at most 1e8 m; a map with no size saves no view), visible layers, highlighted species or objects, the plant labels the map showed (`labels`; a view without them shows the Design's), and optional title and text. Views are Design data (Design Edit authority), stored in lon/lat like everything else.
  - Showing a view or story step restores centre and bearing exactly, never snapping to north, and fits the framed ground into the whole map, panels and story card included: the same window gives the exact saved camera, a smaller one zooms out until nothing framed is cut off, a larger one never zooms in past the saved zoom. Every view records its ground size, and one without it is refused (user, 2026-10-05, U33, replacing U21's camera-zoom fallback).
  - Thumbnails fit the same ground into the image; presenting refits the step on screen when the map settles at another size.
  - The ground and labels fields, the required ground and the old extent record's deletion all kept `.canopi` version 9 ([ADR 0021](0021-canopi-2-breaks-stored-data.md)).
- **Stories.** A story is an ordered list of saved views with rich text and optional images, authored in a Story panel beside the live map and presented full-window inside Canopi (keyboard and click navigation, reduced-motion jumps). Export to a self-contained web page and PDF comes from the same model. Canopi does not depend on ArcGIS StoryMaps.

## Consequences

- The LiDAR slope path is refactored into the registry before new analyses land; the library catalogue gains kind and provenance fields (each catalogue change after 2.0 is a frozen migration step per [ADR 0026](0026-stored-data-after-2-0.md)).
- `.canopi` gains `views` and `stories` before v2.0 ships; the format version bumps and older files are refused. Landing them later would refuse every v2.0 Design.
- Hydrology (canopi-5ys2.1) and canopy analysis (canopi-5ys2.2, per ADR 0012) and story maps (canopi-5ys2.3) build on these seams only.
