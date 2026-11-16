# One view transform

Status: Accepted (2026-09-29, Canopi v2); amended 2026-09-30, 2026-10-01, 2026-10-05 (U33: no rulers), 2026-10-06 (U34: turns jump; a bearing-free zoom floor) and 2026-10-17 (ledger [2.1-Q78d](../decisions/2-1.md): the view transform is an affine over ground metres; built by Phase 2's true-metres change, 2m); amended 2026-11-16 (billboard discs are ground-sized, screen-upright marks: 2.1-M520)

Amends [ADR 0004](0004-one-renderer.md) (camera ownership) and [ADR 0001](0001-geolocated-map-canvas.md) (bearing is a view property). Product rules: [ADR 0015](0015-rotating-map-and-canvas-controls.md).

Amended 2026-09-30 and 2026-10-01: one `ViewTransform` type and one module that builds it. From phase 0A to 0E the headless driver anchors it on a planar camera (today's `x, y, scale` plus a bearing), so tests written against the old camera keep exact readbacks while the legacy facade lives. From 0E (user, 2026-10-01) both drivers hold a geographic camera and build through the one builder: no user sees bit-for-bit numbers, so tests compare within a tolerance, and a re-origin keeps the camera's ground through lon/lat.

## Context

Screen to world conversion was derived in several places (renderer, scene camera, rulers, annotation layout, snapshots, the inspection lens), each assuming `x, y, scale` and bearing 0; rotation was refused outright. MapLibre 6.10.0 does not constrain a rotate-only move (`setBearing` skips the constrain step, `jumpTo` sets bearing after centre and zoom, the constrain callback cannot see the bearing) and `easeTo` ignores `center` when `around` is set, so letting MapLibre compute targets would make the live map diverge from any headless model exactly on rotation.

## Decision

- **MapLibre's transform holds the camera state** the map renders from. Canopi computes every camera target itself (pure camera maths shared by the MapLibre and headless drivers), constrains it (bearing-free, U34), and applies it through one `CameraDriver` with explicit `jumpTo` (and `flyTo` for long flights). The map stays non-interactive.
- **One writer.** The driver is the only code that calls camera methods on the workspace and snapshot maps; the World map is exempt. A `transformConstrain` guard over the same constrain function covers MapLibre-internal changes (flight steps); the constraint ignores the bearing, so the driver keeps no bearing arc (U34). A resize is a driver move too: the host reports the new size and the driver resizes the map, constrains the camera and publishes one frame.
- **Turns jump** (user, 2026-10-06, U34): keys, the compass, the snap to north and "Turn view to this edge" are one `jumpTo`; there are no rotation tweens or eases. Saved views and stories jump or fly; nothing eases centre and zoom.
- **One `ViewTransform`.** At pitch 0 one module builds it analytically for both drivers, from centre, zoom, bearing and the session plane. Nobody calls `map.project` or `map.unproject`; a contract test holds the builder to MapLibre's `MercatorTransform`. Everything else (renderer, tools, overlays, re-origin, fit, lens) reads this transform. PDF capture reads the live frame when the PDF workspace opens (`captureView`, like saved views; only the last view reads the settled camera) and turns plan geometry with its own page frame, which maps page to ground, not a view.
- **Frames.** The runtime publishes a per-frame `viewFrame`, synchronous ordered `onViewFrame` phases (tools, then overlays), and a `settledViewFrame` after 150 ms. App code and components see only coarse signals (`ViewReadSurface`: mode, zoom band, bearing, north-up, scale, zoom limit, and, in overview only, the Design pin's screen point) and command through `ViewCommandSurface`.
- **An affine, not a similarity** (2.1-Q78d, [ADR 0001](0001-geolocated-map-canvas.md)). The view transform is the camera's similarity on the conformal Web Mercator frame times the session plane's axis scale, diag(1/ax, 1/ay), so a plane metre is a ground metre and the transform is a general affine. MapLibre and the zoom value are unchanged, and a stored lon/lat lands on the same pixel.
  - Every zoom-to-scale conversion takes the plane, never a latitude; `PlanarCamera`, fits and placements cross frames only through `plane.toView` and `plane.fromView`.
  - `screenDistance` goes through the affine. `screenAxesInWorld` is normalised and is not orthogonal off the cardinal bearings. `pixelsPerMetre` is the geometric mean of the two axis scales and serves sizes and tolerances only: a ground shape (a guide, a zone, a rotation handle's angle) is drawn and hit through the affine.
  - The billboard discs (plants and their rings) are ground-sized, screen-upright marks: their ground radius is sized through the plane's `groundScaleAt(p)`, so they grow with zoom, and they are drawn as upright circles, without the affine's per-axis stretch (under 0.7 %; 2.1-M520). A mark sized in pixels (a label, a handle) keeps its pixel size at every zoom.
- **Pitch slot.** `ViewCamera.pitchDeg` is the literal 0, and nothing else is carried for pitch (2026-10-01: pitch is not on the roadmap): `screenToWorld`, the planar projection and its affine are non-null from 0E. When pitch ships, widening them gives the compiler the list of consumers; the recipe is kept on the pitch bead (spec §6).
- **Session plane stays north-aligned** (x east, y south) whatever the bearing; re-origin runs on the settled frame and keeps the camera's ground (MapLibre's camera is geographic; the headless driver applies the plane change in plane terms).

## Options considered

- **Canopi owns the camera state and MapLibre follows**: contradicts ADR 0004's camera ownership and needs an echo loop against MapLibre's own transform. Computing targets differs: the frame is read back from MapLibre.
- **MapLibre computes targets** (`easeTo` with `around`, `transformConstrain` as the only clamp): the 6.10.0 behaviours above break rotation moves and the headless contract.
- **Four-point homography from `unproject` as the source**: sample noise at zoom 27 defeats any affine test; kept for pitch with a pixel tolerance.
- **Matrices from the custom-layer render callback**: exist only inside `render`; tools and DOM need the transform synchronously.
- **MapLibre's internal transform getters**: fragile across upgrades.
- **Mirroring or learning MapLibre's zoom clamp** (today): disagrees under rotation.
- **A second "presented" signal or a microtask view phase**: synchronous ordered phases paint chrome in the same frame and are deterministic in tests.
- **Bearing eases** (driver tweens composing with pans, or MapLibre `easeTo` about an anchor, which stops half-way when interrupted unless the driver carries it): an animation the user chose not to have, for a tween module, two frame loops and an arc state (U34).
- **A bearing-dependent zoom floor**: a turn at world zoom zooms in, and every rotate source needs the arc guard (U34).
- **A world-root strategy interface now**: one implementation for an unscheduled feature.

## Consequences

- The camera code, the shared-scene viewport derivation, `createMapFrame` (`bearing: 0`) and the clamp-learning path are deleted; policy tests keep one camera writer, no projection caller outside the World map and a view module that imports no MapLibre, Pixi or DOM node.
- A headless/MapLibre contract test runs the same camera scripts through both drivers over MapLibre's real `MercatorTransform` and requires 1e-6 px agreement with its forward projection, under the ground-metre plane at several latitudes from Phase 2 (2m) (its own inverse drifts by up to 8e-6 px above zoom 19; multi-move scripts stay below zoom 20).
- The zoom floor ignores the bearing (user, 2026-10-06, U34): zoom ≥ log2(hypot(w, h) / 512), and the pan hold keeps the centre half the screen diagonal inside one world. A turn never changes the zoom; the world view stops 0.14–0.5 zoom levels sooner and panning stops short near ±85° and ±180°.
- Details: `docs/plans/canvas-v2-spec.md`, deleted at the 2.0 release close; `git log -1 --diff-filter=D -- docs/plans/canvas-v2-spec.md` names the deleting commit, whose parent holds it.
