# Extension points and exports

Status: Accepted (2026-10-16, Canopi 2.1 target; built by the 2.1 foundation phases); amended 2026-10-17 (Q43, Q44, Q46 catalog search, the search prototype, Q45 pass; ledger 2.1-Q48 to 2.1-Q52, 2.1-Q55, 2.1-Q57 to 2.1-Q59, 2.1-Q65, 2.1-Q100, 2.1-Q109, 2.1-Q112 to 2.1-Q114, 2.1-Q122, 2.1-E1) and 2026-10-20 (hydrology on Web up to the limit, 2.1-Q175)

## Context

The roadmap adds analyses (shade, wind, cut and fill; aspect and frost in 2.1), hydrology, crown detection, point-cloud reading and story export. Canopi has no plugin system and will not get one. ADR 0005 allowed only `.canopi`, Canvas PDF and GeoJSON, yet Web ships a budget CSV. Plant search is written three times with no shared test, and today's order opens about 20 of 54 prototype queries on an unexpected species. The user named four extension points (2.1-Q12), where results live (2.1-Q11), one owner for catalog search (2.1-Q43, 2.1-Q44, 2.1-Q46) and its ranking (2.1-Q48 to 2.1-Q52).

## Decision

- **Four extension points, each one module plus one row:** an analysis (`analyses/<x>.rs` dispatched by the one `executor(id)` map, a registry row naming its output quantity, sentinels and any named presets, and its quantity's row in the quantity table when the quantity is new (the descriptor's scale and quantity columns derive from it and the recipe); L1); an importer (`import/formats/<x>`, listed in code with its formats; L3); a layer source (a workspace map contribution with `ownsResource`; L13); an export format (a FileDelivery row; L12). Only analyses and exports have data registries.
  - Named presets (ADR 0012's Forest and Orchard / agroforestry) belong to the analysis row as named sets of values over its parameters, resolved and checked by the same registry resolve as defaults, added with the first analysis that needs one; never frontend default sets or a separate table (2.1-M128).
- **Exports are the FileDelivery rows:** `.canopi`, Canvas PDF, GeoJSON, budget CSV, library results as GeoTIFF and GeoJSON with their provenance (2.1-Q100), and story export when built. A row reads its kind from one file-kind table that also feeds the pickers; the port alone sanitises the stem and supplies the fallback name. FileDelivery is one port, `platform/file-delivery.ts` `deliver(row, signal)` over bytes, text or a native source (contracts §16); a GeoTIFF result carries its provenance in a TIFF tag.
- **One file-access rule.** A native dialog returns an opaque grant (id, display name, kind) held in `canopi-desktop`; reads and writes take the grant, never a path; stored entries keep their paths native-side behind an id. File access only picks; resolving a library item for display belongs to the Data library port (2.1-M132).
- **Results are library items only** (2.1-Q11). A `.canopi` keeps only their presentation entries; "Use as a swale" makes ordinary objects with no link back. Bring-your-own results record free-form provenance (2.1-Q32) and accept rasters and vectors; the vector kind lands in 2.1 for them, and hydrology's vector outputs reuse it (2.1-Q100). A derived result's name is fixed in the language used at calculation and editable (2.1-Q98).
- **The quantity table owns display** (`canopi-types`): unit family, scale (linear, log or circular), ramps with the default first (no blue outside water), default range, whether relief draws, importable, and the display units and precision per unit system (ADR 0022 L24). An analysis row owns only its sentinels. `RASTER_QUANTITIES` is deleted. Aspect is the circular quantity, a colour wheel without blue (2.1-Q31).
- **One shaded relief.** Relief is the only shaded relief (the separate Hillshade result is dropped, 2.1-Q58), and every shaded relief, map terrain included, is lit from the north-west fixed to the map, so it turns with the map (2.1-Q57).
- **Every analysis row carries a golden fixture** with its provenance named: the GDAL oracle where GDAL computes the same thing, otherwise an analytic fixture or a second tool. No GDAL ships (ADR 0014).
- **Web parity** (ADR 0030). The Web root installs the same terrain contribution as Desktop. From Phase 3 N5 (2.1-Q122), Web imports Site data up to a measured size limit into browser file storage, with display, pin, Profile and the terrain analyses run by the same Rust catalogue, runner and engines in a library worker (2.1-M151); over the limit stays Desktop (2.1-Q114); hydrology runs on Web up to the measured Web whole-grid limit (2.1-Q175, 2.1-M166). Stamps exist on both editions (2.1-Q112). Deleted on Web (Q24): Design Templates, the World map (2.1-E5) and the analyses `web` branch.
- **Catalog search has one owner** (2.1-Q43). The catalog build writes the search keys, the display name per locale, the browse score, the attribution fields and the closed filter value lists into both outputs, derived from catalog data without changing it; readers never compute a key or pick a display name. The Web catalog carries every field, filter, photo and fact, read on demand by range requests (2.1-Q113).
  - Closed values show the interface glossary word from the locale files (2.1-Q55); the habit filter offers Desktop's four values on both editions (2.1-Q59); photos are one fixed-width Commons rendition on both (2.1-Q109).
- **Match** (2.1-Q44, 2.1-Q51): every query token starts a word of one name entry (scientific, common in every locale, synonym), accent-, case- and kana-insensitive through `canopi-search-text`. CJK names also match inside the name; German and Dutch compound parts match below whole words; a typo fallback runs only when nothing matches and says "Showing results for …". Every finder uses the one match rule and key set.
- **One ranking contract** (2.1-Q46, 2.1-Q49, 2.1-Q50), data beside the normalisation contract, for best results first: the match tier (exact, then whole words before partial word starts, scientific exact and starts-with in the top tiers), then better-known plants first (the build-derived count of languages naming the species), then position and length; BM25 is dropped.
  - The text tier (uses, family, description) is last on both editions. No outside popularity column (2.1-Q52). The SQLite and DuckDB queries are generated as static, parameter-bound text; the Web ranker and the fake's tiers are deleted; a row returns the entry that matched.
- **Ranking is a user contract** (2.1-Q44, 2.1-Q48). The corpus holds the best result first per query and locale, seeded from today's Desktop with wrong-first rows corrected to what the user expects, reviewed by the user once; a later change names the user's dated decision. It gates both readers.
- **One catalog engine, if it holds** (2.1-E1). At Phase 3's start, beside the N0 engine decision and before N2 shapes crates, the canopi-ubkj spike runs the Web DuckDB-WASM reader inside the Desktop webview against the ranking corpus. Outcome A (it holds): one catalog reader in `desktop/web/src/catalog/` serves both editions, ADR 0006 is replaced and `canopi-catalog` is not created. Outcome B: `platform/species-reader.ts` stays a port over two readers. In both, species user lists are their own port and search never depends on the user DB.

## Alternatives rejected

- **A data registry for all four points.** Two would be registries with few members and no gain.
- **Embed result GeoJSON in the `.canopi`.** It copies library data into every Design.
- **A parity suite over two hand-written rankers.** It tests the copy instead of removing it.
- **Readers deriving keys and display names at query time.** That is how Web shows another common name today.
- **Today's Desktop order as the contract.** It opens about 20 of 54 queries on an unexpected species.

## Consequences

- Adding an analysis touches its module, its row, its quantity row when the quantity is new, and its golden fixture. A scheduled CI lane with GDAL and the GeoLibre CLI refreshes the oracle goldens on a cached open-data fixture set.

## Checks

- `analysis_registry_generated.rs` drift test (exists); `analysis_row_has_golden_fixture` and `every_output_quantity_has_a_row` (to be created by Phase 3), fail-closed; `every_output_quantity_has_a_row` also requires a scale; a drift test fails if `bindings-gen` declares its own registry shape.
- `file-delivery-rows` (to be created by Phase 2a); `no_design_field_holds_library_results` (Phase 2b, ADR 0026); the Web build boundary check (exists).
- The ranking corpus on the native catalog commands and the DuckDB reader, a generated-query drift test and a check that each top result's marks fall on the entry that matched (to be created by Phase 3 N4); ast-grep `no-formatted-sql` is ADR 0023's Phase 0 ratchet, 0 by N4.
- A Web e2e in Chromium, WebKit and Firefox (Phases 2c and 2d): contours and Relief draw from the shared terrain contribution, lit fixed to the map, and labels show common names.
