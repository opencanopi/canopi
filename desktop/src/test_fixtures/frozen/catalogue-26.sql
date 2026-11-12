-- Frozen catalogue 26 (Step 2.0.4 R2-3, canopi-f47t.52.271; 2.1-M474, 2.1-M480, 2.1-M488, 2.1-M493).
--
-- What the reader release reads of a catalogue 2.1 writes, as literal text: never regenerate, never edit a row.
-- The file stays `lidar-library.sqlite` at the library root and the version stays the `lidar_catalogue_meta` row
-- `schema_version` (a TEXT integer), so v2.0.3's inspect() reads this as Newer(26) and refuses it unchanged
-- (2.1-M474). Every other 2.1 table takes a `library_*` name; the jobs table is `library_jobs` (contracts §8).
-- Frozen are the read projections only (2.1-M480): `library_items(id, kind, lineage_tag, name, name_key)` and the
-- `library_jobs` rows' state. Later catalogue steps may add tables and columns, never rename, retype or change the
-- meaning of these. The CHECK literals are LibraryItemKind, Lineage, LibraryJobState and LibraryJobOutcome's
-- `literal()`s; catalogue.rs holds every literal here to its enum's ALL. Ids keep their catalogue 25 spelling
-- (catalogue-25-probe.sql; 2.1-M493).

CREATE TABLE lidar_catalogue_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE library_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('raster', 'vector')),
    lineage_tag TEXT NOT NULL CHECK (lineage_tag IN ('source', 'analysis', 'external')),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE
);

CREATE TABLE library_jobs (
    id TEXT PRIMARY KEY,
    item_id TEXT REFERENCES library_items(id),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'settling', 'settled')),
    outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'interrupted')),
    failure TEXT,
    operation_id TEXT NOT NULL,
    CHECK ((state = 'settled') = (outcome IS NOT NULL)),
    CHECK ((outcome IS 'failed') = (failure IS NOT NULL)),
    CHECK (failure IS NULL OR json_valid(failure))
);

INSERT INTO lidar_catalogue_meta(key, value) VALUES ('schema_version', '26');

INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
    VALUES ('lyr-0000018f2a3b4c5d0001', 'raster', 'source', 'Orchard terrain', 'orchard terrain');
INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
    VALUES ('item-0000018f2a3b4c5d0003', 'raster', 'analysis', 'Orchard slope', 'orchard slope');
INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
    VALUES ('vec-0000018f2a3b4c5d0004', 'vector', 'source', 'Hedge lines', 'hedge lines');
INSERT INTO library_items(id, kind, lineage_tag, name, name_key)
    VALUES ('lyr-0000018f2a3b4c5d0005', 'raster', 'external', 'Drone canopy model', 'drone canopy model');

INSERT INTO library_jobs(id, item_id, state, outcome, failure, operation_id)
    VALUES ('job-0000018f2a3b4c5d0101', 'lyr-0000018f2a3b4c5d0001', 'settled', 'succeeded', NULL,
            'u-3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a01');
INSERT INTO library_jobs(id, item_id, state, outcome, failure, operation_id)
    VALUES ('job-0000018f2a3b4c5d0102', 'item-0000018f2a3b4c5d0003', 'queued', NULL, NULL,
            'u-3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a02');
INSERT INTO library_jobs(id, item_id, state, outcome, failure, operation_id)
    VALUES ('job-0000018f2a3b4c5d0103', 'vec-0000018f2a3b4c5d0004', 'running', NULL, NULL,
            'u-3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a03');
INSERT INTO library_jobs(id, item_id, state, outcome, failure, operation_id)
    VALUES ('job-0000018f2a3b4c5d0104', 'item-0000018f2a3b4c5d0003', 'settling', NULL, NULL,
            's-3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a04');
INSERT INTO library_jobs(id, item_id, state, outcome, failure, operation_id)
    VALUES ('job-0000018f2a3b4c5d0105', 'item-0000018f2a3b4c5d0003', 'settled', 'failed', '{"kind":"internal"}',
            'u-3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a05');
INSERT INTO library_jobs(id, item_id, state, outcome, failure, operation_id)
    VALUES ('job-0000018f2a3b4c5d0106', NULL, 'settled', 'cancelled', NULL,
            'u-3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a06');
INSERT INTO library_jobs(id, item_id, state, outcome, failure, operation_id)
    VALUES ('job-0000018f2a3b4c5d0107', 'lyr-0000018f2a3b4c5d0005', 'settled', 'interrupted', NULL,
            's-3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a07');
