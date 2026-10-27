# Species catalog

Covers: `desktop/src/db/`, `desktop/src/services/species_catalog.rs`, `desktop/src/services/species_catalog_read/`, `desktop/src/services/plant_browser.rs`, `desktop/web/src/app/plant-browser/`, `desktop/web/src/app/plant-detail/`, `desktop/web/src/app/plant-finder/`, `scripts/species_catalog_contract.py`, `scripts/generate-web-catalog.py`, `scripts/prepare-db.py`

## Purpose

Boundaries of the plant catalog: storage contract, Desktop SQLite plant DB, search and browse, translations, Web Parquet/DuckDB-WASM artifact, Desktop user DB. Storage decision: [ADR 0006](../adr/0006-species-catalog-storage.md). Workbench rules: [frontend](frontend.md#rules). DB publication: [native and release](native-and-release.md#bundled-plant-db).

## Authorities and boundaries

- `scripts/schema-contract.json` is the single authored source for the schema versions, the normalization pin, the source-export SHA-256 (`prepared_artifact.source_export_sha256`), Species columns, generated tables and FTS shapes, indexes, translation gap fills and the reduced Web projection. `scripts/species_catalog_contract.py` compiles it, cross-validates `plant-filter-fields.json` and writes `desktop/src/db/schema_contract_generated.rs`.
- `common-types/species-search-normalization.json` is the cross-runtime search normalization authority (Unicode facts: `species-search-unicode-15.json`). Python, Rust and TypeScript each implement it and pass the same corpus.
- `common-types/web-species-catalog-artifact.json` is the Web artifact authority: row schema, locale set, Parquet layout, supported filters, excluded detail fields and the 25 MiB asset limit. `scripts/generate-web-catalog.py` derives rows; `desktop/web/src/generated/web-catalog-artifact.mjs` admits manifests.
- `common-types/plant-filter-fields.json` owns filterable fields; `npm run gen:types` generates the Rust and TypeScript filter catalogs. Web gets a filter only when the artifact contract adds it.
- Shared UI consumes the Species Catalog Workbench (`app/plant-browser/workbench.ts`, IPC-free); `#species-catalog-live` selects `live.desktop.ts` (SQLite over IPC) or `live.browser.ts` (DuckDB-WASM).
- Lists, canvas labels, detail titles and the PDF key read one projection, `resolveDisplayNames(names, locale)`: the language's names, English marked "(en)" for the rest, cached per species and language over `resolveCommonNames`; `resolveHabits(names)` sits beside it. `live.desktop.ts` batches 500 names per native call and, with the plant DB missing or corrupt, lets nothing cross IPC (`species-catalog-view-lifecycle.test.ts`, `species-catalog-live-desktop.test.ts`).
- Rust seams: `desktop/src/db/plant_catalog_connection.rs` admits the prepared identity; readers get only the sealed `PlantDbConnectionGuard` (`db/mod.rs`); `db/query_builder/` builds SQL; `services/species_catalog_read/` owns caller projections, which other services call.
- The Desktop user DB (`desktop/src/db/user_db.rs`, `user_db_schema.sql`) is separate from the plant DB: settings, favorites, recently viewed, Recent Designs, Design Notebook, Saved Object Stamps. Its work runs in the executor's `UserData` class, catalog reads in `Catalog`; never hold both locks at once.

## Rules

- A prepared DB is admitted only when `PRAGMA user_version` and the four identity values in `species_search_metadata` match exactly; otherwise `PlantDb` is `Corrupt` and species services are unavailable, with no warning-only path (`db/mod.rs` tests).
- FTS column order, tokenizer options and full B-tree indexes are semantic facts checked by shape, never by name only. Keep `idx_species_id`: search hydration joins ranked ids back through it (`species_catalog_contract.py check`).
- Normalization semantics change only by bumping the authority version and the storage and Web pins; all three runtimes pass the corpus (tests in the Where to look table).
- Search admission counts normalized characters: none browses, fewer than 2 stays local as too short, otherwise an active search runs with `include_total=false`; only browse asks for counts. Paginate with `next_cursor`, never `total_estimate` (`app/plant-browser/search-session.ts`, `services/species_catalog_read/search.rs`).
- Ranking with search text: exact displayed Common Name, prefix, contains all tokens, selected-language alternate names, then `bm25(species_search_fts, 8, 10, 5, 1, 1)`; English never stands in for another selected language; clearing the text returns the chosen browse order (`db/query_builder.rs` tests).
- Browse orders (`Sort` in `common-types/src/species.rs`: Recommended, Name, Height, Edibility; `Relevance` only with search text) page as keyset phases, each with an indexed predicate and a numeric key or the Canonical Name, unioned one `LIMIT`ed subquery per phase in a `MATERIALIZED` CTE, so every page is an index walk. A cursor that does not fit the order restarts the browse (`browse_sorts_build_one_index_ordered_subquery_per_phase`, `cursors_that_do_not_fit_the_sort_restart_the_browse` in `db/query_builder.rs`).
- Never order a browse by an expression over the whole table or page with `OR … IS NULL` cursors: both fall back to a full sort. The guard tests check the SQL text; nothing inspects the query plan (advice).
- Recommended puts rated species first (edibility, other uses, medicinal), then unrated species with a Common Name in the interface language, then the rest, each in scientific-name order (`RECOMMENDED_PHASES`, `db/query_builder/pagination.rs`). Web offers Recommended (named first) and Name only.
- SQL uses `SqlBuilder` placeholders, never formatted strings; count and list share one planner path (advice).
- Desktop search runs in the executor's `Catalog` class with generation checks and interrupt-based supersession; `supersede_species_search` is a reviewed synchronous command (`native_command_policy.rs`); only the search that owns the connection is interruptible.
- Translations: `translated_values` has one column per language and `translate_value()` maps a locale through an allowlist; contract gap fills must match DB values exactly, including case. Common Name lookup: selected-language `best_common_names`, then `species_common_names`, then `species.common_name` for English only; `display_order` is the rank (advice).
- Web: `web/duckdb-wasm-catalog.ts` loads DuckDB through `selectBundle(getJsDelivrBundles())`, never a bundled `duckdb-*.wasm`; a failed open rolls back and is retryable; failures surface as workbench error state with Retry, never an empty catalog (`duckdb-wasm-catalog.test.ts`, `web-species-catalog-runtime.test.ts`). Startup and packaging reject a stale manifest (`web-catalog-artifact-contract.test.ts`, `web-edition-packaging.test.ts`).
- The Web build places the generated catalog (`desktop/web/catalog-input/`) under `assets/catalog/<first 16 hex of its manifest's SHA-256>/` and gives the bundle that path; development serves the same layout with byte ranges (`web-build-configuration.test.ts`, 2.1-M176).
- Web detail shows only the hero image, names, climate zone, habit and life cycle (`web-species-catalog-panel.test.tsx`).
- User DB: only the current schema (`CURRENT_USER_DB_VERSION`) opens; there are no migrations (ADR 0021). A database from before 2.0 (an older schema, or tables without a version) is renamed `<file>.before-2.0-<unix-seconds>` with its journal files and replaced by an empty one, and the start reports `SubsystemHealth.local_data` once; a newer schema is refused untouched; a damaged file is renamed `<file>.corrupt-<unix-seconds>`. No rename overwrites an earlier one. (`db/user_db.rs`, `db/mod.rs`, `lib.rs` tests)
- Images: Desktop caches through `desktop/src/image_cache.rs` (500 MB cap, single-flight); Web loads one hero image (`image_cache.rs` tests).

## Do not

- Do not hand-edit `schema_contract_generated.rs`, generated filter catalogs or Parquet shards, or add a parallel locale list (locale columns derive from the supporting-table shape).
- Do not hard-code filter rows, chips or Web filters.
- Do not revive Site Adaptation.
- Do not commit `desktop/web/catalog-input/` or `desktop/resources/canopi-core.db`, regenerate the DB while the Tauri app runs, or suggest changing catalog data (the user decides; see Open decisions).

## Commands

```bash
python3 scripts/species_catalog_contract.py check  # contracts + committed Rust facts
python3 scripts/species_catalog_contract.py emit-rust --write  # refresh Rust facts after a contract change
python3 scripts/species_search_unicode_facts.py check  # pinned Unicode facts (write: refresh)
python3 scripts/prepare-db.py --export-path <pinned-export>.db # builds desktop/resources/canopi-core.db
python3 -m unittest scripts.test_species_search_normalization scripts.test_species_catalog_contract scripts.test_prepare_db scripts.test_web_catalog_artifact_contract scripts.test_generate_web_catalog
cd desktop/web && npm run gen:types && npm run check:types
cd desktop/web && npm run generate:web-catalog && npm run check:web-catalog-artifact
cargo test -p canopi-desktop bundled_species_search_latency_harness -- --ignored --nocapture  # CANOPI_PLANT_DB_PATH or bundled DB
```

Schema change (exports at `~/projects/canopi-data/data/exports/`): `schema-contract.json`, `emit-rust --write`, `check`, caller contracts, Python tests, `gen:types`, a real prepared DB, Rust gates. New filterable field: `plant-filter-fields.json`, `gen:types`, `filters.field.<key>` in all 11 locales, detail UI if shown, focused tests.

## Where to look

| Area | Module | Tests |
| --- | --- | --- |
| Contract | `scripts/schema-contract.json`, `scripts/species_catalog_contract.py` | `scripts/test_species_catalog_contract.py` |
| Preparation | `scripts/prepare-db.py` | `scripts/test_prepare_db.py` |
| Normalization | `common-types/species-search-normalization.json` | `test_species_search_normalization.py`, `species_search_normalization.rs`, `species-search-normalization.test.ts` |
| Admission | `desktop/src/db/plant_catalog_connection.rs`, `db/mod.rs` | `db/mod.rs` tests |
| Query builder | `desktop/src/db/query_builder/` | `db/query_builder.rs` tests |
| Read projections | `desktop/src/services/species_catalog_read/` | module tests, latency harness |
| Workbench | `desktop/web/src/app/plant-browser/` | `species-catalog-*.test.ts`, `plant-catalog-browser.test.tsx` |
| Web artifact | `scripts/generate-web-catalog.py`, `desktop/web/src/web/duckdb-wasm-catalog.ts` | `web-catalog-artifact-contract.test.ts`, `duckdb-wasm-*.test.ts`, `web-species-catalog-*.test.ts(x)` |
| User DB | `desktop/src/db/user_db.rs`, `db/mod.rs` | module tests |

## Open decisions

Parked with the user; do not act on these:

- canopi-h90p.10: synonyms are not in the prepared DB (`synonym_lookup` is dropped), so the plant finder cannot match them.
- canopi-h90p.45: implausible heights in the catalog data.
