-- Frozen catalogue 25 probe fixture (Step 2.0.4 R2-1, canopi-f47t.52.271; 2.1-M475).
--
-- The two tables a Site data entry's id can name in catalogue 25: an imported item in
-- lidar_source_layers (ids minted `lyr-`) and an analysis result in lidar_derived_items
-- (ids minted `item-`), with the definition the result references. Column shapes are
-- catalogue.rs's SCHEMA at CATALOGUE_VERSION 25; kindless_resolution_tests.rs holds them
-- equal to the live schema. Literal text: never regenerate, never edit a row.

CREATE TABLE lidar_catalogue_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE lidar_source_layers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('raster')),
    quantity TEXT NOT NULL,
    units TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE lidar_analysis_definitions (
    id TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE lidar_derived_items (
    id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL REFERENCES lidar_analysis_definitions(id),
    output_key TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('raster')),
    quantity TEXT NOT NULL,
    units TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (definition_id, output_key)
);

INSERT INTO lidar_catalogue_meta(key, value) VALUES ('schema_version', '25');

INSERT INTO lidar_source_layers(id, name, item_kind, quantity, units, created_at)
    VALUES ('lyr-0000018f2a3b4c5d0001', 'Orchard terrain', 'raster', 'ground-elevation', 'm', '1790000000000');

INSERT INTO lidar_analysis_definitions(id, analysis_id, parameters_json, outputs_json, created_at)
    VALUES ('adef-0000018f2a3b4c5d0002', 'terrain.slope', '{}', '["slope"]', '1790000000001');

INSERT INTO lidar_derived_items(id, definition_id, output_key, item_kind, quantity, units, name, created_at)
    VALUES ('item-0000018f2a3b4c5d0003', 'adef-0000018f2a3b4c5d0002', 'slope', 'raster', 'slope', '°', 'Orchard slope', '1790000000002');
