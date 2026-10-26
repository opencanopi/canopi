# Plan: adapt the Computree ONF plugin (ct_pluginonf) to Canopi

Status: agreed; later (canopi-5ys2.2), after hydrology. Nothing is built yet (no `vegetation/` crate or executor module); decisions in §8, ADR 0012.

Research date 2026-09-26. Research and planning only: no Canopi file was edited.

**Sources**
- Upstream: `https://gitlab.com/computree/ct_pluginonf`, cloned to `/tmp/ctonf`, `main` at `229ae44d8858392d4ce99e98d9fef0479d82135b` (2026-08-26, "Merge branch 'dev' into 'main'"). `/tmp/ctsrc/ct_pluginonf` is the same commit.
- Computree core `computree_v6` at `047b208b` (`/tmp/ctsrc/computree_v6`). The plugin uses its `ctlibstructureaddon` (CT_Image2D, Delaunay, interpolator) and `ctlibmath`.
- Binary `/tmp/ctbin/computree-6.2.1-Linux`: `plugins/libplug_onf.so` (35 MB) plus a **closed** `libplug_onfdev.so` (27 MB, no public source).
- Canopi context: `wt-v2` (`AGENTS.md`, `docs/architecture.md`, ADR 0002, ADR 0011, `docs/guides/data-library.md`, `docs/guides/native-and-release.md`).
- The analysis registry shipped in 2.0 (`common-types/src/analysis_registry.rs`, slope only); its 2.1 whole-grid shape and vector items are in `plans/analysis-registry-and-hydrology.md`.
- Pinned `whitebox-wasm` checkout `9c0ff4f` (already in `desktop/Cargo.toml` for `wbgeotiff`).

Machine-readable inventory used for §2: `/tmp/onfinv/inv.json`, produced by `/tmp/onfinv/extract.py`.

---

## 0. TL;DR

1. **Port a small, chosen subset of the ONF plugin to Rust, inside Canopi** (strategy a). Put it in a new workspace crate, `vegetation/` (`canopi-vegetation`, licensed **LGPL-3.0-or-later**; Canopi-authored methods beside the ports, §4.5), and run it in-process as executor modules the registry dispatches.
   - Do not build a C++ sidecar (strategy b). Every ONF step is tied to Qt containers, OpenCV and the Computree item model. A "minimal C++ extraction" would be a rewrite that still ships Qt and OpenCV on four targets.
   - The algorithms worth taking are small: 150–400 lines each, mostly raster morphology plus one Delaunay-neighbour test.
2. **Licence: permission granted; upstream unmaintained.** An ONF colleague of the user said Canopi may use the plugin code as it wants, and nobody maintains the repository any more (budget cuts), so no LICENSE file will be added upstream. 300 of 398 files carry an LGPL-3.0-or-later header, 6 GPL-3.0-or-later (none needed), 92 none (including the tree-top chain). Canopi keeps every ported file under LGPL-3.0-or-later in its own crate (the header-bearing files require it; the rest follow for one consistent boundary) and records ONF's permission in `vegetation/NOTICE` and the third-party notices. The pinned commit `229ae44d` is final.
3. **What to adapt, in order.** All inputs are airborne LiDAR at ~10 pts/m² (IGN LiDAR HD):
   - **First, raster canopy from an above-ground height item** (IGN MNH, or a CHM Canopi computes): canopy gaps (the JMM/lidaRtRee method, LGPL), then tree tops (ONF sigma-optimised Gaussian maxima plus the valley-depth neighbour filter). Also summary facts: cover %, cover area, gap count and gap area.
   - **Next, point-cloud items** (LAS/LAZ/COPC through `wblidar` from the already-pinned whitebox rev) with one terrain analysis. It makes DTM (ground Zmin plus interpolation), DSM (Zmax) and CHM, feeding the raster canopy analyses and slope.
   - **Later:** crowns (ONF has no CHM watershed of its own; decision needed), gap depth, vegetation-structure grids (height percentiles, cover, strata densities; very relevant to syntropic strata), point cleaning.
   - **Never:** TLS stem/section chains, voxel/occlusion research, plot/tiling/inventory scaffolding, avalanche, stork, road and OLD modules, slope and hillshade (Canopi already has them), intensity and scan-direction tools.
