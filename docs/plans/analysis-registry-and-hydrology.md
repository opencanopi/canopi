# Analysis registry after the 2.1 foundations: contours, global lane, hydrology

Status: agreed; 2.1, after the architecture step canopi-f47t.52 (epic canopi-eon8).

The registry, typed library items, provenance, Refresh, stale reasons and processing history shipped in 2.0 with `terrain.slope` as the only entry (ADR 0011, [data library guide](../guides/data-library.md)). This plan keeps only what is not built: the global lane with vector items (contours), and hydrology. The 2.1 foundations drop Hillshade (2.1-Q58), choose the engines (plan N0) and build aspect and frost pockets on the windowed engine (plan N1). The user-facing summary of hydrology is [hydrology.md](hydrology.md).

Beads:
- `canopi-h90p.9.4` aspect (windowed) is built by the 2.1 foundations' N1; `canopi-h90p.9.2` hillshade is dropped (2.1-Q58).
- `canopi-h90p.9.3` contours: the global lane and vector items.
- `canopi-5ys2.1.1` water flow, `canopi-5ys2.1.2` catchments (parent `canopi-5ys2.1`).
- Rows live in Desktop's Site data panel (`canopi-f47t.42`).

Research basis: `geolibre-rust` at the pinned `aac2b743`, CLI `geolibre-cli 1.5.3`. Every tool id and parameter below was checked with `geolibre manifest <id>` on that binary, and the hydrology chains ran end to end on a synthetic EPSG:2154 Float32 DEM. Recheck them when `GEOLIBRE_REVISION` moves.

## 1. Decisions already taken

- **Lane:** the global-lane and windowed engines are chosen by the 2.1 foundations' N0 check and recorded in ADR 0023 (2.1-Q37); the windowed engine runs in-process and, on Web, as wasm in a worker (2.1-Q65). The CLI facts below hold if N0 keeps the sidecar for the global lane. Hydrology stays Desktop, a row of ADR 0030: wasm32 memory (about 4 GiB) cannot hold global rasters at about 50 B/cell (2.1-Q122).
- **Extent cap:** the global lane admits at most 25 000 000 lattice cells (hydrology.md H1), the same bound as `MAX_RAW_EXTRACTION_CELLS`.
- **Refresh** updates the item in place and keeps the run in history; this shipped with the registry.
- **Catchment v1** recomputes routing from the DEM: no flow-direction item and no result-to-result chain.
- **Order:** contours (proves the global lane and vector items with one tool), then water flow (recipes and styles only), then catchments (map point picking).
- **Upstream:** no upstream issues are filed (thread cap, `wbspatialstats` feature gate, percent progress); Canopi works with the CLI as pinned.

## 2. Tools at the pinned revision

The tools come from `wbtools_oss` (`opengeos/whitebox-wasm` @ `9c0ff4fdf351`), registered by `geolibre-cli/src/main.rs:40 build_registry()`.

**CLI behaviour** (`main.rs:321-460`)
- Tools run as `<tool_id> --k=v ...`; values are inferred as bool, i64, f64 or string. Exit codes: 0 ok, 1 tool error (message on stderr), 2 usage error.
- The last stdout line is an outputs JSON (`{"path":"..."}`); earlier lines are free-text `info`. Percent progress is compiled out (`EMIT_PROGRESS=false`).
- There is no cancellation API; cancel kills the child, as the runner already does. Outputs are written straight to the target path, so write to scratch and publish afterwards.

\* = required parameter.

**Conditioning, routing and accumulation** (all global)
- `breach_depressions_least_cost`: `dem`\*, `output`, `max_dist` (integer, **cells**, default 100), `fill_deps` (false), `max_cost`, `flat_increment`, `minimize_dist`. Float64 output.
- `fill_depressions`: `dem`\*, `output`, `fix_flats` (true), `flat_increment` (1e-4), `flat_resolution` (`garbrecht_martz` or `natural`), `max_depth`. Float64 output.
- `d8_pointer`: `dem`\*, `output`, `esri_pntr` (false). Int16, NoData -32768, values 0..128.
- `d8_flow_accum`: `input`\*, `input_is_pointer`, `out_type` (`cells`, `ca` or `sca`; default `sca`), `log_transform`, `output`. Float32, NoData -32768.

