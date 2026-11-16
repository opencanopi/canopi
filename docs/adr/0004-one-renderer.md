# One renderer: PixiJS inside MapLibre

Status: Accepted (2026-09-25, Canopi v2); amended 2026-10-07 (U33 P11: a map's style loads once); amended 2026-11-16 (map and layer failures, keyless Satellite: 2.1-Q350, 2.1-Q351)

Amended by [ADR 0016](0016-one-view-transform.md), [ADR 0017](0017-input-pipeline-and-gestures.md) and [ADR 0019](0019-rendering-and-the-view-transform.md) (2026-09-29): camera changes go through one driver, navigation stays live during a tool's gesture, and the renderer receives one view transform. Amended 2026-10-03 (canopi-0p2n; user decisions U14 and U22): a map failure offers a user Retry, and a basemap that couldn't load shows a notice.

## Context

Canopi v1 drew the scene with PixiJS as a MapLibre custom layer (`maplibre-pixi`) and kept a Canvas2D fallback plus a standalone Pixi canvas backend. The fallback needed its own camera handoff, its own drawing code and its own tests. With the map as the canvas ([ADR 0001](0001-geolocated-map-canvas.md)), a scene without a map has no use.

## Decision

- The only interactive renderer is the PixiJS scene inside a MapLibre custom layer (`maplibre/shared-scene-layer.ts`).
- The Canvas2D renderer, the standalone Pixi canvas backend, renderer fallback selection and camera code that only aligned a metre canvas with the map are deleted.
- If WebGL2 or MapLibre cannot start, the workspace shows an explicit "map unavailable" state. A later map, layer or camera failure unmounts the renderer and the editing session; the Design stays loaded and can still be saved.
- A user Retry rebuilds the map: a new map and context, with the renderer and editing session mounted again over the loaded Scene, which keeps its view, selection and undo. It can be pressed any number of times; nothing restarts on its own, and a failed map stays failed with its notice when another Design opens, with no hidden rebuild (2.1-Q351). There is no Retry without WebGL2, or once a failed renderer initialization has destroyed the runtime.
- Map notices are fixed localized sentences, never engine text, so no URL or key can reach them. The background that couldn't load keeps a notice with Retry until it loads, is hidden or the other is chosen: the Basemap, or Satellite with or without a Google key, whose one sentence covers a rejected key and a lost connection; past its deepest tiles Satellite stretches them, and a place with none is blank, not a failure (2.1-Q350). The map notice is for the background only: another layer's failure shows on its Layers row with Retry (2.1-Q351). One shared component shows notices in both editions.
- MapLibre owns the WebGL2 context, framebuffer, camera state, frame scheduling, resize and context lifecycle. The adapter owns only its scene subscriptions and graphics resources. It never clears or loses the shared context, starts an application ticker, resizes the canvas or renders outside MapLibre's custom-layer callback. Scene edits request `triggerRepaint`. Canopi computes every camera change, constrains it, applies it only through one camera driver, and builds one view transform from the resulting camera ([ADR 0016](0016-one-view-transform.md)).
- Pixi's normal renderer destroy path loses the WebGL context, so the adapter uses a direct `WebGLRenderer`, explicit state reset, MapLibre-frame-only submission and resource-only teardown.
- One pointer sequence picks its owner at gesture start. Canopi tools keep scene mutation, hit testing, locks, grouping and history. Navigation gestures (secondary, auxiliary and Space drags, wheel, two fingers) stay available during a tool's drag; the tool's gesture continues in world space while the view moves ([ADR 0017](0017-input-pipeline-and-gestures.md)).
- The adapter reuses renderer-neutral scene snapshots, zone geometry, plant symbol recipes, colours, label admission and interaction visuals. It never creates a DOM node or MapLibre style layer per plant.
- PDF and inspection lens output stay renderer-neutral and need neither MapLibre nor the network.

## Consequences

- One drawing path to optimise and test; the 2,200-plant scene is the performance reference.
- Devices without WebGL2 cannot edit Designs; they see the unavailable state instead of a degraded canvas.
- A lost context costs one press of Retry, not a restart of Canopi; offline field work shows the basemap notice until the basemap is hidden.
- A map's style loads once: the map is admitted on its first `style.load`, a later one is ignored, and nothing calls `setStyle()`; Basemap, Satellite, terrain and LiDAR install as sources and layers. A lost context fails the map, and Retry's new map recreates graphics resources from scene authority.
