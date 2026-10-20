# Hydrology in Canopi: implementation plan

Status: agreed; 2.1, after the architecture step canopi-f47t.52 (epic canopi-eon8). The registry it builds on shipped in 2.0; the whole-grid shape has not. Technical detail: `analysis-registry-and-hydrology.md` in this folder.
Beads: canopi-h90p.9.3 contours + global lane, canopi-5ys2.1.1 water flow, canopi-5ys2.1.2 catchments.
Mockups: the WaterFlow board (rows in the Site data panel); 2.1 draws its Analyze and details boards.

## 1. What users get

From a terrain layer (IGN or any metre-based elevation GeoTIFF), Analyze › Water offers:
- **Water flow:** where water runs and collects — upslope area (m², shown on a log colour scale), streams as lines with their order (wider downstream), wetness index (where soil stays wet), ponding depth (where water sits in hollows). Choose which results to add; streams start from an upslope area you set in hectares.
- **Catchments:** click one or more outlet points on the map; Canopi draws the land draining to each, with its area.
Results nest under their terrain in Site data, read out on the rows ("Stream, order 3 · upslope area 4.8 ha · wetness 11.2"), keep a record of how they were made, and can be refreshed.

Design uses: swales and keylines along contours, pond and wetland placement, water-loving species in wet zones, avoiding planting in flow paths or frost pockets.

## 2. How it runs

- **Engine:** the Whitebox hydrology tools, on the whole-grid engine the 2.1 foundations' N0 check picks (ADR 0023): an in-process engine that builds for wasm32 (the CLI, geolibre-cli 1.5.3, a Desktop test oracle at most, 2.1-M134). Chain: breach (or fill) depressions → D8 flow direction → flow accumulation → extract streams → Strahler order → streams to lines; wetness index from specific catchment area and slope; depth in sink; snap pour points → watershed → polygons. Every tool id and parameter was checked against the pinned binary and run end to end on a test surface.
- **Both editions:** hydrology runs on Web up to the measured Web whole-grid limit, like the windowed analyses; over it, `over_web_limit{limit}` says it needs Canopi Desktop (ADR 0030, 2.1-Q175). N5's size probe runs the full chain at the limit; if it fails, the ADR 0030 row returns with the measured fact.
- **Whole-raster lane:** hydrology needs the entire terrain at once (today's slope works in 1024² windows). The plan adds a bounded whole-grid shape: write the terrain into one scratch GeoTIFF window by window (never a whole-raster buffer in Canopi's memory), run the tool chain, read results back into the existing chunk store. A cap of 25 million cells (e.g. 2.5 × 2.5 km at 0.5 m) keeps peak memory near 1.3 GB; larger terrain is refused by name with the size, before starting.
- **Vectors:** streams and catchments come out as lon/lat GeoJSON, canonicalised (whitelisted properties, rounded coordinates, size cap) and stored as library vector items, drawn by a new MapLibre vector-results layer.
- **Provenance and refresh:** each result records its terrain, settings and tool version; refresh re-runs in place; stale results say why.

## 3. Order

1. Contours (h90p.9.3): proves the whole-grid shape and vector items with one tool.
2. Water flow (5ys2.1.1): recipes and styles only.
3. Catchments (5ys2.1.2): map point picking.

## 4. Rules

- **Threads:** hydrology tools use all cores regardless of `RAYON_NUM_THREADS`; run one heavy job at a time (already the rule) at below-normal priority.
- **Edge effects:** accumulation and catchments are truncated at the terrain's edge; the result details say so.

## 5. Decisions (the user adopted the recommendations)

- **H1** Extent cap 25 M cells.
- **H2** Refresh updates results in place and keeps the run in history (built with the registry in 2.0).
