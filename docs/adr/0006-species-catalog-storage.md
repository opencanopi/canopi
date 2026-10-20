# Species catalog storage

Status: Accepted (2026-09-25, Canopi v2); amended 2026-10-17 (the native image cache that exists; filter value lists; the full catalog on Web, ledger 2.1-Q113; one engine if it holds, 2.1-E1)

## Context

The species catalog is large (the Desktop plant DB is about 1.2 GB) and needs localized search, filters and detail. The Web Edition must serve a catalog from static files.

## Decision

- Storage engines sit behind the Species Catalog read projection. **Desktop** reads a bundled SQLite DB through Rust. **Web** reads generated Parquet shards through DuckDB-WASM.
- Both come from the same canopi-data export lineage. Shared UI consumes the Species Catalog workbench (`app/plant-browser/workbench.ts`) and caller-oriented reads.
- The Web catalog carries every field, filter, photo and fact that Desktop has (2.1-Q113), in zstd Parquet read on demand by range requests; no piece is fetched until a screen reads it. Both readers offer the same filters and detail sections.
- Common names follow the selected app language; the canonical name is the language-neutral fallback. Locale assets load on demand.
- Hero images stay remote with source, credit and licence metadata, one attribution read model for both editions. No image binaries, gallery prefetch or image proxy. Desktop keeps one derived native image cache (ADR 0026: wiped on a bump, never migrated), published through `canopi-support`.
- Parquet shards, metadata, workers and app assets fit the static packaging limits in the build and release guide. Expanded NDJSON is not a production path.
- Filterable fields, and each closed filter's ordered value list, are authored in `common-types/plant-filter-fields.json`; bindings and the Web admission module are generated from it, and both readers offer the same values in the same order.
- Site Adaptation (compatibility checks, replacement suggestions) is retired in both editions. Reintroducing it needs a new decision that names the catalog fields and query costs it requires.

## Consequences

- One set of catalog and detail components serves both editions.
- Moving Desktop off SQLite requires evidence that localized search, filters, detail and latency stay sound while complexity drops: the spike of [ADR 0027](0027-extension-points-and-exports.md) (2.1-E1) runs the Web DuckDB-WASM reader inside the Desktop webview against the ranking corpus (outcome A, ADR 0027); if it holds, this ADR is replaced by one catalog artifact for both editions.