4. **Seams (ADR 0011).**
   - A new executor module per method (in-process, the runner's heavy slot on the Job lane, cooperative cancellation, bounded by a cell cap). No new sidecar.
   - Registry entries `canopy.gaps`, `canopy.tree-tops`, `pointcloud.terrain`, then `canopy.crowns`, `canopy.gap-depth` and `pointcloud.structure`.
   - New item kinds: `PointCloud`, vector `TreeTops`, `Gaps` and `Crowns`, and a few raster quantities.
   - Provenance also records engine `onf`, the upstream ONF revision and "resolved" parameters (the sigma the recipe chose).
   - ADR 0012 (accepted) amends ADR 0011 and principle 3, because canopy moves off the GeoLibre lane.
5. **Validation.**
   - Reproduce Computree 6.2.1 (`CompuTreeBatch`, the real `libplug_onf.so`) on the same inputs, using GUI-authored, templated `.xsct2` scripts. A dev-only C++ shim harness is the fallback oracle.
   - Goldens are small grids and vector files checked into Canopi, so comparison tests are **plain `cargo test`** (no engine in CI).
   - Fixtures: synthetic analytic stands (CI), a tiny IGN LiDAR HD crop plus MNH crop (Licence Ouverte Etalab 2.0), and a local full-tile lane.
6. **Upstream bugs found while reading.** Canopi deviates on purpose (nobody upstream to report them to; they are documented in the crate):
   - `OptimizeGaussianOnMaximaNumber` outputs the maxima of the **last sigma tried, not the retained sigma**.
   - `ComputePointHeightFromDTM` subtracts the −9999 NA sentinel, so a height under a DTM hole becomes z + 9999.
   - Blurs and filters treat the −9999 NA as a real value.
   - The OpenCV contour polygoniser can emit self-touching rings.
7. **Size:** 13 beads (§7), sized S/M/L relative to each other; not a calendar estimate. Pace is set by review, gates and validation, not coding time. The user must first decide on the ADR amendment and the approach to crowns (§8).

---

## 1. Upstream facts

### 1.1 Repository

| Fact | Value |
|---|---|
| URL / branch / commit | `gitlab.com/computree/ct_pluginonf`, `main`, `229ae44d8858392d4ce99e98d9fef0479d82135b` (2026-08-26). Other branches: `dev`, `dev_onf`, `CTREE16`, `convertToCMake`. |
| History | 318 commits, 2018-12-14 → 2026-08-26 (v5 history is not in this repo). |
| Authors (commits) | Alexandre Piboule (ONF) 267 across 4 identities; mkrebs 21; Alan Copy 10; rudy.marty 7; Erwan Heye 2. Headers name "Developers: Alexandre PIBOULE (ONF)"; copyright "the Office National des Forêts (ONF), France". |
| Layout | `pluginonf/` holds `step/` (132 steps), `metric/` (14), `filter/` (4), `actions/` and `views/` (interactive GUI), `tools/`, `languages/` (translations) and `Steps_PluginONF.xlsx` (v5→v6 migration tracker). The root has `exemple*.cpp` (model-handle snippets), `priorisation.txt` and `trad_deepl.ahk`. |
| Build | CMake, `find_package(CompuTree)`, C++17, Qt AUTOMOC. Needs the Computree SDK. |
| Registration | `onf_steppluginmanager.cpp`: about 110 registered steps (some `Beta`), about 20 commented out (OLD, avalanches, road probability, hillshade "duplicate of DTMTools", manual inventory…), 14 metrics, 4 filters. |
| Closed companion | The 6.2.1 binary also ships `libplug_onfdev.so`: `ONF_StepComputeAdaptativeSegmentation(02/03)`, **`ONF_StepComputeWatershedAndMergeClusters`**, `ONF_StepDualGaussianFilter`, trunk and stem steps… No source in any public repo. Out of scope unless ONF publishes it. |

### 1.2 Licences (per file)

| Status | Files | Includes |
|---|---|---|
| **LGPL-3.0-or-later** header ("This file is part of PluginONF library … GNU Lesser General Public License … version 3 … or any later version", © ONF) | 300 | `ComputeDTM`, `ComputeDSM`, `ComputeCHM`, `InterpolateDEM`, `SmoothDEM`, `ComputeGapMask`, `ComputeGapsJMM`, `PolygonFromMask`, `ClassifyGround`, `RemoveUpperNoise(V2)`, `RemoveHighGroundPoints`, `ReduceGroundPointDensity`, `ExtractReferenceGroundPoints`, `ComputeTIN`, `ConvertTINtoDTM`, `ComputeCrownProjection`, `RasterQuantileResampling`, all metrics and filters, TLS chain |
| **GPL-3.0-or-later** | 6 | `ComputeOcclusionsSpace` (header "part of Computree version 2.0"), `actions/tools/{polygon,rectangle}forpicking` (© AMVALOR) |
| **No header** | 92 | **`OptimizeGaussianOnMaximaNumber`, `FilterMaximaByNeighbourhood02`, `CreateMaximaCloud`, `FilterWatershedByRadius`, `ConvertRasterToVector`, `ComputePointHeightFromDTM/FromTIN`, `ComputreRDM`**, `CumulativeFilter`, `ComputeSlopeRaster`, `ComputeHillShadeRaster`, `CreateRasterMosaic`, `BatchRasterMerging`, `KeepIntersectingItems`, `ComputePolygonBuffer`, `ComputeGlobalExtent`, `StandardizeIntensity`, `ComputeScanDirection`, `ComputeRelativeIntensityAttribute`, `FilterWires`, `ComputeDominanceIndicators`, `SelectClustersInLogs`, `VectorizeConductivityMap`, `FoldUpCrown`, OLD/road modules, all of `tools/`, several actions and views |
| Repo LICENSE / COPYING | none (never committed) | — |
| Core helpers used (`computree_v6`) | LGPL-3.0 (`LICENSE`) and per-file LGPL-3.0-or-later © ONF | `CT_Image2D`/`CT_AbstractImage2D` (grid, `convertToPolygons`), `CT_DelaunayTriangulation` (1 892 lines in `ct_math/delaunay2d`), `CT_Image2DNaturalNeighboursInterpolator`, `CT_MathStatistics::computeQuantile` |

The header-less files were written by the same author in the same LGPL library. A reasonable reading is that LGPL was intended. Legally, though, a missing grant means default copyright applies. **Plan: port only LGPL-headed code until ONF confirms in writing** (§4.3, §8 Q1). This is not legal advice.

### 1.3 Dependencies the steps actually use

- **Computree item model:** `CT_StepInModelStructureManager` and `Out…` handles, `CT_StandardItemGroup`, `CT_Scene`/`CT_PointIterator`/`CT_NMPCIR` (global point repository), `CT_StdLASPointsAttributesContainer` (LAS fields), `CT_Image2D<T>` (a `cv::Mat_<T>` plus georeference and NA), `CT_Grid3D(_Sparse/_Points)`, `CT_Polygon2D`, `CT_Circle(2D)`, `CT_PointCluster`, `CT_ReferencePoint`, `CT_Triangulation2D`, `CT_DelaunayTriangulation`, `CT_LoopCounter`, `PS_LOG`, `PS_REPOSITORY`. All of this is replaced in a port by plain Rust structs.
- **OpenCV** (core and imgproc): `GaussianBlur`, `dilate`, `erode`, `morphologyEx(CLOSE)`, `compare`, `connectedComponents`, `findContours`, `getStructuringElement`.
- **Qt:** `QList`, `QMultiMap`, `QVector`, `qFuzzyCompare`, `QtConcurrent::map` (DEM interpolation), `QMutex`.
- **Eigen:** `Vector2d`/`Vector3d` only in the chosen steps.
- **Not used by the chosen steps:** PCL, GDAL (readers and exporters live in `plug_base`), GSL, muparser, Boost.

### 1.4 Grid semantics that a port must reproduce (`CT_AbstractImage2D`)

- North-up. `(minX, minY)` is the lower-left corner. Column `x = floor((X − minX)/res)`. Row `y = dimy − 1 − floor((Y − minY)/res)`, so **row 0 is the top**: the GeoTIFF convention, so no flip is needed.
- Cell centres: `minX + (x + ½)res` and `maxY − (y + ½)res`. A coordinate outside `[min, max]` returns "no cell".
- `createImage2DFromXYCoords` uses `dimx = ceil((xmax − xmin)/res)`, then grows while `xmax ≥ xmin + dimx·res`, so a point exactly on the max edge is inside.
- NA is a sentinel value (−9999 in the chosen steps), tested with `qFuzzyCompare`. That comparison is relative, about 1e-12 for doubles and 1e-5 for floats: any value within roughly ±0.1 of −9999 counts as NA in float rasters.
- `setMinValueAtCoords`/`setMaxValueAtCoords`: the first write replaces NA; later writes keep the min or max.
- DTM/DSM "grid mode 1" (the default) aligns `minX`/`minY` to multiples of `res` from `(xBase, yBase) = (0, 0)` and rounds max up to the centimetre. This matches IGN's 0.5 m lattice (tile corners on whole kilometres).

---

## 2. Inventory of every step, metric and filter

Legend:
- **Reg:** R = registered, B = Beta menu, C = commented out (not loaded), – = file only.
- **Lic:** L = LGPL-3.0+, G = GPL-3.0+, **N = no header**.
- **Tier** (§3): 1 = first, 2 = next, 3 = later, ✗ = never.

### 2.1 DTM / DSM / CHM and raster preparation

| Step | Reg | Lic | LoC | What it does | In → out | Key params (defaults) | Deps | Tier |
|---|---|---|---|---|---|---|---|---|
| `ComputeDTM` "Créer MNT (Zmin)" | R | L | 255 | Zmin per cell of the given (ground) points | points [+ extent] → `Image2D<float>` DTM (NA −9999) | res 0.5 m; extent mode (scene bbox / given extent / aligned to X,Y base 0,0) | Qt | **1** |
| `ComputeDSM` "MNS (Zmax)" | R | L | 284 | Zmax per cell; optional NA replacement | points → DSM | res 0.5 m; `convertNA` true, NA → min(DSM) or a value; extent mode | — | **1** |
| `ComputeCHM` "Créer MNH" | R | L | 211 | CHM = DSM − DTM sampled at DSM cell centres; NA if either is NA | DSM + DTM → CHM (DSM grid) | name | — | **1** |
| `InterpolateDEM` | R | L | 226 | Fills each NA cell by **IDW over its Delaunay neighbours** (the core class is misnamed "NaturalNeighbours") among valid cells within a circular window; reads the input only (no cascade) | DEM → DEM | window 10 cells | QtConcurrent, core Delaunay and interpolator (L) | **1** |
| `SmoothDEM` | R | L | 221 | Mean of the (2n+1)² neighbourhood without the centre (NA handling via `neighboursValues`) | DEM → DEM | n = 2 cells | — | **1** (advanced option) |
| `ComputeTIN` / `ConvertTINtoDTM` | R | L | 241/330 | Delaunay TIN of points → rasterised DTM, with NA replacement | points → TIN → DTM | res 0.5; NA mode | core Triangulation2D | 3 (alternative DTM method) |
| `ModifyDEM` | R | L | 307 | Interactive DEM editing | — | — | GUI action | ✗ |
| `ConvertDEMToPoints` | R | L | 191 | Cell centres → 3D points | raster → scene | — | — | ✗ |
| `RefineResolution` | R | L | 503 | Nearest-neighbour resample onto a reference grid | raster + ref → raster | type | — | ✗ (Canopi display does this) |
| `RasterQuantileResampling` | R | L | 270 | Coarser grid whose cell = quantile of the input cells inside it | raster → raster | out res 5 m; q 0.95; extend false | — | 2 (for example CHM P95 at 5 m) |
| `CropRaster` | R | L | 231 | Trim borders | raster → raster | distance | — | ✗ |
| `CreateRasterMosaic`, `BatchRasterMerging`, `LoadBufferedRasters` | R | N/N/L | 679/325/390 | Retiling, merging, buffered tile loading | files ↔ rasters | — | — | ✗ (Canopi collections do this) |
| `CumulativeFilter` | R | N | 177 | Sum over a disc radius | raster → raster | r 2 m | OpenCV | ✗ |
| `ComputeSlopeRaster` | R | N | 222 | Slope (% and °), ArcGIS formula | DEM → rasters | max slope 500 % | — | ✗ (GeoLibre slope exists) |
| `ComputeHillShadeRaster` | C | N | 201 | Hillshade | — | — | — | ✗ |
| `CreateColorComposite` | R | N | 149 | RGB composite for display | — | — | — | ✗ |
| `ComputreRDM` (sic) | R | N | 187 | Relative Density Model (D'Oliveira et al. 2012): per cell, points in [h1, h2) ÷ points below h2 | height points → raster | h1 1 m, h2 6 m | — | 2 (understory density; licence) |
| `ComputeBoundaryV2`, `ComputeGlobalExtent` | R | L/N | 299/154 | Footprint raster / extent box | points → mask/box | res 10 m | OpenCV | ✗ (import probe does this) |

### 2.2 Tree and apex detection (raster)

| Step | Reg | Lic | LoC | What it does | In → out | Params (defaults) | Deps | Tier |
|---|---|---|---|---|---|---|---|---|
| `OptimizeGaussianOnMaximaNumber` | R | **N** | 235 | For σ = step…σmax: Gaussian blur, 3×3 dilate, equal-to-max mask, 8-connected labels, drop maxima below min height, count maxima. Picks the **smallest σ whose count ≤ count(σmax) × coef**. Outputs the blurred CHM at that σ plus a maxima label raster. **Bug:** the label raster kept is the one from the last loop iteration (σmax); the final recomputation at the retained σ is discarded. | CHM → blurred CHM (+σ attribute) + `Image2D<qint32>` maxima | σmax 1.0 m, σ step 0.05 m, min height 2 m, coef 2.0 ("range = 7.7 σ") | OpenCV | **1** (after licence) |
| `FilterMaximaByNeighbourhood02` | R | **N** | 406 | Sort maxima by height (descending); each maximum's position is the mean of its plateau pixels. For each surviving maximum, take the Delaunay neighbours among maxima within 2 × max radius. A neighbour is removed when it is not higher and either within min radius or its **valley depth** is below the threshold. Valley depth is the max drop of the CHM below the straight 3D line between the apexes, sampled every res/10. Repeat until nothing changes, then renumber. Optional DTM turns Z into height. | CHM + maxima [+ DTM] → filtered maxima | depth 0.5 m, min radius 1.5 m, max radius 10 m | CT_DelaunayTriangulation, CT_Grid3D_Points (index only) | **1** (after licence) |
| `CreateMaximaCloud` | R | **N** | 265 | One point per maximum label: mean XY of pixel centres, max Z, minus DTM if given; optional extent clip. Can make reference points instead. | maxima + heights [+ DTM, extent] → points | cloud or ref points | — | **1** (after licence; trivial) |
| `FilterMaximaByClusterPositions` | B | L | 502 | Filters maxima against reference clusters using radii files | — | files | OpenCV | ✗ |
| `ExtractPositionsFromDensity` | R | L | 356 | 2D positions from point-density maxima (TLS stems) | points → points 2D | res 5 cm | — | ✗ |
| `CreateSeedGrid`, `SegmentFromSeedGrid`, `CreatePointGrid`, `ExtractPointsFromGrid` | R | L | ~1 100 | Voxel seed-growing segmentation (TLS) | — | — | Grid3D | ✗ |

### 2.3 Crowns

| Step | Reg | Lic | LoC | What it does | In → out | Params | Tier |
|---|---|---|---|---|---|---|---|
| `FilterWatershedByRadius` | R | **N** | 191 | Keeps, in each watershed label, only pixels within R of the label's highest pixel (the apex). **Needs a watershed from elsewhere** (SEGMA `SEG_StepComputeWatershed`, or closed `onfdev`). | CHM + labels → labels | R 10 m | 3 (with crowns) |
| `ComputeCrownProjection` | R | L | 397 | Convex hull of each point cluster, optionally per height slice | tree point clusters → polygons | slices 0.5 m apart, 2 m thick | 3 (needs point-level segmentation, not in ONF for ALS) |
| `MergeClustersFromPositions02` | R | L | 560 | Grows crowns from 2D positions by nearest-neighbour cluster aggregation, then interactive correction | positions + clusters → scenes | h ref 1.3, dMax 2 | ✗ (interactive, TLS) |
| `SegmentCrownsFromStemClusters` | B | L | 390 | Crowns from TLS stem clusters | — | dMax 1 | ✗ |
| `FoldUpCrown` | C | N | 159 | — | — | — | ✗ |

### 2.4 Gaps and cover

| Step / metric | Reg | Lic | LoC | What it does | In → out | Params (defaults) | Deps | Tier |
|---|---|---|---|---|---|---|---|---|
| `ComputeGapsJMM` | R | L | 393 | Gap map "after Jean-Matthieu Monnet, lidaRtRee". Gap = CHM ≤ hmax. With ratio > 0, for each hmin from hmax to min(max CHM, 60 m) in bin steps: mask CHM > hmin, morphological **closing** with a custom disk of diameter `floor(hmin/ratio/res/2)·2+1`, then union. Gaps are the complement; optional "reconstruct" keeps original gaps not fully closed. 8-connected labels; keep gaps with area in [min, max]; relabel. | CHM → `Image2D<qint32>` gap ids | hmax 10 m, min 25 m², max 99 999 m², bin 1 m, ratio 2 (0 = plain threshold), reconstruct false | OpenCV | **1** |
| `ComputeGapMask` | R | L | 244 | Gap = CHM ≤ threshold (NA if < NA threshold). Repeated 3×3 **cross** erosion; value = number of erosions the pixel survives (a Manhattan distance to canopy, in cells); −1 canopy. | CHM → `Image2D<int>` | threshold 5 m, erosions −1 = all | OpenCV | 2 |
| `ONF_MetricRasterCoverRatio` | metric | L | 229 | % of valid pixels > threshold (CovRatR), cover area (CoArea), gap area (GapArea), optionally within a plot polygon | raster → values | h 10 m | — | **1** (summary fact) |
| `ONF_MetricRasterGaps` | metric | L | 208 | Number of gaps (NGp) and total gap area (SGp) from a gap-id raster | gap ids → values | — | — | **1** (summary fact) |
| `ONF_MetricCoverRatio` | metric | L | 207 | First returns above h ÷ all first returns | height points → value | h 10 m | LAS attrs | 2 |
| `PolygonFromMask` | R | L | 256 | Polygons from a boolean mask (one or many per mask) | mask → polygons | mode | OpenCV | 1 (polygoniser semantics) |
| `ConvertRasterToVector` | R | **N** | 181 | Polygons per label, with holes, optional min area and ignore-0; delegates to the core `CT_AbstractImage2D::convertToPolygons` (L): pixel-edge rings from `findContours(RETR_EXTERNAL, CHAIN_APPROX_NONE)` | labels → polygons + value | keep holes true, min area 100 m² (off) | OpenCV | 1 (use the **core** L code; the step wrapper is trivial) |

### 2.5 Point filtering, classification and height normalisation

| Step / filter | Reg | Lic | LoC | What it does | Params (defaults) | Tier |
|---|---|---|---|---|---|---|
| `ONF_FilterByReturnType` | filter | L | 410 | Keep First/Last/LastAndOnly/Intermediate/Only/All; optional class sets (vegetation 3–5, ground 2, 0, 1, building 6, water 9); drop synthetic, key-point, withheld and overlap | All | **1** (input selection inside recipes) |
| `ComputePointHeightFromDTM` | R | **N** | 243 | h = z − DTM(x,y) as an attribute or a new cloud; **bug:** NA DTM gives z + 9999 | outputs | 2 (trivial; write clean-room) |
| `ComputePointHeightFromTIN` | R | N | 259 | Same with a TIN | — | 3 |
| `RemoveUpperNoise` | R | L | 316 | Column-wise vertical-gap test on a 5 m grid; drops isolated points high above the canopy | res 5 m, min filled 1, valid 5, max spacing 5 m | 2 |
| `RemoveUpperNoiseV2` | R | L | 484 | By altitude (DTM/TIN) or height: safety height 15 m, max height 100 m, drop underground, 2 m grid, 5-cell search, empty-cell spacing | as listed | 2 |
| `ONF_FilterRemoveUpperOutliers` | filter | L | 276 | Voxel counts; drop sparse cells with an empty column gap below | res 1 m, ≤ 2 pts, dc 1 | 2 |
| `RemoveHighGroundPoints` | R | L | 390 | Ground points that are really vegetation where ground is missing: Zmin grid, erode/dilate the occupancy mask, extrapolate Zmin inward by 8-neighbour means, drop cells with ΔH > max | res 1 m, 2 erosions, ΔH 2 m | 2 (drone/other LiDAR with poor ground) |
| `ClassifyGround` | R | L | 452 | **TLS** ground: Zmin grid, density in a slab of given thickness, density and neighbourhood coherence | res 0.5, slab 0.32 m, density 200 pts/m², 3 cells | 3 (TLS only; ALS unclassified goes to GeoLibre `lidar_ground_point_filter`) |
| `ExtractReferenceGroundPoints`, `ReduceGroundPointDensity` | R | L | 345/319 | Thin ground points (lowest or nearest centre per cell) | res 0.1/0.25 m | 3 |
| `ONF_FilterKeepLastReturnInSlice`, `ONF_FilterByIntensity` | filter | L | — | Slice and intensity filters | — | ✗ |
| `FilterWires` | B | N | 305 | Power-line removal by local line fits | — | ✗ |
| `StandardizeIntensity`, `ComputeScanDirection`, `ComputeRelativeIntensityAttribute` | R | N | — | Intensity and trajectory tools (need a scan path) | — | ✗ |

### 2.6 Point and structure metrics (area-based)

All are per plot or cell: Computree evaluates them through `plug_base` metric steps over plots or grids.

| Metric | Lic | What | Tier |
|---|---|---|---|
| `ONF_MetricQuantiles` | L | Height percentiles from qmin to qmax by step (defaults 5 %–95 % by 5 %), plus Hmin, Hmed, H99, Hmax; linear interpolation `v[⌊q(n−1)⌋] + frac·Δ` (R type 7) via `CT_MathStatistics` | 2 |
| `ONF_MetricNApexMean` | L | Mean of the N highest points above p % of Hmax (N 6, 70 %) | 3 |
| `ONF_MetricLADBouvierEtAl2015` | L | Leaf area density per slice (dz 1 m, to 60 m, k 0.5), matches lidR `LAD` | 3 |
| `ONF_MetricNbyLASClass` | L | Counts per return type and class | **1** (import probe facts) |
| `ONF_MetricMinMaxLASFields` | L | Min and max of each LAS field (QA) | ✗ (the probe covers it) |
| `ONF_MetricLASPointCrown`, `ONF_MetricPointCrownShape` | L | Apex penetration and crown-top shape on tree clouds | ✗ (needs tree clouds) |
| `ONF_MetricRasterCrown`, `…Crown4` | L | Rumple, 3D area, crown volume on a per-crown CHM | 3 (with crowns) |
| `ONF_MetricRasterExtend` | L | Raster extent | ✗ |
| `ONF_MetricIntensity` | L | Intensity statistics | ✗ |
| `ComputeVerticalProfile`, `CorrectALSProfile` | L | Z point-count profile; ALS occlusion correction with an Otsu split into upper and lower layers | 2 (strata) |
| `ComputeDominanceIndicators` | N | Schutz 1989 competition index from apexes plus crown diameters | 3 |
| `ComputeCumulativeNRTable`, `ComputeCumulativeSummary`, `ExportRastersInTable` | L | Loop exports | ✗ |

### 2.7 TLS stems and sections ("Détecter tiges, méthode ONF")

`DetectSection07`, `FilterGroupsByGroupsNumber`, `MergeNeighbourSections04`, `MergeEndToEndSections04`, `SetFootCoordinatesVertically`, `FitAndFilterCylindersInSections`, `ExtractDiametersFromCylinders`, `SelectClustersInLogs` (N), `RefPointFromArcCenter`, `RefPointFromBarycenter02`, `SmoothSkeleton`, `ChangeClusterThickness02`, `VoxelClusterization`, `FitCirclesAndFilter`, `FitCylinderOnCluster`, `FilterClustersBySize`, `ExtractLogBuffer` (B), `MergeNeighbourClustersInGrid` (B).

This is a stem-detection and DBH chain for terrestrial scans: horizontal slices, clusters, logs, circle and cylinder fits, diameters. About 4 000 lines, all L except one. **Tier 3** (only if terrestrial-scan users appear, as a separate epic). Never for ALS.

### 2.8 Voxels, occlusion and research

`ComputeHitGrid`, `ComputeEmptinessGrid`, `ComputeOcclusionsSpace` (G), `ComputeClusterGrids`, `Compare3DGridsContents`, `DilateBoolGrid`, `FilterGridByCloud`, `FilterGridByValueAndNeighborhood`, `FilterPointsByBoolGrid`, `MatchClusterByGrids`, `SelectCellsInGrid3D(ByBinaryPattern)`, `ModifyVoxelSegmentation` (C), `ConvertSceneToCluster` (C), `ComputeNestVolume` and `ComputeStorkTrajectory` (B, "Cigognes"). **✗.**

### 2.9 Plots, tiling, footprints, co-registration and inventory

`AddTileXYAreas`, `AddArbitraryTileXYAreas`, `CreateTiling`, `ComputeCumulativeConvexHull`, `FilterElementsByXYArea`, `KeepIntersectingItems` (N), `SelectBBoxByFileName`, `ComputePolygonBuffer` (N), `CreatePlotManagerGrid`, `CreatePlotsFromList`, `CreatePlotManagerFromFile`, `ExtractPointsForPlots`, `AddLASDataToPlots`, `LoadPlotAreas`, `LoadCircularPlots`, `LoadTreeMap`, `AdjustPlotPosition02`, `AffiliatePointAlignementsAndFieldInventory` (B), `SelectSceneForEachPosition`, `ModifyPositions2D`, `FilterItemsByPosition`, `ApplyDTMToCircle2D`, `ImportSegmaFilesForMatching`, `LoadPositionsForMatching`, `MatchItemsPositions` (B, 1 248 lines, Monnet–Mermin 2014 co-registration in `tools/`), `ManualInventory` and `ValidateInventory` (C), `SetAffiliationIDFromReference` (C), `AddFakeCounter` (C), `MergeScenesByModality` (B, "does nothing"), `ComputeAttributeMapFromClusters`.

These are Computree workflow scaffolding (loops, tiles, plots, field inventory). Canopi's registry, library and Designs replace them. **✗.**

### 2.10 Thematic modules

- OLD (legal brush-clearing duty) `ComputeOLDRasters`/`Vectors` (C, N).
- Avalanche protection forest `ComputeProtectionForestMask`, `ComputePotentialStart*` (C, L).
- `ComputeRoadProbabilityRasters` (C, N).
- `VectorizeConductivityMap` (unregistered, N).

**✗.**

---

## 3. Relevance for Canopi users

**Users.** Agroforestry and syntropic designers working mostly with airborne LiDAR. In France that is IGN LiDAR HD: 10 pulses/m² or more, classified into ground 2, low vegetation 3 (0–0.5 m), medium 4 (0.5–1.5 m), high 5 (> 1.5 m), building 6, water 9, bridge 17, plus a few IGN-specific classes. IGN also publishes 0.5 m MNT, MNS and MNH rasters (Licence Ouverte Etalab 2.0). Drone LiDAR and terrestrial scans come up sometimes.

**What they need from canopy data:**
- where existing trees are and how tall (keep, work around, shade);
- where the canopy opens (gaps: light, planting pockets, clearings for forest-garden conversion);
- how much of a site is covered;
- how the vertical strata are occupied (the syntropic emergent / high / medium / low layers);
- a usable terrain model (DTM → slope, hydrology).

They do not need forest-inventory scaffolding, stem diameters or research voxel tools.

### 3.1 First

| Capability | ONF source | Why |
|---|---|---|
| **Canopy gaps** (`ComputeGapsJMM` + core polygoniser + `RasterGaps`/`RasterCoverRatio` facts) | L | Directly useful. Works on IGN MNH with no point cloud. The lidaRtRee method is a published reference (and can be cross-checked with lidaRtRee). Licence-clean. |
| **Tree tops** (`OptimizeGaussianOnMaximaNumber` → `FilterMaximaByNeighbourhood02` → `CreateMaximaCloud`) | **N** | The most-wanted output: existing trees as points with height. The valley-depth test is ONF's added value over plain local maxima (it merges multi-top crowns of broadleaves). |
| **DTM / DSM / CHM from points** (`ComputeDTM`, `ComputeDSM`, `ComputeCHM`, `InterpolateDEM`, optional `SmoothDEM`, `FilterByReturnType` class selection) | L | Needed for drone and other LiDAR without IGN rasters, and for consistent CHM/DTM pairs. The DTM becomes a ground-elevation item that is slope-eligible. Streaming Zmin/Zmax keeps memory at O(cells), not O(points). |
| **Import probe facts** (`NbyLASClass`) | L | Point count, class histogram and return counts decide eligibility: "no ground class", "unclassified". |

### 3.2 Next

- `ComputeGapMask`: distance-to-canopy-edge inside gaps, a proxy for how sunny a gap's interior is.
- Structure grids at 1–10 m: `MetricQuantiles` (P95, median), `MetricCoverRatio`, strata densities (the RDM idea; per-layer shares of returns in 0–0.5, 0.5–1.5, 1.5–5, 5–15 and > 15 m). This maps directly onto syntropic strata.
- `RasterQuantileResampling`: coarse P95 canopy maps from a CHM.
- Point cleaning as recipe options: `RemoveUpperNoiseV2` or `FilterRemoveUpperOutliers` (birds, atmospheric noise in drone or older data), `RemoveHighGroundPoints` (misclassified ground).
- `ComputePointHeightFromDTM`: needed internally by structure metrics. Trivial; write it clean-room, with NA handled.

### 3.3 Later

- **Crowns.** ONF itself has no CHM crown segmentation. `FilterWatershedByRadius` only post-filters a watershed produced elsewhere (SEGMA, whose files have no licence headers; or the closed `onfdev`). See §8 Q3.
- Crown metrics (`RasterCrown4`: crown volume and rumple) once crowns exist.
- TIN-based DTM.
- Vertical profiles.
- Dominance index.
- TLS stem/DBH chain (separate epic, only on demand).

### 3.4 Never

- Slope and hillshade: Canopi has GeoLibre slope, and the ONF versions have no header.
- Mosaic, merge, retile, crop and resample tools: the library collection model replaces them.
- Plots, loops, footprints, inventory and co-registration.
- Voxel, occlusion and emptiness research tools.
- Intensity, scan-path and wire tools.
- Avalanche, stork, OLD and road modules.
- Interactive actions (`Modify*`, `Select*` with GUI).
- `ClassifyGround` for ALS: it is a TLS method; for unclassified ALS use a real ground filter such as GeoLibre `lidar_ground_point_filter`.

---

## 4. Adaptation strategy

### 4.1 Options

| | (a) Rust port in Canopi | (b) Minimal C++ library/CLI sidecar | (c1) Optional user-installed Computree | (c2) Keep canopy on GeoLibre CLI |
|---|---|---|---|---|
| What ships | A `canopi-vegetation` crate compiled into the app | A per-OS binary, `onf-cli-<triple>`, plus OpenCV (core and imgproc) and QtCore, or rewrites of the Qt parts | Nothing (detected install, ~500 MB) | Already shipped |
| Build (Win/macOS x64+arm64/Linux) | Plain cargo; nothing new in CI | CMake + vcpkg OpenCV/Qt per target (hours of cache warm-up); a new C++ toolchain in the release matrix; codesign and notarise one more binary; AppImage/deb bundling | None for Canopi; users on macOS arm64 have no native build | None |
| Size | About 0.3–1 MB of code | 10–25 MB per target (static OpenCV imgproc + QtCore) | 0 (user has 500 MB) | 0 |
| Fidelity | High by construction and test. Risk points: OpenCV border rules, Delaunay tie-breaking on lattice points, float summation order (§4.4) | Highest if compute bodies are kept verbatim. The item model, handles and logging must still be stubbed; every step body touches them | Exact | Different algorithms (not ONF) |
| Canopi native rules | Natural fit: an executor module in the heavy slot, a cancel token checked at bounded loop points, admission by cells and points, no child process | Child process through the bounded runner; cancel = kill; progress by parsing; file IPC | Same as (b), plus an unverifiable exit code (always 0), French logs, version-bound XML | Existing |
| Maintenance vs upstream | Upstream is unmaintained: the pinned commit is final and Canopi owns the port; each port is a small hand translation | Easier diffs, but the stubs follow Computree API churn (the v5→v6 migration was huge) | Pinned templates per Computree version | Upstream GeoLibre |
| Testability | `cargo test` with checked-in goldens; no engine needed in CI | Needs the binary in CI (like the `lidar-native` lane) | Local only | Existing lane |
| Licence | Ported files stay LGPL-3.0-or-later in their own crate, combined into AGPL-3.0-or-later Canopi (§4.3) | Separate LGPL program; Qt/OpenCV notices | None shipped | MIT/Apache plus AGPL `wbspatialstats` (already) |
| Verdict | **Recommended** | Rejected: the "minimal extraction" is really a rewrite, and it keeps two heavy C++ dependencies and a fifth toolchain | Rejected: see the spike | Contradicts the user's choice; still valid for slope and hydrology |

### 4.2 Recommendation (a), in detail

- **Crate:** a new workspace member `vegetation/` (package `canopi-vegetation`, `license = "LGPL-3.0-or-later"`, not `license.workspace`; ported ONF code in `src/onf/`, Canopi-authored methods in `src/methods/`, see §4.5). It depends on nothing Canopi-specific. It holds pure algorithms over plain types:
  - `Grid<T> { min_x, min_y, res, dim_x, dim_y, na: T, data: Vec<T> }` with CT semantics (§1.4);
  - `PointSource` trait (streaming `x, y, z, class, return_number, num_returns, flags`);
  - `Cancel` (`&AtomicBool`, checked every row or every 65 536 points).
  - Only this crate carries LGPL code. Canopi glue (catalogue, jobs, registry executors) stays AGPL in `desktop/`.
- **Modules** (each names its upstream file):
  - `grid.rs`: `CT_Image2D` / `CT_AbstractImage2D` semantics.
  - `morph.rs`: OpenCV-equivalent Gaussian blur, dilate, erode, close, 8-connected labelling, equality compare, with OpenCV border rules. Written from OpenCV's documented behaviour, not copied: OpenCV is Apache-2.0, and we reimplement rather than port.
  - `polygonize.rs`: pixel-edge rings per label, with holes, from core `convertToPolygons`.
  - `dem.rs`: ComputeDTM, ComputeDSM, ComputeCHM, InterpolateDEM, SmoothDEM.
  - `gaps.rs`: ComputeGapsJMM, ComputeGapMask.
  - `metrics.rs`: RasterCoverRatio, RasterGaps, NbyLASClass, Quantiles, CoverRatio.
  - `filters.rs`: FilterByReturnType.
  - `maxima.rs`: OptimizeGaussianOnMaximaNumber, FilterMaximaByNeighbourhood02, CreateMaximaCloud.
  - `delaunay.rs`: a thin adapter.
- **Reuse before writing (principle 3).** The pinned `opengeos/whitebox-wasm` rev `9c0ff4f` that Canopi already depends on for `wbgeotiff` also contains:
  - `wblidar`: LAS/LAZ/COPC read, streaming `PointReader::read_point`, COPC `data_node_keys_bbox`, CRS; MIT OR Apache-2.0; minimal deps (`wide`, `wbprojection`, `wbhdf`); its CRS is read for the code only, never to place points.
  - `wbtopology`: `delaunay_triangulation`, robust predicates; deps `wbvector`, `robust`.
  - Not `wbprojection`: it places national grids 30 m to 1,262 km off. Every lon/lat step goes through the raster engine's CRS authority, `rust_engine/crs.rs` (ADR 0014, A12).
  - Use these as git deps at the same rev. `las` 0.11.1 (MIT) plus `laz` 0.13.0 (Apache-2.0) and `copc-rs` 0.5.0 are the fallback if `wblidar` falls short. `spade` 2.15.1 (MIT/Apache) is the Delaunay fallback.
  - No OpenCV or Qt.
- **Execution:** in-process in the existing analysis job:
  1. `Local` executor.
  2. the runner's heavy slot.
  3. Read input windows through `generation::resolve_window` into one `Grid<f32>` (under the cell cap).
  4. Run.
  5. Write raster outputs as the existing sparse 1024² chunk COGs, and vector outputs through the registry plan's GeoJSON canonicaliser.
  6. Publish in one transaction.
- Cancellation is cooperative, so there is no kill: every loop in the port checks `Cancel` at a bounded interval. That replaces Computree's `isStopped()`, which ONF checks per item, too coarsely.
- In-process work cannot be killed on a deadline. Boundedness therefore comes from admission (§5.5) plus those cancel checks.
- **Deliberate deviations from Computree.** Correctness wins. Each deviation gets its own test and a line in the guide, and fidelity tests use inputs where the two agree.
  1. NA never enters a blur, max filter or mean. Invalid height cells are filled with 0 m for smoothing only (heights; "no canopy"), and outputs stay invalid where the input was invalid.
  2. Maxima labels come from the retained σ, with the min-height rule (fixes the `OptimizeGaussian…` bug).
  3. The height of a point over a DTM hole is invalid, not z + 9999.
  4. Polygons are valid RFC 7946: 4-connected pixel-edge boundaries. Diagonal-only contacts become a MultiPolygon, never a self-touching ring.
  5. DSM NA is not replaced by min(DSM) (the ONF default) when the DSM feeds a CHM. It stays NA; `pointcloud.terrain` can optionally interpolate it.
- **No upstream reporting:** the repository is unmaintained; deviations are documented in the crate and the guide.

### 4.3 Licence mechanics (not legal advice)

- **LGPL-3.0-or-later → Canopi (AGPL-3.0-or-later).**
  - LGPLv3 is GPLv3 plus additional permissions.
  - A Rust translation is a derivative work of the LGPL files. It may be distributed under LGPL-3.0-or-later (keeping it that way is simplest), or as GPL-3.0-or-later by removing the additional permissions (GPLv3 §7).
  - GPLv3 §13 and AGPLv3 §13 allow combining GPLv3-family code with AGPLv3 code into one work. Each part keeps its licence; the combination is conveyed under AGPL terms, including the network clause.
  - Canopi already ships complete corresponding source, so LGPL's relinking terms are trivially met.
- **Obligations.**
  - Keep ONF's copyright and licence notice in every derived file.
  - State the modification and date prominently (GPLv3 §5(a), inherited by LGPL).
  - Ship the LGPL-3.0 **and** GPL-3.0 texts (`vegetation/LICENSE`, `vegetation/COPYING`).
  - Add a hand row for the one root `THIRD_PARTY_NOTICES.md` (2.1-M216) naming the ONF plugin, commit `229ae44…`, "LGPL-3.0-or-later, translated to Rust", plus the core `computree_v6` commit `047b208…` for `CT_Image2D`, Delaunay and the interpolator.
  - Extend `third-party-notices.test.ts` so it checks the ONF revision constant (like `GEOLIBRE_REVISION`).
- **Header template for each ported file:**

  ```rust
  // SPDX-License-Identifier: LGPL-3.0-or-later
  // Derived from PluginONF (https://gitlab.com/computree/ct_pluginonf) at
  // 229ae44d8858392d4ce99e98d9fef0479d82135b, pluginonf/step/onf_stepcomputegapsjmm.cpp.
  // Copyright (C) 2010-2019 the Office National des Forêts (ONF), France.
  // Developers: Alexandre Piboule (ONF).
  // Translated to Rust and modified by the Canopi contributors, 2026-10.
  // This file is free software under the GNU Lesser General Public License v3
  // or (at your option) any later version; see vegetation/COPYING and vegetation/LICENSE.
  ```

- **Header-less files:** an ONF colleague of the user granted permission to use the code as Canopi wants; the repository is unmaintained, so no upstream LICENSE will appear. Record the permission (who, when, what) in `vegetation/NOTICE` and name it in `THIRD_PARTY_NOTICES.md`; ported header-less files carry the same LGPL-3.0-or-later header as the rest, citing the permission. A short written confirmation (an email the user forwards) is enough to quote.
- **GPL files:** not used.
- **SEGMA:** not used. It is out of scope and has no headers.

### 4.4 Fidelity notes for the port (OpenCV and CT behaviour to reproduce)

1. **`GaussianBlur(src, dst, Size(0,0), σ)`** on `CV_32F`:
   - kernel size `cvRound(σ·4·2+1) | 1` (the float path uses 4σ);
   - separable float kernel `exp(−x²/2σ²)` normalised;
   - border **REFLECT_101**;
   - σ in pixels = σ_m / res.
   - Summation order differs from OpenCV's SIMD path, so blurred values match to about 1e-6. Plateau detection (`filtered == dilated`) stays exact within each implementation.
2. **`dilate` 3×3 RECT:** border = −∞, so outside is ignored. `erode`: border = +∞, so outside never erodes. This matters for `ComputeGapMask` and `RemoveHighGroundPoints` at raster edges. **`morphologyEx(CLOSE)`** = dilate then erode with the same rules. The JMM disk kernel is ONF's own `createDisk`: `(x−r)² + (y−r)² ≤ r²`, `r = ksize/2`.
3. **`connectedComponents`:** 8-connectivity by default; labels in row-major first-seen order. Compare as a partition (label bijection), not by label value.
4. **Delaunay neighbours of lattice points** (maxima at pixel centres; the interpolation window): cocircular quadruples are common, and the triangulation is not unique. `wbtopology`, `spade` and `CT_DelaunayTriangulation` may pick different diagonals, so neighbour sets can differ. That changes (a) which maxima get tested by `FilterMaxima…` and (b) IDW weights in `InterpolateDEM`. Plan: use `wbtopology` and measure the mismatch against the oracle. If it exceeds tolerance, port `ct_delaunaytriangulation.cpp` (LGPL, 928 lines) for exact tie-breaking.
5. **`qFuzzyCompare` NA tests:** reproduce "near −9999 counts as NA" only in the fidelity harness. Canopi inputs use real validity masks (a NoData mask from the COG, or a sentinel that is never data).
6. **Ordering:** `FilterMaxima…` sorts maxima by height descending through a `QMultiMap<double, id>` walked backwards; for equal heights, the later-inserted comes first. Insertion order is column-major (x outer, y inner). Reproduce it: it decides who suppresses whom among equal-height apexes.
7. **σ selection:** among σ = k·step (k = 1…) up to σmax + σmax/1000, choose the **smallest** σ whose count ≤ ⌊count(σmax_last) × coef⌋ (int truncation). It need not be contiguous.
8. **JMM:** hmin runs from hmax to `min(max CHM, 60)` in bin steps (float accumulation; replicate the `f32` loop). NA cells never become canopy. Area = pixel count × res². Min and max area are inclusive.
9. **CHM:** DTM sampled at the DSM cell centre (nearest cell, no interpolation); works across resolutions.
10. **Quantiles:** R type 7, over sorted values.
11. **Polygons:** ring vertices on pixel corners. Compare geometry by symmetric-difference area (should be 0), not vertex lists (the order and start point differ).

---

### 4.5 Canopi-authored methods

Decided 2026-09-26: where ONF (or GeoLibre) has no public method, Canopi writes its own implementation of a **published** method. First case: crown segmentation (O10). Later candidates: stratum densities and height normalisation (O12).

- **Where:** the same crate, `vegetation/` (package `canopi-vegetation`, LGPL-3.0-or-later for one consistent boundary). Ported ONF code lives in `src/onf/` with ONF headers; Canopi-authored methods in `src/methods/` with a Canopi header. Both run in process as executor modules (2.1-M129).
- **Validation standard (every Canopi-authored method):**
  1. It implements a named, published method; the reference is cited in the module doc, recorded in the recipe (`method`, `reference`) and shown in the result details.
  2. The module doc is the spec: inputs and units, parameters and defaults, NA and edge handling, known limits.
  3. Synthetic analytic tests with known answers in `cargo test` (e.g. generated crowns of known position, height and radius; detection precision and recall, crown area error within stated bounds).
  4. Cross-check against an independent open implementation (lidR or lidaRtRee in R) on the IGN crop, run in a local dev lane only (never shipped, never in CI); the results are checked in as goldens with stated tolerances.
  5. A reviewed real-data sanity check on the IGN crop (overlay screenshots and summary statistics in the bead).
  6. Any change to outputs bumps the recipe version, so provenance marks old results stale.
  7. Limits are stated to users in the result details (for example "touching broadleaf crowns may merge").

## 5. Mapping onto ADR 0011 seams

This builds on the shipped registry (`common-types/src/analysis_registry.rs`, slope only, ADR 0011). The deltas are in §5.7.

### 5.1 Executor module

- One `analyses/<x>.rs` module per method dispatched by `executor(id)`; no `AnalysisLane` variant.
- Semantics:
  - global per job over the input's lattice extent;
  - in-process;
  - the runner's heavy slot on the Job lane;
  - cooperative cancel;
  - no scratch GeoTIFF: windows are read straight into memory.
- Availability on Web is its ADR 0030 row.
- Delete-don't-deprecate: the module lands with its first entry (`canopy.gaps`).

### 5.2 Item kinds (`common-types/src/library.rs`)

```rust
pub enum RasterQuantity {
    GroundElevation, SurfaceElevation, AboveGroundHeight, OtherContinuous, // importable
    Slope,                                   // existing derived
    GapDepth,                                // canopy.gap-depth: metres to canopy edge (cells × res)
    CanopyCover,                             // pointcloud.structure: %
    HeightPercentile,                        // pointcloud.structure: m (percentile in item facts)
    StratumDensity,                          // pointcloud.structure: share of returns in a layer, %
}
pub enum VectorFeature { TreeTops, Gaps, Crowns /* + Streams, Catchments, Contours from the hydrology plan */ }
pub enum LibraryItemType {
    Raster { quantity: RasterQuantity },
    Vector { feature: VectorFeature, geometry: VectorGeometry },   // Point | Polygon | Line
    PointCloud,                                                   // source-only in v2
}
```

**`PointCloud` library item:**
- An import source, stored like a raster original: `sources/<sha256>/original`, the file copied as-is (`.las`, `.laz`, `.copc.laz`).
- Import probe (`wblidar` header plus one streaming pass, with cancel):
  - format and version;
  - CRS (WKT or GeoKeys VLR);
  - `crs_class`;
  - bounds in native and WGS84;
  - point count;
  - class histogram (NbyLASClass);
  - return-number presence;
  - density (points per m² over the valid footprint at 1 m);
  - `has_ground_class` (class 2 count > 0).
- **Refused by name:** no CRS or a geographic CRS; a non-metre vertical unit, when known; zero points.
- Nothing is guessed. A missing classification is recorded, not inferred.

**Vector results (GeoJSON in WGS84; properties whitelisted and renamed):**

| Feature | Geometry | Properties |
|---|---|---|
| `TreeTops` | Point | `{id, height_m}`. `height_m` is the CHM value at the apex, or z − DTM for point-derived inputs. |
| `Gaps` | Polygon/MultiPolygon | `{id, area_m2}` |
| `Crowns` | Polygon/MultiPolygon | `{id, tree_id, top_height_m, area_m2}` |

### 5.3 Registry entries

All `group: "vegetation"`. Units are metres and m². Tool units (cells, pixel σ) are converted in Rust.

```jsonc
{ "id": "canopy.gaps", "version": 1, "group": "vegetation", "lane": { "kind": "native" },
  "inputs": [{ "key": "chm", "accepts": [{ "kind": "raster", "quantity": "above-ground-height" }],
               "requires": ["projected-metre-grid", "metre-values"] }],
  "params": [
    { "key": "gap_max_height_m", "kind": { "type": "number", "min": 0.5, "max": 60, "step": 0.5, "unit": "metre" }, "default": 10 },
    { "key": "min_area_m2",  "kind": { "type": "number", "min": 0, "max": 100000, "step": 1, "unit": "square-metre" }, "default": 25 },
    { "key": "max_area_m2",  "kind": { "type": "number", "min": 1, "max": 10000000, "step": 1, "unit": "square-metre" }, "default": 99999, "advanced": true },
    { "key": "height_distance_ratio", "kind": { "type": "number", "min": 0, "max": 10, "step": 0.1, "unit": "ratio" }, "default": 2, "advanced": true },
    { "key": "closing_step_m", "kind": { "type": "number", "min": 0.1, "max": 10, "step": 0.1, "unit": "metre" }, "default": 1, "advanced": true },
    { "key": "reconstruct", "kind": { "type": "boolean" }, "default": false, "advanced": true } ],
  "outputs": [
    { "key": "gaps", "item": { "kind": "vector", "feature": "gaps", "geometry": "polygon" }, "units": { "kind": "fixed", "unit": "" }, "optional": false, "presentable": true } ],
  "summary": ["gap_count", "gap_area_m2", "cover_ratio_pct", "cover_area_m2"] }   // ONF RasterGaps + RasterCoverRatio(h = gap_max_height_m)

{ "id": "canopy.tree-tops", "version": 1, ... "lane": { "kind": "native" },
  "inputs": [ chm as above ],
  "params": [
    { "key": "min_height_m", "number 0–60 m", "default": 2 },
    { "key": "smoothing_max_m", "number 0.05–5 m", "default": 1.0 },                 // σmax
    { "key": "smoothing_step_m", "number 0.01–1 m", "default": 0.05, "advanced": true },
    { "key": "smoothing_tolerance", "number 1–10 ratio", "default": 2.0, "advanced": true }, // Coeff Mult
    { "key": "valley_depth_m", "number 0–10 m", "default": 0.5 },
    { "key": "min_crown_radius_m", "number 0–50 m", "default": 1.5 },
    { "key": "max_crown_radius_m", "number 0.5–50 m", "default": 10 } ],
  "outputs": [
    { "key": "tree_tops", "item": { "vector": "tree-tops", "geometry": "point" }, "presentable": true },
    { "key": "smoothed_chm", "item": { "raster": "above-ground-height" }, "units": "m", "optional": true, "default_selected": false, "presentable": true } ],
  "resolved": ["smoothing_m"],                // the σ ONF chose; recorded in provenance, shown in details
  "summary": ["tree_count"] }

{ "id": "pointcloud.terrain", "version": 1, ... "lane": { "kind": "native" },
  "inputs": [{ "key": "cloud", "accepts": [{ "kind": "point-cloud" }], "requires": ["projected-metre-crs", "has-ground-class"] }],
  "params": [
    { "key": "resolution_m", "number 0.1–10 m", "default": 0.5 },
    { "key": "fill_radius_m", "number 0–50 m", "default": 5 },          // InterpolateDEM window = ceil(fill_radius/res) cells (ONF default 10 cells at 0.5 m)
    { "key": "smooth_dtm", "boolean", "default": false, "advanced": true },
    { "key": "surface_classes", "choice": ["vegetation-and-ground", "all-except-noise"], "default": "vegetation-and-ground", "advanced": true } ],
  "outputs": [
    { "key": "dtm", "item": { "raster": "ground-elevation" }, "units": "m", "optional": true, "default_selected": true, "presentable": true },
    { "key": "dsm", "item": { "raster": "surface-elevation" }, "units": "m", "optional": true, "default_selected": false, "presentable": true },
    { "key": "chm", "item": { "raster": "above-ground-height" }, "units": "m", "optional": true, "default_selected": true, "presentable": true } ] }
```

Later entries:
- `canopy.crowns` (§8 Q3): inputs `chm`; params `min_height_m`, `max_crown_radius_m` plus the tree-top params; output `crowns` (plus `tree_tops`).
- `canopy.gap-depth`: output `GapDepth` in metres, cells × res; −1 canopy becomes invalid.
- `pointcloud.structure`: cell size 1–20 m (default 5); outputs `p95` (`HeightPercentile`), `cover_pct` (`CanopyCover`, first returns > h), stratum densities for fixed syntropic layers (`StratumDensity` × 5, optional), all from normalised heights.

Registry type additions:
- `ParamUnit::Ratio`;
- `GridRequirement::{ProjectedMetreCrs, HasGroundClass}` (point-cloud facts);
- `AnalysisDefinition.resolved` and `.summary` (keys with i18n labels).

### 5.4 Provenance and freshness

- `ToolProvenance { engine: "onf", version: env!("CARGO_PKG_VERSION") of canopi-vegetation, revision: "229ae44d…" (ONF upstream pin), tools: ["ComputeGapsJMM", "RasterGaps", "RasterCoverRatio"] }`. The upstream step names are the tools that actually ran.
- The Canopi build commit is already implied by the app version.
- New `Provenance.resolved: Vec<AnalysisParamValue>`, for example `smoothing_m = 0.35`.
- Freshness:
  - a recipe bump (a deviation change or a port fix) gives `RecipeUpdated`;
  - a new ONF pin gives `ToolUpdated`, a soft reason;
  - chains (`pointcloud.terrain` → `canopy.tree-tops` on its CHM) use `InputUpdated` and `InputStale`, exactly as the registry plan specifies.
- Summary facts are stored per derived generation: `summary_json` `[{key, value, unit}]`, computed inside the job and shown in details.

### 5.5 Admission (safety limits, not performance claims)

- **Raster analyses (`native`):**
  - `MAX_NATIVE_ANALYSIS_CELLS = 25_000_000` on the input lattice extent (the same number as the proposed GeoLibre global cap). That is 6.25 km² at 0.5 m, enough for a farm.
  - Peak memory estimate charged at admission:
    - gaps: f32 in + u8 mask ×3 + i32 labels ≈ 15 B/cell;
    - tree tops: f32 ×3 + u8 + i32 ≈ 17 B/cell, sequential over σ.
  - At the cap that is under about 450 MB.
  - Over the cap: the offer says `ExtentTooLarge {cells, limit}` before the user runs anything.
- **`pointcloud.terrain`:**
  - Streaming. Memory is 2–3 `Grid<f32>` of the output lattice, charged against the same cell cap at `resolution_m`, plus the interpolation window.
  - Points are never held.
  - Point count is bounded only by the existing 2 GiB/file import cap (time). A LAS/LAZ pass is sequential; COPC is read node by node.
- **`pointcloud.structure` (later):** needs per-cell height lists. Either sort by cell stripe (two passes, bounded stripe buffer) or cap at `MAX_STRUCTURE_POINTS = 60_000_000` (heights f32 + cell u32 ≈ 480 MB). Decide in that bead.
- Free-space checks as today, with a 256 MiB floor. Vector outputs are capped at 64 MiB and 200 000 features (registry plan). Over that cap, refuse by name: "raise the minimum gap area" or "raise the minimum height".
- **Tiling across items larger than the cap:**
  - Not in v1. σ optimisation is global, so tiling changes results.
  - Later: halo = max(4·σmax, 2·max radius, JMM closing radius) with centroid ownership.

### 5.6 Display in Layers and on the map

- Rasters (DTM, DSM, CHM, smoothed CHM, gap depth, structure) use the existing display COG path. Styles through the `item-types.ts` table:
  - DTM and DSM: `schwarzwald`;
  - CHM: `greens` (canvas v2 plan, U47);
  - gap depth: sequential light ramp over `[0, max]` m;
  - cover %: fixed 0–100;
  - stratum density: fixed 0–100 %.
- Vectors use the registry plan's `maplibre/vector-results/adapter.ts` (one owner per live map, lidar band):
  - **Tree tops:** a circle marker whose radius scales with `height_m` (zoom-interpolated), plus a label at high zoom ("14.2 m").
  - **Gaps:** a light fill with outline.
  - **Crowns:** an outline with a very soft fill.
  - All colours come from theme tokens: a map-data palette, following the "no green chrome" rule, which concerns chrome, not data.
- Inspection uses `queryRenderedFeatures`: "Tree top, 14.2 m", "Gap, 312 m²", "Crown, 38 m², top 12.1 m".
- Details show:
  - the summary facts (trees found, gap count and area, cover %);
  - provenance ("ONF method, PluginONF 229ae44, σ retained 0.35 m");
  - a caveat: "estimates from canopy height; trees under the canopy are not detected".
- Point-cloud items: in the library only (row, details with class histogram and density, **Analyze**). v2 does not render points or add them to a Design. Optionally, later, a footprint outline (§8 Q5).
- The library filter gains "Vegetation", and derived rows nest under their input (registry plan).

### 5.7 Deltas to the shipped registry (`common-types/src/analysis_registry.rs`, slope only)

1. No lane variant: `AnalysisLane` is deleted (2.1-M129); each method is an executor module dispatched by `executor(id)`.
2. `AnalysisGroup` gains `Vegetation`.
3. `LibraryItemType` gains `Vector{…}` (shared with contours and hydrology) and `PointCloud`.
   - The catalogue check `item_kind IN ('raster')` becomes `('raster','point-cloud')` for sources.
   - `lidar_derived_items.item_kind` keeps `('raster','vector')`.
   - Source tables gain point-cloud facts: `point_count`, `class_histogram_json`, `density`, `has_ground`.
   - The catalogue version at that time is bumped if it has already shipped; otherwise the change folds into it (a shipped version takes a frozen catalogue step, ADR 0026).
4. `Provenance` gains `resolved`. Generations gain `summary_json`. The definition schema gains `resolved` and `summary` keys. bindings-gen renders them, with an i18n key check.
5. `GridRequirement` gains point-cloud requirements. The offer builder computes them from import facts, never from filenames.
6. Executors: add `analyses/native.rs` (the generic "read input grid → call `canopi_vegetation` → stage outputs") and `analyses/vegetation.rs` (the recipes). The one-to-one registry↔executor test covers them.
7. Global materialisation: the in-process lane reads windows into memory. The global-lane "scratch GeoTIFF + CLI" path stays GeoLibre-only.
8. Vector canonicalisation:
   - input coordinates are **projected** (the ONF output is in the input CRS);
   - the canonicaliser reprojects to WGS84 through `rust_engine/crs.rs`, the one CRS authority, and checks against the item's bounds;
   - a LAS/LAZ CRS resolves to a table row by its horizontal code (compound 7415 reads as 28992, 5698/5699 as 2154); WKT reading is built with the LAZ reader, and anything else is refused by name.
9. Guides:
    - `docs/guides/data-library.md`: point-cloud import, the vegetation analyses, deviations, the admission constants, the `onf` crate, gates.
    - `docs/guides/native-and-release.md`: none of the commands change, but the new `Local` jobs are listed.
    - `AGENTS.md` quality gates: an "ONF port" row.

---

## 6. Validation

### 6.1 Oracles

- **Oracle A (authoritative): Computree 6.2.1 `CompuTreeBatch` with the real `libplug_onf.so`** (`/tmp/ctbin`).
  - Headless: `QT_QPA_PLATFORM=offscreen ./CompuTreeBatch.sh --nosystray --nologs <script.xsct2>`. On this machine it needs the missing system Qt6 libraries (`libQt6Concurrent`, as the spike found).
  - The exit code is meaningless: success = the expected files exist and parse.
- **Scripts:** author once in `CompuTreeGui`. This needs a desktop session: the user, or an agent through computer use. Commit them as templates, with a substitution map by XML `id` (input `Filepath`, output directory, numeric params):
  - `P1-terrain.xsct2`: LAS/LAZ reader → `PB` filter (class 2) → `ONF_StepComputeDTM` → `ONF_StepInterpolateDEM` → reader (all classes) → `ONF_StepComputeDSM` (`convertNA` off) → `ONF_StepComputeCHM` → GDAL raster exporter (GeoTIFF).
  - `P2-tops.xsct2`: GDAL raster reader (CHM) → `OptimizeGaussianOnMaximaNumber` → `FilterMaximaByNeighbourhood02` → `CreateMaximaCloud` → ASCII/LAS exporter, plus export of the maxima label raster.
  - `P3-gaps.xsct2`: CHM → `ComputeGapsJMM` (ratio 2, then ratio 0, reconstruct on/off variants) → GeoTIFF label export → `ConvertRasterToVector` → GDAL vector exporter.
  - `P4-gapmask.xsct2`: CHM → `ComputeGapMask` → GeoTIFF.
- **Timebox:** 2 days. Exact version: `libplug_onf.so` has no commit stamp. Record the binary's SHA-256 and compare it with source `229ae44`. If the oracle disagrees with a source reading, bisect the ONF history around the 6.2.1 release date.
- **Oracle B (fallback, dev-only, never shipped or committed to Canopi):** a C++ harness in a scratch repo.
  - It copies the step `compute()` bodies verbatim.
  - It adds a ~200-line `CT_Image2D` shim over `cv::Mat` and links the core `ct_delaunaytriangulation` and interpolator sources (LGPL).
  - It builds with the system OpenCV (`apt install libopencv-dev`).
  - It gives exact per-step goldens when scripting stalls, and isolates Delaunay tie effects: one run with the CT Delaunay, one with `wbtopology`.
- **Oracle C (method sanity, not fidelity):** R `lidaRtRee::gap_detection` on the same CHM (the JMM method's origin) and `lidR::locate_trees(lmf)` for tops, to catch a shared misunderstanding. Used locally only (GPL R code, never shipped).

### 6.2 Fixtures

1. **Synthetic (CI, generated in Rust tests, no files):**
   - a 100 × 100 m stand in EPSG:2154 with N paraboloid crowns at known positions and heights;
   - two-apex broadleaf crowns (to test the valley-depth merge);
   - rectangular and L-shaped gaps of known area;
   - a sloped ground plane;
   - holes in the ground class under dense crowns (to test interpolation);
   - high noise points;
   - NoData patches (deviation tests).
2. **Tiny real crop (checked in, if §8 Q8 agrees):**
   - IGN LiDAR HD classified COPC, a 100 × 100 m subset of a mixed broadleaf or agroforestry parcel: about 100–250k points, LAZ 1–2 MB;
   - the matching IGN MNH 0.5 m crop: 200 × 200 cells, about 160 KB Float32.
   - Licence: **Licence Ouverte Etalab 2.0** (attribution "IGN – LiDAR HD", tile name and date; redistribution allowed).
   - Record the tile id, bbox and SHA-256 in a manifest (`testdata/onf/manifest.json`).
3. **Goldens (checked in, small):**
   - Oracle A outputs for fixture 2 and a few synthetic cases: GeoTIFF grids (DTM, DSM, CHM, gap labels, gap mask, maxima labels), tree tops as CSV, gap polygons as GeoJSON;
   - plus the scripts' parameter sets;
   - a manifest naming the oracle version, binary SHA-256 and script.
   - Total under about 3 MB.
4. **Local real-fixture lane (not checked in),** as with the existing e2e lanes:
   - `CANOPI_ONF_E2E_COPC=<IGN 1 km² tile>` plus `CANOPI_LIDAR_MNH_DIR`;
   - runs the whole chain, import → terrain → tops/gaps → display;
   - reports the tile and hash. A run without fixtures is not a pass.

### 6.3 Acceptance metrics (fidelity vs Oracle A on NA-free inputs)

| Output | Metric | Threshold |
|---|---|---|
| DTM/DSM Zmin/Zmax, CHM | Same lattice (origin, dims, res); NA mask identical; per-cell equality | Exact (f32 bitwise for Zmin/Zmax; CHM ≤ 1e-5 m) |
| Interpolated DTM cells | abs diff | ≤ 1e-3 m for ≥ 99.9 % of filled cells; residual explained by Delaunay ties (checked with Oracle B using the CT Delaunay) |
| Gap labels (JMM, GapMask) | Partition equality (label bijection), per-gap area | Exact for the plain threshold; ≥ 99.9 % of cells for ratio > 0; gap count equal |
| Gap polygons | Symmetric difference with oracle polygons; validity | Area 0 (pixel-edge); every Canopi polygon valid (by design; oracle may be invalid) |
| Maxima before filtering (retained-σ, fixed version) | Label partition | Exact on the blurred grid computed by both (σ equal) |
| Retained σ | Equality | Exact |
| Filtered tree tops | Nearest-neighbour matching within 0.5 cell; precision and recall vs oracle; height diff | ≥ 99 % both, heights ≤ 1e-3 m; mismatches listed with a Delaunay-tie diagnosis |
| Summary facts | Equality | Exact counts; areas ≤ 1e-6 relative |

**Method sanity (not gated):**
- gaps IoU vs lidaRtRee ≥ 0.95;
- on synthetic stands, tops recall ≥ 95 % within 1.5 m and false tops ≤ 5 %.
- Report both in the bead.
- No performance gate (project memory: architecture before performance).

**Tests:**
- Pure `canopi-vegetation` tests (goldens, synthetic, deviation tests) run in the ordinary `cargo test --workspace`. No engine and no ignored lane.
- Registry, job and catalogue tests live in `desktop/` as usual.
- The real-tile lane is `#[ignore]` and local.

---

## 7. Beads

Proposed parent: rewrite `canopi-5ys2.2` as the epic "Canopy analysis: ONF methods (native Rust port)". h90p.9 (registry seams) must land first. Sizes are relative (S, M, L), not calendar time: the plant finder slice (five panels, 11 locales) counted as L and took well under an hour of agent time plus review.

| # | Title | Scope | Depends on | Gates | Size |
|---|---|---|---|---|---|
| O1 | Record ONF's permission | Put the colleague's written permission (a forwarded email or a signed line) in `vegetation/NOTICE`; notices wording. **User forwards it.** | — | none | S |
| O2 | ADR 0012 and doc rewiring | ADR 0012 (native ONF lane, LGPL crate boundary, GeoLibre kept for terrain and hydrology, Computree integration dropped); ADR 0011 line edits; architecture reuse table; bead 5ys2.2 text | user decisions Q2/Q3 | `python3 scripts/check_docs.py` | S |
| O3 | Oracle and fixtures | Qt libs, headless `CompuTreeBatch`; Canopi-written P1–P4 `.xsct2` templates (no ONF scripts exist), falling back to the dev-only Oracle B shim harness; lidR/lidaRtRee cross-check scripts; IGN crop selection; goldens and manifest. Local only. | — | none in Canopi (artifacts reviewed) | M |
| O4 | `canopi-vegetation` crate foundation | Workspace member (LGPL); `Grid<T>` with CT semantics; `morph.rs` (Gaussian, dilate, erode, close, 8-connected labels with OpenCV border rules); `polygonize.rs` (valid pixel-edge polygons); cancel token; licence texts, headers and `vegetation/NOTICE`; `ONF_REVISION` const; notices and notices test | O2 | Rust gates + frontend notices test, docs | M |
| O5 | Registry deltas for vegetation | On top of h90p.9: `Native` lane, `Vegetation` group, vector item kinds shared with contours, `resolved` and `summary` in registry, provenance and generations, `ParamUnit::Ratio`, i18n keys ×11, executor stub and 1:1 test | h90p.9 bead 1, registry-plan bead 3 (vector items and adapter) or its vector part pulled forward | Rust, native policy, shared contracts, frontend + coverage, check:ui + builds, docs | M |
| O6 | `canopy.gaps@1` | JMM port + RasterGaps/CoverRatio facts + polygons + recipe + styles + inspection + details; fidelity tests vs goldens; lidaRtRee sanity report | O3, O4, O5 | full set | M |
| O7 | `canopy.tree-tops@1` | Maxima port (σ optimisation, fixed labels, valley-depth filter, apex points); Delaunay via `wbtopology` with a tie analysis (port the CT Delaunay only if needed, +1.5 d); marker style | O6 | full set | L |
| O8 | Point-cloud library items | Import of LAS/LAZ/COPC through `wblidar` (probe, class histogram, density, CRS refusal, admission, content-addressed original), catalogue kind and facts, Data Library rows and details, offers (`HasGroundClass`), restart recovery, e2e lane scaffold | O5 | full set + native policy | L |
| O9 | `pointcloud.terrain@1` | Streaming DTM/DSM, InterpolateDEM (IDW over Delaunay neighbours), optional SmoothDEM, CHM; class selection per FilterByReturnType; outputs feed slope and canopy (chains, `InputStale`); fidelity vs P1 goldens | O4, O8 | full set + local e2e lane | L |
| O10 | `canopy.crowns@1` | Per the Q3 decision and §4.5: a Canopi-authored seeded priority-flood watershed from the literature (in `src/methods/`, validated against lidR) + ONF FilterWatershedByRadius + min height + polygons + crown summary | O7, Q3 | full set | M |
| O11 | `canopy.gap-depth@1` | GapMask port → `GapDepth` raster in metres | O6 | full set | S |
| O12 | `pointcloud.structure@1` | Clean-room height normalisation (NA-safe); Quantiles (P95), first-return CoverRatio, syntropic stratum densities (RDM idea) as grids; admission for point lists | O9 | full set | L |
| O13 | Point cleaning options (terrain recipe v2) | `RemoveUpperNoiseV2`/`FilterRemoveUpperOutliers` and `RemoveHighGroundPoints` as advanced options; recipe bump | O9 | full set | M |
| F1 | Follow-up (product) | "Use detected trees as existing trees in the Design" (tree tops → design objects through a runtime transaction; ADR 0007 or 0011 question) | O7 | — | not estimated |
| F2 | Follow-up | Tiling beyond the cell cap (halo and ownership rules), TIN DTM, vertical profiles, TLS stem epic | — | — | not estimated |

- **Order:** O1 and O3 in parallel now (no code). Then O2 → O4 → O5 → O6 → O7 (raster canopy first; it needs no point cloud) → O8 → O9 → O11 → O10 → O12 → O13.
- **Longest chain:** registry → O4 → O5 → O6 → O7 → O10; the point-cloud chain (O8 → O9 → O12) runs beside it.
- **Gate note:** O4 onward adds no engine to CI. The `lidar-native` lane is untouched except where the terrain DTM feeds GeoLibre slope in an e2e test.

---

## 8. Decisions (2026-09-26)

The user answered Q4 and adopted the recommendations for the rest.

1. **Licence:** an ONF colleague of the user granted use of the code as Canopi wants; the repository is unmaintained. O1 records that permission in `vegetation/NOTICE`: a written confirmation if one can be had, otherwise the user's dated statement.
2. **ADR 0012:** accepted. In-process `native` lane, the `canopi-vegetation` LGPL crate, GeoLibre kept for slope, hillshade, contours and hydrology, the optional Computree integration dropped.
3. **Crowns:** no crowns in the first canopy release (gaps, tree tops, cover). Then a Canopi-authored seeded watershed from the literature plus ONF's radius filter (O10), under §4.5. The user has no access to `onfdev`.
4. **Correctness over fidelity:** fix the bugs (the five deviations in §4.2), documented in the crate and guide.
5. **Point clouds:** library-only items plus a footprint outline in Layers.
6. **Defaults:** ONF defaults plus "Forest" and "Orchard / agroforestry" presets over the same recipe.
7. **Detected trees → Design:** yes, later, as F1 (tree tops become locked "existing tree" objects through a runtime transaction).
8. **Fixtures:** check in the ~2 MB IGN crop and ~1 MB goldens (Etalab 2.0).
9. **Oracles:** Canopi authors them (no ONF scripts are available): hand-written `.xsct2` templates for `CompuTreeBatch`, falling back to the dev-only C++ shim harness (Oracle B); plus lidR/lidaRtRee cross-checks.
10. **Caps:** 25 M cells, as for hydrology; point-list caps set in O12.
11. **Terrestrial scans:** never, until someone asks.

---

## 9. Sources

- ct_pluginonf: https://gitlab.com/computree/ct_pluginonf (commit `229ae44d`), files cited by path above; `Steps_PluginONF.xlsx` (v6 migration status), `onf_steppluginmanager.cpp` (registration).
- Computree core: https://gitlab.com/computree/computree_v6 (`047b208b`, LGPL-3.0 `LICENSE`): `library/ctlibstructureaddon/ct_itemdrawable/{ct_image2d.hpp, abstract/ct_abstractimage2d.{h,cpp}, tools/image2dtools/ct_image2dnaturalneighboursinterpolator.cpp}`, `ct_math/delaunay2d/*`, `ctlibmath` `CT_MathStatistics::computeQuantile`.
- Computree 6.2.1 Linux binary: `/tmp/ctbin/computree-6.2.1-Linux/opt/computree` (`libplug_onf.so`, closed `libplug_onfdev.so`).
- Whitebox crates at the pinned rev: `~/.cargo/git/checkouts/whitebox-wasm-*/9c0ff4f/crates/{wblidar, wbtopology, wbprojection}` (MIT OR Apache-2.0); crates.io `las` 0.11.1 (MIT), `laz` 0.13.0 (Apache-2.0), `copc-rs` 0.5.0 (MIT/Apache-2.0), `spade` 2.15.1 (MIT/Apache-2.0).
- IGN LiDAR HD licence and classes: [data.gouv.fr – Nuages de points LiDAR HD](https://www.data.gouv.fr/datasets/nuages-de-points-lidar-hd), [cartes.gouv.fr – Nuages de points LiDAR HD](https://cartes.gouv.fr/aide/fr/partenaires/ign/observations-regulieres-territoire/relief/nuages-points-lidar-hd/), [IGN product sheet](https://geoservices.ign.fr/sites/default/files/2024-11/Fiche_produit_Nuages-de-points-LiDAR.pdf), [LiDAR HD derived models (cartes.gouv.fr)](https://cartes.gouv.fr/aide/fr/partenaires/ign/generalites-ign/actualites/2025-03-lidarhd-et-produits-derives/).
- Method references named in the code: Monnet (lidaRtRee gap detection); D'Oliveira et al. 2012 (RDM); Bouvier et al. 2015 (LAD); Schütz 1989 (competition index).