**Streams**
- `extract_streams`: `flow_accumulation`\*, `threshold` (units of the accumulation raster), `zero_background` (false), `output`. Int16; local on the accumulation raster.
- `strahler_stream_order`: `d8_pntr`\*, `streams`\*, `zero_background`, `output`. Int32; global.
- `raster_streams_to_vector`: `d8_pntr`\*, `streams_raster`\*, `all_vertices`, `output`. Lines with `FID` and `STRM_VAL`; global.

**Catchments**
- `snap_pour_points`: `flow_accum`\*, `pour_pts`\* (points), `snap_dist` (**map units**; 0 means one cell), `output`. Local.
- `watershed`: `d8_pntr`\*, `pour_pts`\*, `output`. Int32, NoData -32768; global.
- `raster_to_vector_polygons`: `input`\*, `output`. Polygons with `FID` and `VALUE`; global.

**Wetness and ponding**
- `wetness_index`: `sca`\*, `slope`\* (**degrees**), `output`. Float32, NoData -32768.
- `depth_in_sink`: `dem`\*, `zero_background` (false), `output`. Metres; global.

**Terrain entries**
- Aspect: check the tool id, its stencil and NoData with `geolibre manifest` before building canopi-h90p.9.4.
- `contours_from_raster`: `input`\*, `output`\*, `interval` (10), `base` (0), `smooth` (9, odd), `tolerance` (10°). Lines with `HEIGHT`; run in the global lane.

**Later candidates** (follow-ups under canopi-5ys2.1): `elevation_above_stream` (HAND), `downslope_flowpath_length` and `max_upslope_flowpath_length` (the first rejected pointers from a DEM with NoData corners, so it is deferred), `basins`, `subbasins`, `isobasins`.

**Vector formats and CRS**
- The vector writer picks the format from the file extension; `.geojson`, `.gpkg` and `.shp` were verified.
- The CLI's own `wbprojection` writes GeoJSON in WGS84, reads GeoJSON points as WGS84, and misplaces national grids by up to kilometres. Canopi never trusts it (ADR 0014, A12): tools read and write native coordinates (`.gpkg` in the raster CRS), and every lon/lat step, outlets in and vectors out, goes through the CRS authority `rust_engine/crs.rs`. Canopi stores and exchanges vectors in lon/lat.

**Measured on a 3000×3000 Float32 DEM**

| Tool | Time | Peak memory |
|---|---|---|
| breach with fill | 4.3 s | 473 MB (about 50 B/cell) |
| fill | 5.0 s | 393 MB |
| `d8_flow_accum` from the DEM | 3.3 s | 358 MB |
| `d8_pointer` | 2.3 s | 225 MB |
| `slope` | 3.3 s | 258 MB |

**Threads:** the hydrology and flow tools call `thread::available_parallelism()` directly, so `RAYON_NUM_THREADS=2` does not bound them. The library-wide heavy lease already runs one heavy job at a time; start global-lane children at below-normal priority (`setpriority` in `pre_exec` on Unix, `BELOW_NORMAL_PRIORITY_CLASS` on Windows).

## 3. Design

### 3.1 Registry additions

