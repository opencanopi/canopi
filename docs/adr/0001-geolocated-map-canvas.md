# Geolocated map canvas

Status: Accepted (2026-09-25, Canopi v2); rewritten 2026-10-17 for true ground metres (ledger [2.1-Q78d](../decisions/2-1.md); built by Phase 2's true-metres change, 2m); amended 2026-10-17 (geocoding rules, 2.1-Q81, 2.1-Q91)

Amended by [ADR 0015](0015-rotating-map-and-canvas-controls.md) and [ADR 0016](0016-one-view-transform.md) (2026-09-29): bearing is a view property and the view can rotate. Amended 2026-10-04: reopening a Design restores the view it was saved with (U28). Amended 2026-10-06 (Q14, canopi-f47t.26): a saved longitude is clamped to ±180, the range the decoder admits, so a Design dragged past the antimeridian reopens. Amended 2026-10-17 (2.1-Q78d): plane metres are WGS84 ground metres at the plane's anchor, and the view transform is an affine ([ADR 0016](0016-one-view-transform.md)).

## Context

Canopi v1 drew Designs in local metres on a canvas and attached them to the Earth through one Design-level anchor (longitude, latitude, north bearing, placement status, altitude). Users had to place a Design explicitly in a separate Location surface before the map, satellite and LiDAR made sense, and every map feature had to be re-projected through the anchor. The map already hosted the scene as a MapLibre custom layer, so the separate "local canvas" no longer paid for itself.

In 2.0 the plane was a spherical Mercator tangent plane: its metres were off the ground by up to 0.56 % (north-south at the equator) and 0.39 % (east-west at 65°), areas read 0.32 % low at 49°, and stored rotations were off true north by up to 0.17°. The true-metres prototype showed that no model is square both on the ground and on screen, because Web Mercator is not conformal on the ellipsoid (its axes differ by up to 0.67 %). Canopi keeps the ground exact and lets the screen show shapes as the imagery does.

## Decision

- **The map is the canvas.** Basemap, satellite, LiDAR and terrain are the background of the design surface. There is no Design location, no placement workflow and no separate Location surface or primary navigation entry.
- **Files store lon/lat.** The `.canopi` format (v7 at acceptance, v9 now) stores every design object position (plants, zone points, annotations, measurement guide endpoints; groups reference their members by id and store no position) as `GeoPoint { lon, lat }` in WGS84 degrees. Zone rotation is degrees clockwise from true north. The Design-level anchor and its fields are removed.
- **Runtime works in ground metres through a session plane** (2.1-Q78d). The codec builds the plane at the centre of the objects' bounds (an empty Design uses the view centre). The plane is Web Mercator scaled at that anchor by the WGS84 radii, east-west by N·cosφ and north-south by M, so a plane metre is a ground metre at the anchor in every direction and the plane stays an exact affine image of the map. The plane owns this scale: every zoom-to-scale conversion takes the plane, never a latitude.
  - Tools, snapping, measurements, hit testing and PDF layout use plane metres. Re-origin: when the view centre moves more than 10 km from the origin, the plane is rebuilt at the view centre with its own factor and objects are re-projected from their stored lon/lat.
- **One ground measure.** Every length and area shown to the user (chips, guides, PDF text, profile length, a row's count from its spacing) comes from the plane's ground measure, which applies the local factor where it measures (under 1 ppm on a 10 km site). Raw plane distances drift from the ground away from the anchor (1.6 ‰ at 49° and 3 ‰ at 65°, 9 km out), and the roadmap has km-scale sites (ONF plots, catchments).
- **Canonical write-back.** Positions are written rounded to 1e-9 degree, latitude clamped to ±85.051128779, longitude clamped to ±180 on save only (re-origin keeps it unclamped). Rounding is idempotent through the session plane, so an unedited position never drifts; one with more decimals is rounded once. (Amended 2026-10-06, U33: the geo ledger that wrote loaded lon/lat verbatim is gone.)
- **View is not placement.** Pan, zoom, rotation, fit and place search move only the camera. The one view transform is the camera's similarity on Web Mercator composed with the plane's axis scale, so it is an affine ([ADR 0016](0016-one-view-transform.md)): a stored lon/lat lands on MapLibre's pixel, and shapes on screen follow the imagery, up to 0.67 % between axes.
  - Bearing is a view property: the session plane stays north-aligned (x east, y south) at any bearing. A plane angle is a ground azimuth, so a stored angle is exact degrees clockwise from true north. Relocating objects is a normal edit (cut and paste).
- **Navigation.** Place search (name or coordinates) is the title-bar place field, Ctrl K ([ADR 0010](0010-map-first-interface.md) replaced the pin button first decided here); confirm flies the camera. A new Design opens at the last view in settings, else at lat 23.0, lon 13.0, zoom 4, and asks "Where is your site?". Opening a Design restores the view it was saved with (`map_view`, [ADR 0015](0015-rotating-map-and-canvas-controls.md), 2026-10-04); a Design saved without one fits to its objects at the live bearing (U33); a new or empty Design opens north-up.
- **Map layers.**
  - The default basemap is the OpenFreeMap Liberty vector style (Positron, Bright, Dark selectable) with OpenFreeMap/OpenMapTiles/OpenStreetMap attribution.
  - Background is one Layers choice: Satellite, Street map or None; Google is the only satellite imagery.
  - Without a key, Google uses its public tiles (`https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}`), as GeoLibre's basemap control does; the user's own Google key (Settings › Map and imagery; the Layers Satellite row shows the active source and links there, ledger 2.1-Q64) switches to the official Map Tiles API.
  - The keyless public tiles are used for their resolution; the user confirmed (2026-10-14) that this use is covered.
  - EOX Sentinel-2 cloudless, the licensed keyless alternative, was removed at the user's request (2026-09-25), so there is no provider choice.
  - Esri World Imagery was not adopted: its Master License Agreement does not clearly allow keyless display in a free third-party app.
  - OSM raster tiles and MapTiler are removed.
- **Geocoding** uses one provider registry in both editions ([ADR 0005](0005-web-edition-scope.md) for Web): public Nominatim within its policy (2.1-Q81, 2.1-Q91): search on Enter only, at least 1.1 s between requests, results cached, OSM attribution on results; a refusal shows a clear message and offers the coordinate field. Coordinates are parsed locally without a request.

## Options considered

- **The spherical tangent plane** (2.0): square on screen, but off the ground as above.
- **A conformal plane** (one factor √(MN) at the anchor): square on screen, still up to ±0.34 % per axis on the ground; a rotated 100 m square at 49° is 8 cm and 520″ off.
- **A local transverse Mercator plane, the view re-linearised at the camera centre**: metres exact to 10 km, but it misaligns with the map by up to 12 px, so the camera would move objects against the imagery.

## Consequences

- Designs have no site metadata to confirm or undo; the map is always meaningful.
- Stored lon/lat is the only authority, so re-origin and save are lossless and precise to about 0.1 mm.
- Metre-based features keep working inside the session plane; lengths, areas and angles read exactly. No stored data changes: `.canopi`, saved views, the last view and settings keep their meaning.
- Files from before 2.0 are refused ([ADR 0021](0021-canopi-2-breaks-stored-data.md)); later formats migrate forward ([ADR 0026](0026-stored-data-after-2-0.md)).
- Saved object stamps stay relative metre arrangements, now in ground metres; a stamp saved by 2.0 places 0.01 to 0.56 % off its old size, named in the Phase 2 true-metres (2m) handoff and the release notes (ADR 0021 allows it).
- Code that converts a scale by latitude, or treats the view as a similarity (screen circles from a ground radius, orthogonal screen axes, handle angles), misplaces by up to 0.34 % of its distance from the anchor. Branded plane and conformal point types and one policy rule hold it.
- Altitude is no longer Design metadata; terrain comes from LiDAR data.

## Checks

- To be created by Phase 2 (2m): a stored lon/lat lands on MapLibre's pixel to 1e-6 px under the plane; plane lengths at the anchor and the ground measure anywhere on a 10 km site match a WGS84 Vincenty reference within 1 ppm; a rotated square keeps its ground sides and right angles; re-origin stays idempotent at 1e-9°; `scale-only-through-plane` (contracts §18 F36); one real-path test per seam (renderer, camera, map, input) in Chromium, WebKit and Firefox.