- `AnalysisGroup` gains `Water` beside `Terrain` (`common-types/src/analysis_registry.rs`); the Library type filter becomes All / Sources / Terrain / Water.
- `AnalysisLane` gains `GeolibreGlobal` beside `GeolibreWindowed { halo }`.
- `AnalysisParamKind` gains `Points { min, max }` (lon/lat picked on the map) for catchment outlets.
- Outputs gain vector items (`VectorFeature`: streams, catchments, contours) beside raster quantities; the typed-item contract in `common-types/src/library.rs` and the catalogue grow with them. A catalogue bump is a frozen ADR 0026 step run in place (2.1's N1 runs v25 to v26) and keeps `source_meta.rs` complete.

### 3.2 Windowed entries

- The windowed lane (`analyses/windowed.rs`) already runs `slope` with halo 2 and its quality mask.
- The 2.1 foundations move slope onto N0's windowed engine and add aspect and frost pockets there (plan N1, 2.1-M44); Hillshade is dropped (2.1-Q58). A windowed entry gets its halo only after an acceptance test proves its stencil and NoData handling across a chunk seam, on the model of `geolibre_slope_matches_the_analytic_surface_across_a_chunk_seam`.

### 3.3 Global lane (`analyses/global.rs`)

1. **Admission** (`admission.rs`):
   - `MAX_GLOBAL_ANALYSIS_CELLS = 25_000_000`, charged on the lattice extent (width × height), because the tool allocates the whole bounding box. That is about 1.25 GB peak in the tool, 25 km² at 1 m or 6.25 km² at 0.5 m.
   - Free space must cover about 40 B/cell of scratch (Float64 intermediates included) plus the 256 MiB floor.
   - Over the cap, the offer reports `ExtentTooLarge` with the size before the user starts, and the job is refused by name. This is a safety limit, not a performance claim.
2. **Materialise the input:**
   - For each occupied 1024² chunk, read it with `generation::resolve_window` (sources) or `GenerationChunkReader` (derived inputs).
   - Write its rows at their offsets in a pre-sized raw Float32 file (`pwrite`; never a whole-extent buffer in memory; invalid cells get the -2^127 sentinel), convert with `raw_to_tif` and tag NoData.
   - Check cancel and free space between windows.
3. **Run the chain** through the engine's generic tool runner: one bounded child per step, below-normal priority, a deadline per step scaled with cell count (600 s is ample at the cap), and the final stdout JSON line parsed defensively; a missing output file is a failure.
4. **Read rasters back** window by window with `RasterEngine::read_f32`:
   - The tool's NoData and non-finite values become invalid; input-invalid cells stay invalid.
   - Chunk COGs are written only for occupied chunks, with no quality chunks.
   - The details view says catchments and accumulation crossing the item's edge are truncated.
5. **Vectors:**
   - Convert the tool's native-CRS `.gpkg` to lon/lat through `crs.rs`.
   - Canonicalise within a bound: at most 64 MiB and 200 000 features, otherwise refuse by name ("raise the stream area threshold"); keep only whitelisted properties renamed to a stable schema (streams `{order}`, catchments `{outlet, area_m2}`, contours `{elevation_m}`); round coordinates to 1e-7°; reject coordinates outside the item's bounds plus a tolerance.
   - Hash the file and admit it to `assets/<sha256>/features.geojson`: files first, then catalogue rows.
6. **Display (native):** vector items get a display descriptor; the asset is staged and renamed into `$APPDATA/lidar/display-vector/<sha>.geojson`, and the Tauri asset scope gains exactly `$APPDATA/lidar/display-vector/*.geojson`. Vector items are not sampled natively.

### 3.4 Recipes

- **`terrain.contours@1`** (global, vector): `contours_from_raster --input=dem.tif --interval=<m, default 1> --base=0 --smooth=9 --tolerance=10 --output=contours.gpkg`; `smooth` and `tolerance` are advanced parameters.
- **`hydrology.water-flow@1`** (global):
  1. Condition the DEM, by parameter `depressions` (`breach`, default, or `fill`): `breach_depressions_least_cost --dem=dem.tif --output=cond.tif --max_dist=<ceil(max_breach_m/pixel)> --fill_deps=true` (advanced `max_breach_m`, default 50) or `fill_depressions --dem=dem.tif --output=cond.tif --fix_flats=true`.
  2. `d8_pointer --dem=cond.tif --output=d8.tif`.
  3. `d8_flow_accum --input=d8.tif --input_is_pointer=true --out_type=ca --output=area.tif` (upslope area in m²).
  4. Streams: `extract_streams --flow_accumulation=area.tif --threshold=<stream_area_m2> --output=streams.tif`, then `strahler_stream_order --d8_pntr=d8.tif --streams=streams.tif --output=order.tif`, then `raster_streams_to_vector --d8_pntr=d8.tif --streams_raster=order.tif --output=streams.gpkg` (lines with `order`).
  5. Wetness (flat cells become invalid): `d8_flow_accum --out_type=sca`, `slope --input=cond.tif --units=degrees`, `wetness_index`.
  6. Ponding: `depth_in_sink --dem=dem.tif --zero_background=false`; non-sink cells are NoData and draw transparent.

  Only the selected outputs' steps run, and the tool ids that ran go into the provenance.
- **`hydrology.catchment@1`** (global, vector):
  - Input `dem`; parameters `outlets` (`Points{1..16}`), `snap_m` (default 5) and the same `depressions` / `max_breach_m` as water flow, prefilled from an existing water-flow run on the same DEM.
  - Steps: conditioning, `d8_pointer`, `d8_flow_accum --out_type=ca`; outlets projected to the raster CRS through `crs.rs` and written as `outlets.gpkg`; `snap_pour_points`, `watershed`, `raster_to_vector_polygons`.
  - `area_m2` = per-value cell count × cell area.

### 3.5 Frontend

- **Kind table** (`app/lidar/item-types.ts`) gains the new quantities and features, with colours from theme tokens:
  - Upslope area: blues with `stretch: 'log'` over `[cell area, max]`. Wetness index: blues over its range. Sink depth: blues over `[0, max]` m. Blue means water; `display-legend.test.ts` holds the rule.
  - Streams: line width by `order`. Catchments: soft fill with an outline. Contours: thin lines, every fifth emphasised, `elevation_m` labels.
  - `display-legend.ts` gains `blues`, `gray` and a log-scale legend.
- **Vector renderer** (`maplibre/vector-results/adapter.ts`): one owner per live map for the GeoJSON sources and layers of visible vector references, created and synced from `workspace-map-contributions.ts` next to `createRasterDisplay`, its layer ids in the lidar band through `bands.ts`, torn down with the map. The contribution snapshot gains `lidarVectors`; Web stays `[]`.
- **Values on Site data rows:** vector items read the feature under the pointer or the pin with `queryRenderedFeatures` on that item's layers: "Stream, order 3", "Catchment, 2.4 ha", "Contour 132 m".
- **Analyze dialog:** the Water group appears; the `points` control is "Pick on map" through the tool host's tap path the Site data pin uses, shown as a removable list, with a keyboard path and Escape to cancel.
- **i18n:** `analyses.<id>.*` keys for each new entry, `library.quantity.<q>` and `library.feature.<f>`, in all 11 locales; the registry key test covers them.

### 3.6 Docs to rewrite in the same changes

- `docs/guides/data-library.md`: global-lane admission and materialisation, vector items and assets, the hydrology NoData rule and edge caveat, vector display and asset scope, global-lane threads and priority. Its "do not materialise a merged raster" rule gains the global lane's bounded on-disk scratch as its one exception.
- `docs/architecture.md`: the vector-results module.

## 4. Tests (write first)

**Rust unit tests (no engine)**
- Registry: `Points` validation (count, inside bounds); global-lane entries one-to-one with executors.
- Offers: `ExtentTooLarge` with the size; free-space refusal.
- Materialisation never allocates a whole-extent buffer (peak live bytes bounded, measured like the `prepared_raster` counters).
- Multi-output publish is atomic: cancelling after the first output publishes nothing and cleans scratch.
- Vector canonicalisation: property whitelist, rounding, out-of-bounds refusal, size cap.

**Ignored `lidar-native` lane** (pinned CLI, analytic surfaces in Lambert-93)
- Contours on a tilted plane: straight parallel lines, spacing = interval ÷ gradient, lon/lat inside the bounds.
- Water flow on a V-shaped valley: the stream follows the floor, order increases downstream, upslope area grows linearly. On a bowl: sink depth equals the analytic depth; fill and breach differ as expected. TWI is finite on slopes and invalid on flats.
- Catchment: an outlet on a two-valley surface covers one valley; `area_m2` = cell count × cell area.
- Cancelling mid-chain kills the child and publishes nothing.
- The real-fixture e2e lane gains `e2e_water_flow_on_ign_mnt`.

**Frontend tests**
- The `points` control: picking, keyboard path, Escape.
- Kind-table styles and legends (log stretch, gray, blues).
- Vector adapter lifecycle: create, sync, teardown, HMR; one test through the real MapLibre map (seam rule).
- Vector values on Site data rows.
- The Web bundle reaches the library engine only through `canopi-library-wasm`'s worker adapter (ADR 0022).

## 5. Risks and constraints

- **Memory:** the global lane is bounded by the extent cap, not by the tool; the offer names the cap so users crop or import fewer tiles.
- **Edge effects:** accumulation and catchments are truncated at the edge of the item's coverage; the details view and the guide say so.
- **Disk:** Float64 intermediates double the scratch size; admission counts them.
- **Tool quirks:** `downslope_flowpath_length` fails with NoData corners and stays out.
- **Native policy:** every new command lands with its `invoke` call site and runs on its executor.
