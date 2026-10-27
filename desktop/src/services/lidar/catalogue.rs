//! `lidar-library.sqlite` catalogue: sources, fixed library items, analysis
//! definitions with their inputs, derived items, jobs and generations.
//!
//! Transactions are short; raster computation never happens while a catalogue
//! connection is held. All SQL uses prepared statements with placeholders.

use rusqlite::{Connection, OptionalExtension};

/// The only catalogue shape this binary reads (Canopi v2).
///
/// There is no migration ladder: an older or corrupt catalogue is set aside
/// and rebuilt from the originals (`recovery.rs`, ADR 0021), and a newer one
/// is refused so an older binary never writes rows it does not understand.
pub const CATALOGUE_VERSION: i32 = 25;

/// Open (or create) the catalogue at `path`.
///
/// Fails when the file carries any other schema version; `recovery::open_catalogue`
/// is the caller that turns that into a rebuild or a refusal.
pub fn open(path: &std::path::Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|e| format!("Failed to open LiDAR catalogue {}: {e}", path.display()))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to enable WAL for LiDAR catalogue: {e}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;
    match schema_version(&connection)? {
        None => create_schema(&connection)?,
        Some(CATALOGUE_VERSION) => {}
        Some(other) => {
            return Err(format!(
                "LiDAR catalogue schema version {other} is not supported (expected {CATALOGUE_VERSION})"
            ));
        }
    }
    Ok(connection)
}

/// A fresh, empty catalogue that lives only in this process: what a library
/// that cannot own its catalogue file runs on.
pub fn open_in_memory() -> Result<Connection, String> {
    let connection = Connection::open_in_memory()
        .map_err(|e| format!("Failed to open an in-memory LiDAR catalogue: {e}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;
    create_schema(&connection)?;
    Ok(connection)
}

/// SQLite's bounded integrity check of an existing catalogue file.
pub fn quick_check(path: &std::path::Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open LiDAR catalogue {}: {e}", path.display()))?;
    let verdict: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|e| format!("LiDAR catalogue integrity check failed: {e}"))?;
    if verdict == "ok" {
        Ok(())
    } else {
        Err(format!("LiDAR catalogue integrity check failed: {verdict}"))
    }
}

/// Schema version recorded in an existing catalogue file, or `None` when the
/// file is absent or has never been initialised.
pub fn stored_version(path: &std::path::Path) -> Result<Option<i32>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open LiDAR catalogue {}: {e}", path.display()))?;
    schema_version(&connection)
}

fn schema_version(connection: &Connection) -> Result<Option<i32>, String> {
    let has_meta: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
                           WHERE type = 'table' AND name = 'lidar_catalogue_meta')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to read catalogue version: {e}"))?;
    if !has_meta {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT value FROM lidar_catalogue_meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read catalogue version: {e}"))?
        .map(|value| {
            value
                .parse()
                .map_err(|_| format!("LiDAR catalogue has an unreadable schema version {value:?}"))
        })
        .transpose()
}

pub(crate) fn create_schema(connection: &Connection) -> Result<(), String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| format!("Failed to start LiDAR catalogue creation: {e}"))?;
    transaction
        .execute_batch(SCHEMA)
        .map_err(|e| format!("Failed to create the LiDAR catalogue: {e}"))?;
    transaction
        .execute(
            "INSERT INTO lidar_catalogue_meta(key, value) VALUES('schema_version', ?1)",
            [CATALOGUE_VERSION.to_string()],
        )
        .map_err(|e| format!("Failed to record catalogue version: {e}"))?;
    transaction
        .commit()
        .map_err(|e| format!("Failed to commit LiDAR catalogue creation: {e}"))
}

const SCHEMA: &str = r#"
CREATE TABLE lidar_catalogue_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE lidar_sources (
    sha256 TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    probe_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

-- One prepared reading of one source band. The valid-cell count and value
-- range are measured once while the source COG is prepared.
CREATE TABLE lidar_interpretations (
    id TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL REFERENCES lidar_sources(sha256),
    band_index INTEGER NOT NULL,
    quantity TEXT NOT NULL,
    units TEXT NOT NULL,
    scale REAL NOT NULL,
    offset REAL NOT NULL,
    crs_ref TEXT NOT NULL,
    vertical_ref TEXT NOT NULL,
    nodata REAL,
    geotransform TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    interp_hash TEXT NOT NULL UNIQUE,
    valid_cells INTEGER NOT NULL,
    min_value REAL,
    max_value REAL
);

-- An imported library item. Its quantity is one of the importable raster
-- quantities (`RasterQuantity::key`).
CREATE TABLE lidar_source_layers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('raster')),
    quantity TEXT NOT NULL,
    units TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- A fixed library item publishes exactly one generation.
CREATE TABLE lidar_layer_generations (
    id TEXT PRIMARY KEY,
    layer_id TEXT NOT NULL REFERENCES lidar_source_layers(id),
    created_at TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    coverage_cells INTEGER,
    min_value REAL,
    max_value REAL,
    display_min_value REAL,
    display_max_value REAL,
    display_basis TEXT,
    bounds_3857 TEXT NOT NULL,
    -- `projected-metre`, `projected-other`, `geographic` or `unknown`, read from
    -- the stored CRS at import so analysis offers need no raster read.
    crs_class TEXT NOT NULL,
    CHECK ((display_min_value IS NULL) = (display_max_value IS NULL)),
    CHECK (display_min_value IS NULL OR display_min_value <= display_max_value)
);

CREATE INDEX idx_layer_generations_layer
    ON lidar_layer_generations(layer_id);

CREATE TABLE lidar_layer_heads (
    layer_id TEXT PRIMARY KEY REFERENCES lidar_source_layers(id),
    generation_id TEXT NOT NULL REFERENCES lidar_layer_generations(id)
);

-- Ordered source members of a generation; position 0 is topmost.
CREATE TABLE lidar_collection_members (
    generation_id TEXT NOT NULL REFERENCES lidar_layer_generations(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    interpretation_id TEXT NOT NULL REFERENCES lidar_interpretations(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (generation_id, member_id)
);

CREATE UNIQUE INDEX lidar_collection_members_position_idx
    ON lidar_collection_members(generation_id, position);

CREATE TABLE lidar_layer_lattices (
    layer_id TEXT PRIMARY KEY REFERENCES lidar_source_layers(id) ON DELETE CASCADE,
    origin_x REAL NOT NULL,
    origin_y REAL NOT NULL,
    pixel_x REAL NOT NULL,
    pixel_y REAL NOT NULL,
    crs_ref TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE lidar_import_jobs (
    id TEXT PRIMARY KEY,
    layer_id TEXT NOT NULL REFERENCES lidar_source_layers(id),
    state TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    progress_phase TEXT,
    progress_percent INTEGER
        CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
    -- The saved selection in priority order, so Retry resubmits exactly it.
    request_json TEXT
);

-- One registered analysis (`analysis_id`, see analysis-registry.json) with its
-- resolved parameters and selected outputs. Recipe versions live on jobs.
CREATE TABLE lidar_analysis_definitions (
    id TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- The library item bound to each input key; a source or a derived item.
CREATE TABLE lidar_analysis_inputs (
    definition_id TEXT NOT NULL REFERENCES lidar_analysis_definitions(id),
    input_key TEXT NOT NULL,
    item_id TEXT NOT NULL,
    PRIMARY KEY (definition_id, input_key)
);

CREATE INDEX idx_analysis_inputs_item ON lidar_analysis_inputs(item_id);

-- One output of a definition as a library item. Refresh publishes a new
-- generation under the same item.
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

-- One run of a definition: the recipe it ran, the input generations it was
-- pinned to and, once published, the tool that ran. Runs stay as the
-- processing history.
CREATE TABLE lidar_analysis_jobs (
    id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL REFERENCES lidar_analysis_definitions(id),
    state TEXT NOT NULL,
    message TEXT,
    recipe_version INTEGER NOT NULL,
    input_generations_json TEXT NOT NULL,
    tool_provenance TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_analysis_jobs_definition
    ON lidar_analysis_jobs(definition_id, created_at);

-- Results are sparse chunks (lidar_generation_chunks). A refresh deletes the
-- superseded generation's chunk rows and keeps this row for the history.
CREATE TABLE lidar_derived_generations (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES lidar_derived_items(id),
    job_id TEXT NOT NULL REFERENCES lidar_analysis_jobs(id),
    manifest_json TEXT NOT NULL,
    coverage_cells INTEGER,
    min_value REAL,
    max_value REAL,
    bounds_3857 TEXT NOT NULL,
    crs_class TEXT NOT NULL,
    published_at TEXT NOT NULL
);

CREATE INDEX idx_derived_generations_item ON lidar_derived_generations(item_id);
CREATE INDEX idx_derived_generations_job ON lidar_derived_generations(job_id);

CREATE TABLE lidar_derived_heads (
    item_id TEXT PRIMARY KEY REFERENCES lidar_derived_items(id),
    generation_id TEXT NOT NULL REFERENCES lidar_derived_generations(id)
);

CREATE TABLE lidar_raster_assets (
    sha256 TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    profile TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    geotransform TEXT NOT NULL,
    crs_ref TEXT NOT NULL,
    nodata REAL,
    created_at TEXT NOT NULL
);

CREATE TABLE lidar_interpretation_cogs (
    interpretation_id TEXT PRIMARY KEY REFERENCES lidar_interpretations(id) ON DELETE CASCADE,
    asset_sha256 TEXT NOT NULL REFERENCES lidar_raster_assets(sha256),
    nodata REAL,
    created_at TEXT NOT NULL
);

-- Resolved chunks of a source or derived generation. Rows stay unpublished,
-- and unreadable, until the owning generation's publish transaction flips them.
CREATE TABLE lidar_generation_chunks (
    generation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    chunk_x INTEGER NOT NULL,
    chunk_y INTEGER NOT NULL,
    asset_sha256 TEXT NOT NULL REFERENCES lidar_raster_assets(sha256),
    valid_cells INTEGER NOT NULL,
    min_value REAL,
    max_value REAL,
    sum_value REAL,
    state TEXT NOT NULL DEFAULT 'unpublished',
    PRIMARY KEY (generation_id, role, chunk_x, chunk_y)
);

CREATE INDEX lidar_generation_chunks_asset_idx
    ON lidar_generation_chunks(asset_sha256);

CREATE INDEX lidar_generation_chunks_role_order_idx
    ON lidar_generation_chunks(generation_id, role, chunk_y, chunk_x);
"#;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct LayerRow {
    pub id: String,
    pub name: String,
    /// `RasterQuantity::key` of an importable quantity.
    pub quantity: String,
    pub units: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct GenerationRow {
    pub id: String,
    pub manifest_json: String,
    /// Exact valid cells, or `None` when the count is not known. A generation
    /// published without reading the composed pixels reports unknown rather
    /// than zero.
    pub coverage_cells: Option<i64>,
    pub min_value: Option<f64>,
    pub max_value: Option<f64>,
    /// The range styling and legends use, with the basis it came from.
    pub display_min_value: Option<f64>,
    pub display_max_value: Option<f64>,
    pub display_basis: Option<String>,
    pub bounds_3857: String,
    pub crs_class: String,
}

#[derive(Debug, Clone)]
pub struct AnalysisDefinitionRow {
    pub id: String,
    /// Registry id, e.g. `terrain.slope`.
    pub analysis_id: String,
    pub parameters_json: String,
    pub outputs_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalysisInputRow {
    pub input_key: String,
    pub item_id: String,
}

#[derive(Debug, Clone)]
pub struct DerivedItemRow {
    pub id: String,
    pub definition_id: String,
    pub output_key: String,
    pub quantity: String,
    pub units: String,
    pub name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct DerivedGenerationRow {
    pub id: String,
    pub item_id: String,
    pub job_id: String,
    pub manifest_json: String,
    pub coverage_cells: Option<i64>,
    pub min_value: Option<f64>,
    pub max_value: Option<f64>,
    pub bounds_3857: String,
    pub crs_class: String,
}

#[derive(Debug, Clone)]
pub struct AnalysisJobRow {
    pub id: String,
    pub definition_id: String,
    pub state: String,
    pub message: Option<String>,
    pub recipe_version: i64,
    pub input_generations_json: String,
    pub tool_provenance: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ImportJobRow {
    pub id: String,
    pub layer_id: String,
    pub state: String,
    pub message: Option<String>,
    pub progress_phase: Option<String>,
    pub progress_percent: Option<i64>,
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

fn map_layer(row: &rusqlite::Row<'_>) -> rusqlite::Result<LayerRow> {
    Ok(LayerRow {
        id: row.get(0)?,
        name: row.get(1)?,
        quantity: row.get(2)?,
        units: row.get(3)?,
        created_at: row.get(4)?,
    })
}

const LAYER_COLUMNS: &str = "id, name, quantity, units, created_at";

pub fn list_layers(connection: &Connection) -> Result<Vec<LayerRow>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {LAYER_COLUMNS} FROM lidar_source_layers ORDER BY created_at, id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], map_layer)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn get_layer(connection: &Connection, layer_id: &str) -> Result<Option<LayerRow>, String> {
    connection
        .query_row(
            &format!("SELECT {LAYER_COLUMNS} FROM lidar_source_layers WHERE id = ?1"),
            [layer_id],
            map_layer,
        )
        .optional()
        .map_err(|e| e.to_string())
}

pub fn head_generation(
    connection: &Connection,
    layer_id: &str,
) -> Result<Option<GenerationRow>, String> {
    connection
        .query_row(
            "SELECT g.id, g.manifest_json,
                    g.coverage_cells, g.min_value, g.max_value,
                    g.display_min_value, g.display_max_value, g.display_basis,
                    g.bounds_3857, g.crs_class
             FROM lidar_layer_heads h
             JOIN lidar_layer_generations g ON g.id = h.generation_id
             WHERE h.layer_id = ?1",
            [layer_id],
            map_generation_row,
        )
        .optional()
        .map_err(|e| e.to_string())
}

/// One generation of one source item, current or not.
pub fn layer_generation(
    connection: &Connection,
    layer_id: &str,
    generation_id: &str,
) -> Result<Option<GenerationRow>, String> {
    connection
        .query_row(
            "SELECT g.id, g.manifest_json,
                    g.coverage_cells, g.min_value, g.max_value,
                    g.display_min_value, g.display_max_value, g.display_basis,
                    g.bounds_3857, g.crs_class
             FROM lidar_layer_generations g
             WHERE g.id = ?1 AND g.layer_id = ?2",
            [generation_id, layer_id],
            map_generation_row,
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn map_generation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenerationRow> {
    Ok(GenerationRow {
        id: row.get(0)?,
        manifest_json: row.get(1)?,
        coverage_cells: row.get(2)?,
        min_value: row.get(3)?,
        max_value: row.get(4)?,
        display_min_value: row.get(5)?,
        display_max_value: row.get(6)?,
        display_basis: row.get(7)?,
        bounds_3857: row.get(8)?,
        crs_class: row.get(9)?,
    })
}

fn map_definition_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnalysisDefinitionRow> {
    Ok(AnalysisDefinitionRow {
        id: row.get(0)?,
        analysis_id: row.get(1)?,
        parameters_json: row.get(2)?,
        outputs_json: row.get(3)?,
    })
}

pub fn get_definition(
    connection: &Connection,
    definition_id: &str,
) -> Result<Option<AnalysisDefinitionRow>, String> {
    connection
        .query_row(
            "SELECT id, analysis_id, parameters_json, outputs_json
             FROM lidar_analysis_definitions WHERE id = ?1",
            [definition_id],
            map_definition_row,
        )
        .optional()
        .map_err(|e| e.to_string())
}

/// The inputs of a definition, in the order they were bound (registry order).
pub fn definition_inputs(
    connection: &Connection,
    definition_id: &str,
) -> Result<Vec<AnalysisInputRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT input_key, item_id FROM lidar_analysis_inputs
             WHERE definition_id = ?1 ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    statement
        .query_map([definition_id], |row| {
            Ok(AnalysisInputRow {
                input_key: row.get(0)?,
                item_id: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn map_derived_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<DerivedItemRow> {
    Ok(DerivedItemRow {
        id: row.get(0)?,
        definition_id: row.get(1)?,
        output_key: row.get(2)?,
        quantity: row.get(3)?,
        units: row.get(4)?,
        name: row.get(5)?,
        created_at: row.get(6)?,
    })
}

const DERIVED_ITEM_COLUMNS: &str =
    "id, definition_id, output_key, quantity, units, name, created_at";

pub fn list_derived_items(connection: &Connection) -> Result<Vec<DerivedItemRow>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {DERIVED_ITEM_COLUMNS} FROM lidar_derived_items ORDER BY created_at, id"
        ))
        .map_err(|e| e.to_string())?;
    statement
        .query_map([], map_derived_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn get_derived_item(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<DerivedItemRow>, String> {
    connection
        .query_row(
            &format!("SELECT {DERIVED_ITEM_COLUMNS} FROM lidar_derived_items WHERE id = ?1"),
            [item_id],
            map_derived_item,
        )
        .optional()
        .map_err(|e| e.to_string())
}

/// The items of one definition, in output order of creation.
pub fn definition_items(
    connection: &Connection,
    definition_id: &str,
) -> Result<Vec<DerivedItemRow>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {DERIVED_ITEM_COLUMNS} FROM lidar_derived_items
             WHERE definition_id = ?1 ORDER BY rowid"
        ))
        .map_err(|e| e.to_string())?;
    statement
        .query_map([definition_id], map_derived_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn map_derived_generation(row: &rusqlite::Row<'_>) -> rusqlite::Result<DerivedGenerationRow> {
    Ok(DerivedGenerationRow {
        id: row.get(0)?,
        item_id: row.get(1)?,
        job_id: row.get(2)?,
        manifest_json: row.get(3)?,
        coverage_cells: row.get(4)?,
        min_value: row.get(5)?,
        max_value: row.get(6)?,
        bounds_3857: row.get(7)?,
        crs_class: row.get(8)?,
    })
}

const DERIVED_GENERATION_COLUMNS: &str = "g.id, g.item_id, g.job_id, g.manifest_json, \
     g.coverage_cells, g.min_value, g.max_value, g.bounds_3857, g.crs_class";

/// The current generation of a derived item.
pub fn derived_head(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<DerivedGenerationRow>, String> {
    connection
        .query_row(
            &format!(
                "SELECT {DERIVED_GENERATION_COLUMNS} FROM lidar_derived_heads h
                 JOIN lidar_derived_generations g ON g.id = h.generation_id
                 WHERE h.item_id = ?1"
            ),
            [item_id],
            map_derived_generation,
        )
        .optional()
        .map_err(|e| e.to_string())
}

/// The generations one run published.
pub fn job_generations(
    connection: &Connection,
    job_id: &str,
) -> Result<Vec<DerivedGenerationRow>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {DERIVED_GENERATION_COLUMNS} FROM lidar_derived_generations g
             WHERE g.job_id = ?1 ORDER BY g.rowid"
        ))
        .map_err(|e| e.to_string())?;
    statement
        .query_map([job_id], map_derived_generation)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// The current generation of any library item: a source's or a derived one's.
pub fn item_head_generation_id(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT generation_id FROM lidar_layer_heads WHERE layer_id = ?1
             UNION ALL
             SELECT generation_id FROM lidar_derived_heads WHERE item_id = ?1",
            [item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn map_job_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnalysisJobRow> {
    Ok(AnalysisJobRow {
        id: row.get(0)?,
        definition_id: row.get(1)?,
        state: row.get(2)?,
        message: row.get(3)?,
        recipe_version: row.get(4)?,
        input_generations_json: row.get(5)?,
        tool_provenance: row.get(6)?,
        created_at: row.get(7)?,
        finished_at: row.get(8)?,
    })
}

const JOB_COLUMNS: &str = "id, definition_id, state, message, recipe_version, \
     input_generations_json, tool_provenance, created_at, finished_at";

pub fn get_analysis_job(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<AnalysisJobRow>, String> {
    connection
        .query_row(
            &format!("SELECT {JOB_COLUMNS} FROM lidar_analysis_jobs WHERE id = ?1"),
            [job_id],
            map_job_row,
        )
        .optional()
        .map_err(|e| e.to_string())
}

/// The newest job of a definition.
pub fn latest_analysis_job(
    connection: &Connection,
    definition_id: &str,
) -> Result<Option<AnalysisJobRow>, String> {
    connection
        .query_row(
            &format!(
                "SELECT {JOB_COLUMNS} FROM lidar_analysis_jobs WHERE definition_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT 1"
            ),
            [definition_id],
            map_job_row,
        )
        .optional()
        .map_err(|e| e.to_string())
}

/// One page of a definition's jobs, newest first, strictly older than `before`
/// (`created_at`, `id`).
pub fn analysis_job_page(
    connection: &Connection,
    definition_id: &str,
    before: Option<(&str, &str)>,
    limit: i64,
) -> Result<Vec<AnalysisJobRow>, String> {
    // One more than a page, so the caller knows whether another page exists.
    let limit = limit.clamp(1, common_types::library::PROCESSING_HISTORY_PAGE + 1);
    let mut statement = connection
        .prepare(&format!(
            "SELECT {JOB_COLUMNS} FROM lidar_analysis_jobs
             WHERE definition_id = ?1
               AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
             ORDER BY created_at DESC, id DESC LIMIT ?4"
        ))
        .map_err(|e| e.to_string())?;
    let (created_at, id) = match before {
        Some((created_at, id)) => (Some(created_at), Some(id)),
        None => (None, None),
    };
    statement
        .query_map(
            rusqlite::params![definition_id, created_at, id, limit],
            map_job_row,
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Derived items whose definitions use `item_id` as an input.
pub fn dependent_items(connection: &Connection, item_id: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT d.id FROM lidar_analysis_inputs i
             JOIN lidar_derived_items d ON d.definition_id = i.definition_id
             WHERE i.item_id = ?1 ORDER BY d.created_at, d.id",
        )
        .map_err(|e| e.to_string())?;
    statement
        .query_map([item_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn get_import_job(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<ImportJobRow>, String> {
    connection
        .query_row(
            "SELECT id, layer_id, state, message, progress_phase, progress_percent
             FROM lidar_import_jobs WHERE id = ?1",
            [job_id],
            |row| {
                Ok(ImportJobRow {
                    id: row.get(0)?,
                    layer_id: row.get(1)?,
                    state: row.get(2)?,
                    message: row.get(3)?,
                    progress_phase: row.get(4)?,
                    progress_percent: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
}

pub fn update_import_progress(
    connection: &Connection,
    job_id: &str,
    phase: &str,
    percent: u8,
) -> Result<bool, String> {
    connection
        .execute(
            "UPDATE lidar_import_jobs
             SET progress_phase = ?2, progress_percent = ?3, updated_at = ?4
             WHERE id = ?1 AND state IN ('staging', 'applying')
               AND COALESCE(progress_percent, -1) < ?3",
            rusqlite::params![job_id, phase, percent, now_iso()],
        )
        .map(|changed| changed > 0)
        .map_err(|e| format!("Failed to record LiDAR import progress: {e}"))
}

#[derive(Debug, Clone)]
pub struct InterpretationRow {
    pub geotransform: String,
    pub width: i64,
    pub height: i64,
    /// Declared NoData of this interpretation. It is the effective validity
    /// rule for lossless-validity sources and must never be replaced by
    /// another member's sentinel.
    pub nodata: Option<f64>,
}

pub fn get_interpretation(
    connection: &Connection,
    interpretation_id: &str,
) -> Result<Option<InterpretationRow>, String> {
    connection
        .query_row(
            "SELECT geotransform, width, height, nodata
             FROM lidar_interpretations WHERE id = ?1",
            [interpretation_id],
            |row| {
                Ok(InterpretationRow {
                    geotransform: row.get(0)?,
                    width: row.get(1)?,
                    height: row.get(2)?,
                    nodata: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Ordered source collections
// ---------------------------------------------------------------------------

/// One occurrence of an ordered collection snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionMemberRow {
    /// Stable occurrence identity, never reused within a snapshot.
    pub member_id: String,
    /// Priority order, lowest first: position 0 is the topmost source.
    pub position: i64,
    pub interpretation_id: String,
}

/// Measured coverage of one interpretation: valid cells and value range.
///
/// Both are measured once while the source COG is prepared, so a source list
/// costs one row read rather than a raster read.
pub fn interpretation_coverage(
    connection: &Connection,
    interpretation_id: &str,
) -> Result<(i64, Option<f64>, Option<f64>), String> {
    connection
        .query_row(
            "SELECT valid_cells, min_value, max_value
             FROM lidar_interpretations WHERE id = ?1",
            [interpretation_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                ))
            },
        )
        .map_err(|e| format!("Failed to read interpretation coverage: {e}"))
}

/// Origin filename of the source an interpretation was derived from.
///
/// The identity is the interpretation's own source relation, never a name
/// match, so the same bytes imported twice report the same original name.
pub fn interpretation_filename(
    connection: &Connection,
    interpretation_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT s.original_filename
             FROM lidar_interpretations i
             JOIN lidar_sources s ON s.sha256 = i.source_sha256
             WHERE i.id = ?1",
            [interpretation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read the source filename: {e}"))
}

/// Largest member page a caller may request.
///
/// Bounded like the other catalogue pages so a source refresh can never expand
/// a layer's whole lifetime membership into one response.
pub const MEMBER_PAGE_MAX: i64 = 200;

/// One bounded page of a snapshot's ordered members, top-first.
///
/// The cursor is the last `position` the caller saw; positions are unique within
/// a snapshot, so the page boundary is exact and stable. The caller passes the
/// snapshot it is paging, which is what makes a late page of a superseded head
/// a rejected request rather than a silently mixed list.
pub fn collection_members_page(
    connection: &Connection,
    generation_id: &str,
    after_position: Option<i64>,
    limit: i64,
) -> Result<Vec<CollectionMemberRow>, String> {
    let limit = limit.clamp(1, MEMBER_PAGE_MAX);
    let mut statement = connection
        .prepare(
            "SELECT member_id, position, interpretation_id
             FROM lidar_collection_members
             WHERE generation_id = ?1 AND position > ?2
             ORDER BY position LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(
            rusqlite::params![generation_id, after_position.unwrap_or(-1), limit],
            |row| {
                Ok(CollectionMemberRow {
                    member_id: row.get(0)?,
                    position: row.get(1)?,
                    interpretation_id: row.get(2)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// How many occurrences one snapshot's composition holds.
pub fn collection_member_count(
    connection: &Connection,
    generation_id: &str,
) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM lidar_collection_members WHERE generation_id = ?1",
            [generation_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count collection members: {e}"))
}

/// Published chunk coordinates of one generation and role, row-major.
///
/// Coordinates only: display planning groups occupied chunks without opening
/// any raster, so distant sparse coverage never implies the empty space between.
pub fn published_chunk_coordinates(
    connection: &Connection,
    generation_id: &str,
    role: &str,
) -> Result<Vec<(i64, i64)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT chunk_x, chunk_y FROM lidar_generation_chunks
             WHERE generation_id = ?1 AND role = ?2 AND state = 'published'
             ORDER BY chunk_y, chunk_x",
        )
        .map_err(|e| format!("Failed to list generation chunks: {e}"))?;
    statement
        .query_map(rusqlite::params![generation_id, role], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("Failed to list generation chunks: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to list generation chunks: {e}"))
}

/// Ordered members of a collection snapshot, topmost first.
pub fn collection_members(
    connection: &Connection,
    generation_id: &str,
) -> Result<Vec<CollectionMemberRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT member_id, position, interpretation_id
             FROM lidar_collection_members WHERE generation_id = ?1 ORDER BY position",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([generation_id], |row| {
            Ok(CollectionMemberRow {
                member_id: row.get(0)?,
                position: row.get(1)?,
                interpretation_id: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Write one snapshot's ordered members, replacing any rows already recorded.
///
/// Only ever called inside the publication transaction that creates the
/// generation, so the rows and their head become visible together or not at
/// all.
pub fn replace_collection_members(
    connection: &Connection,
    generation_id: &str,
    members: &[CollectionMemberRow],
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM lidar_collection_members WHERE generation_id = ?1",
            [generation_id],
        )
        .map_err(|e| format!("Failed to clear collection members: {e}"))?;
    for member in members {
        connection
            .execute(
                "INSERT INTO lidar_collection_members(
                     generation_id, member_id, position, interpretation_id, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    generation_id,
                    member.member_id,
                    member.position,
                    member.interpretation_id,
                    now_iso(),
                ],
            )
            .map_err(|e| format!("Failed to record collection member: {e}"))?;
    }
    Ok(())
}

pub fn now_iso() -> String {
    // Unix milliseconds; identity fields are UUIDs, timestamps are ordering
    // hints only, so wall-clock precision is sufficient.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis}")
}

static ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn new_id(prefix: &str) -> String {
    use std::sync::atomic::Ordering;
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{prefix}-{nanos:016x}{counter:04x}")
}

/// Every asset digest a catalogue row references: a source interpretation's
/// COG or any generation or result chunk, published or not.
pub fn referenced_asset_digests(
    connection: &Connection,
) -> Result<std::collections::HashSet<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT asset_sha256 FROM lidar_interpretation_cogs
             UNION SELECT asset_sha256 FROM lidar_generation_chunks",
        )
        .map_err(|e| format!("Failed to read asset references: {e}"))?;
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to read asset references: {e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("Failed to read asset references: {e}"))
}

/// Drop asset metadata rows no reference names; their files are swept too.
pub fn discard_unreferenced_asset_rows(connection: &Connection) -> Result<usize, String> {
    connection
        .execute(
            "DELETE FROM lidar_raster_assets WHERE sha256 NOT IN (
                SELECT asset_sha256 FROM lidar_interpretation_cogs
                UNION SELECT asset_sha256 FROM lidar_generation_chunks)",
            [],
        )
        .map_err(|e| format!("Failed to discard unreferenced asset rows: {e}"))
}

/// Whether an import or calculation is still running.
pub fn jobs_in_flight(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM lidar_import_jobs WHERE state IN ('staging', 'applying')
                UNION ALL
                SELECT 1 FROM lidar_analysis_jobs WHERE state = 'preparing')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to read job states: {e}"))
}

/// One published resolved-chunk reference.
#[derive(Debug, Clone, PartialEq)]
pub struct GenerationChunkRow {
    pub role: String,
    pub chunk_x: i64,
    pub chunk_y: i64,
    pub asset_sha256: String,
    pub valid_cells: i64,
    pub min_value: f64,
    pub max_value: f64,
    pub sum_value: f64,
}

/// Metadata of one immutable content-addressed raster asset.
///
/// `rel_path` stays relative to the library root so a catalogue stays valid
/// when the library is moved. Chunk rows reference the digest, so the asset
/// row must exist before any chunk row names it.
#[derive(Debug, Clone, PartialEq)]
pub struct RasterAssetRow {
    pub sha256: String,
    pub rel_path: String,
    pub bytes: i64,
    pub profile: String,
    pub width: i64,
    pub height: i64,
    pub geotransform: String,
    pub crs_ref: String,
    pub nodata: Option<f64>,
}

/// The layer lattice every generation of that layer shares.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerLatticeRow {
    pub origin_x: f64,
    pub origin_y: f64,
    pub pixel_x: f64,
    pub pixel_y: f64,
    pub crs_ref: String,
}

/// Record a layer's lattice the first time it is known, and never move it.
///
/// An existing row always wins: a later import that extends the layer left or
/// up must not re-anchor it, or unchanged data would change chunk coordinates.
pub fn record_layer_lattice(
    connection: &Connection,
    layer_id: &str,
    lattice: &LayerLatticeRow,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO lidar_layer_lattices(
                layer_id, origin_x, origin_y, pixel_x, pixel_y, crs_ref, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(layer_id) DO NOTHING",
            rusqlite::params![
                layer_id,
                lattice.origin_x,
                lattice.origin_y,
                lattice.pixel_x,
                lattice.pixel_y,
                lattice.crs_ref,
                now_iso(),
            ],
        )
        .map_err(|e| format!("Failed to record layer lattice: {e}"))?;
    Ok(())
}

/// The layer's fixed lattice, when it has published anything yet.
pub fn layer_lattice(
    connection: &Connection,
    layer_id: &str,
) -> Result<Option<LayerLatticeRow>, String> {
    connection
        .query_row(
            "SELECT origin_x, origin_y, pixel_x, pixel_y, crs_ref
             FROM lidar_layer_lattices WHERE layer_id = ?1",
            [layer_id],
            |row| {
                Ok(LayerLatticeRow {
                    origin_x: row.get(0)?,
                    origin_y: row.get(1)?,
                    pixel_x: row.get(2)?,
                    pixel_y: row.get(3)?,
                    crs_ref: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to read layer lattice: {e}"))
}

/// One published chunk joined with the asset a reader must open.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkAssetRow {
    pub role: String,
    pub chunk_x: i64,
    pub chunk_y: i64,
    pub asset: RasterAssetRow,
    /// Stored valid count and exact f64 sum, so a minifying reader can use the
    /// chunk's mean without opening its file.
    pub aggregate_valid_cells: i64,
    pub aggregate_sum_value: f64,
}

/// Record asset metadata. Published assets are immutable, so an existing row
/// with the same digest is left untouched and never rewritten.
pub fn insert_raster_asset(connection: &Connection, asset: &RasterAssetRow) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO lidar_raster_assets(
                sha256, rel_path, bytes, profile, width, height, geotransform,
                crs_ref, nodata, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(sha256) DO NOTHING",
            rusqlite::params![
                asset.sha256,
                asset.rel_path,
                asset.bytes,
                asset.profile,
                asset.width,
                asset.height,
                asset.geotransform,
                asset.crs_ref,
                asset.nodata,
                now_iso(),
            ],
        )
        .map_err(|e| format!("Failed to record raster asset {}: {e}", asset.sha256))?;
    Ok(())
}

/// The retained standard COG of one prepared interpretation, when it has one,
/// together with the interpretation's own effective NoData rule.
pub fn interpretation_cog(
    connection: &Connection,
    interpretation_id: &str,
) -> Result<Option<(RasterAssetRow, Option<f64>)>, String> {
    connection
        .query_row(
            "SELECT a.sha256, a.rel_path, a.bytes, a.profile, a.width, a.height,
                    a.geotransform, a.crs_ref, a.nodata, c.nodata
             FROM lidar_interpretation_cogs c
             JOIN lidar_raster_assets a ON a.sha256 = c.asset_sha256
             WHERE c.interpretation_id = ?1",
            [interpretation_id],
            |row| Ok((map_asset_row(row, 0)?, row.get(9)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to read interpretation COG: {e}"))
}

fn map_asset_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<RasterAssetRow> {
    Ok(RasterAssetRow {
        sha256: row.get(offset)?,
        rel_path: row.get(offset + 1)?,
        bytes: row.get(offset + 2)?,
        profile: row.get(offset + 3)?,
        width: row.get(offset + 4)?,
        height: row.get(offset + 5)?,
        geotransform: row.get(offset + 6)?,
        crs_ref: row.get(offset + 7)?,
        nodata: row.get(offset + 8)?,
    })
}

/// Half-open lattice-cell bounds a paged chunk read must intersect.
///
/// The bounds are exact signed integers; a caller computes them with checked
/// arithmetic so an unrepresentable window is refused rather than truncated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkWindow {
    pub min_x: i64,
    pub max_x: i64,
    pub min_y: i64,
    pub max_y: i64,
}

impl ChunkWindow {
    /// Inclusive chunk-coordinate bounds covering a half-open cell window.
    ///
    /// Chunk side is `chunk_side` cells, so a chunk `c` covers
    /// `[c * side, c * side + side)`. It intersects `[start, end)` exactly when
    /// `c * side < end` and `c * side + side > start`, which is the inclusive
    /// range below. The conversion is exact for negative coordinates too.
    pub fn for_cells(
        start_x: i64,
        end_x: i64,
        start_y: i64,
        end_y: i64,
        chunk_side: i64,
    ) -> Result<Self, String> {
        if chunk_side <= 0 || end_x <= start_x || end_y <= start_y {
            return Err("chunk window has an empty or negative extent".to_string());
        }
        let last = |end: i64| -> Result<i64, String> {
            end.checked_sub(1)
                .map(|value| value.div_euclid(chunk_side))
                .ok_or_else(|| "chunk window bounds overflow".to_string())
        };
        Ok(Self {
            min_x: start_x.div_euclid(chunk_side),
            max_x: last(end_x)?,
            min_y: start_y.div_euclid(chunk_side),
            max_y: last(end_y)?,
        })
    }

    fn contains_columns(self) -> (i64, i64) {
        (self.min_x, self.max_x)
    }

    fn contains_rows(self) -> (i64, i64) {
        (self.min_y, self.max_y)
    }
}

/// Chunk-record projection shared by the paged, keyed and listed readers.
const CHUNK_ASSET_COLUMNS: &str = "SELECT g.role, g.chunk_x, g.chunk_y,
            a.sha256, a.rel_path, a.bytes, a.profile, a.width, a.height,
            a.geotransform, a.crs_ref, a.nodata, g.valid_cells, g.sum_value
     FROM lidar_generation_chunks g
     JOIN lidar_raster_assets a ON a.sha256 = g.asset_sha256";

fn map_chunk_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChunkAssetRow> {
    Ok(ChunkAssetRow {
        role: row.get(0)?,
        chunk_x: row.get(1)?,
        chunk_y: row.get(2)?,
        asset: map_asset_row(row, 3)?,
        aggregate_valid_cells: row.get(12)?,
        aggregate_sum_value: row.get(13)?,
    })
}

/// One bounded page of published chunk references.
///
/// The page is ordered by `(chunk_y, chunk_x)` and starts strictly after
/// `after`, so a caller pages with a keyset cursor instead of an offset and
/// never re-reads or skips a row. When `window` is given, the spatial filter
/// runs in SQL before any row is loaded, so no absent coordinate is visited.
pub fn generation_chunk_page(
    connection: &Connection,
    generation_id: &str,
    role: &str,
    window: Option<ChunkWindow>,
    after: Option<(i64, i64)>,
    limit: usize,
) -> Result<Vec<ChunkAssetRow>, String> {
    let sql = format!(
        "{CHUNK_ASSET_COLUMNS}
     WHERE g.generation_id = ?1 AND g.role = ?2 AND g.state = 'published'
       AND (?3 IS NULL OR (g.chunk_x BETWEEN ?3 AND ?4 AND g.chunk_y BETWEEN ?5 AND ?6))
       AND (?7 IS NULL OR g.chunk_y > ?7 OR (g.chunk_y = ?7 AND g.chunk_x > ?8))
     ORDER BY g.chunk_y, g.chunk_x
     LIMIT ?9"
    );
    let (min_x, max_x, min_y, max_y) = match window {
        Some(window) => {
            let (min_x, max_x) = window.contains_columns();
            let (min_y, max_y) = window.contains_rows();
            (Some(min_x), Some(max_x), Some(min_y), Some(max_y))
        }
        None => (None, None, None, None),
    };
    let (after_y, after_x) = match after {
        Some((chunk_y, chunk_x)) => (Some(chunk_y), Some(chunk_x)),
        None => (None, None),
    };
    let mut statement = connection
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare chunk page query: {e}"))?;
    let rows = statement
        .query_map(
            rusqlite::params![
                generation_id,
                role,
                min_x,
                max_x,
                min_y,
                max_y,
                after_y,
                after_x,
                i64::try_from(limit).unwrap_or(i64::MAX),
            ],
            map_chunk_row,
        )
        .map_err(|e| format!("Failed to read chunk page: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read chunk page: {e}"))?;
    Ok(rows)
}

/// Published chunk references of one generation and role, ordered by position.
///
/// Only `published` rows are selected: an unpublished row belongs to a job
/// that has not committed, so it must never be readable.
///
/// Test oracle only: production readers page through
/// [`generation_chunk_page`] and never load a generation's whole record set.
#[cfg(test)]
pub fn generation_chunk_assets(
    connection: &Connection,
    generation_id: &str,
    role: &str,
) -> Result<Vec<ChunkAssetRow>, String> {
    let sql = format!(
        "{CHUNK_ASSET_COLUMNS}
     WHERE g.generation_id = ?1 AND g.role = ?2 AND g.state = 'published'
     ORDER BY g.chunk_y, g.chunk_x"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare chunk asset query: {e}"))?;
    statement
        .query_map(rusqlite::params![generation_id, role], map_chunk_row)
        .map_err(|e| format!("Failed to read chunk assets: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read chunk assets: {e}"))
}

/// Drop chunk rows a job left behind before it committed a generation.
///
/// Unpublished rows are never readable, so removing them cannot revoke an
/// accepted generation. Only physical assets are left to reclamation.
pub fn discard_unpublished_chunks(connection: &Connection) -> Result<usize, String> {
    connection
        .execute(
            "DELETE FROM lidar_generation_chunks WHERE state != 'published'",
            [],
        )
        .map_err(|e| format!("Failed to discard unpublished chunk rows: {e}"))
}

/// Drop the unpublished chunk rows of one failed publication attempt.
pub fn discard_unpublished_generation_chunks(
    connection: &Connection,
    generation_id: &str,
) -> Result<usize, String> {
    connection
        .execute(
            "DELETE FROM lidar_generation_chunks WHERE generation_id = ?1 AND state != 'published'",
            [generation_id],
        )
        .map_err(|e| format!("Failed to discard unpublished chunk rows: {e}"))
}

/// Insert chunk references as unpublished rows beside their asset metadata.
///
/// Readers cannot select these rows until the generation's short publish
/// transaction flips them, so a crashed or cancelled job leaves no readable
/// index.
pub fn insert_unpublished_chunks(
    connection: &Connection,
    generation_id: &str,
    chunks: &[GenerationChunkRow],
) -> Result<(), String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| format!("Failed to start chunk insert: {e}"))?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO lidar_generation_chunks(
                    generation_id, role, chunk_x, chunk_y, asset_sha256,
                    valid_cells, min_value, max_value, sum_value, state)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'unpublished')
                 ON CONFLICT(generation_id, role, chunk_x, chunk_y) DO UPDATE SET
                    asset_sha256 = excluded.asset_sha256,
                    valid_cells = excluded.valid_cells,
                    min_value = excluded.min_value,
                    max_value = excluded.max_value,
                    sum_value = excluded.sum_value,
                    state = 'unpublished'",
            )
            .map_err(|e| format!("Failed to prepare chunk insert: {e}"))?;
        for chunk in chunks {
            statement
                .execute(rusqlite::params![
                    generation_id,
                    chunk.role,
                    chunk.chunk_x,
                    chunk.chunk_y,
                    chunk.asset_sha256,
                    chunk.valid_cells,
                    chunk.min_value,
                    chunk.max_value,
                    chunk.sum_value,
                ])
                .map_err(|e| format!("Failed to insert chunk row: {e}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|e| format!("Failed to commit chunk rows: {e}"))
}

/// Publish every chunk row of one generation inside the caller's transaction.
pub fn publish_generation_chunks(
    connection: &Connection,
    generation_id: &str,
) -> Result<usize, String> {
    connection
        .execute(
            "UPDATE lidar_generation_chunks SET state = 'published' WHERE generation_id = ?1",
            [generation_id],
        )
        .map_err(|e| format!("Failed to publish generation chunks: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_progress_is_monotonic_and_stops_with_the_job() {
        let dir = crate::test_scratch::TestScratch::new("canopi-import-progress-test");
        std::fs::create_dir_all(&dir).unwrap();
        let connection = open(&dir.join("catalogue.sqlite")).unwrap();
        connection
            .execute_batch(
                "INSERT INTO lidar_source_layers
                    (id, name, item_kind, quantity, units, created_at)
                 VALUES ('layer', 'Ground', 'raster', 'ground-elevation', 'm', '0');
                 INSERT INTO lidar_import_jobs
                    (id, layer_id, state, created_at, updated_at,
                     progress_phase, progress_percent)
                 VALUES ('job', 'layer', 'applying', '0', '0',
                         'composing_layer', 0);",
            )
            .unwrap();

        assert!(update_import_progress(&connection, "job", "composing_layer", 10).unwrap());
        assert!(!update_import_progress(&connection, "job", "composing_layer", 9).unwrap());
        assert!(update_import_progress(&connection, "job", "rendering_map", 72).unwrap());
        let row = get_import_job(&connection, "job").unwrap().unwrap();
        assert_eq!(row.progress_phase.as_deref(), Some("rendering_map"));
        assert_eq!(row.progress_percent, Some(72));

        connection
            .execute(
                "UPDATE lidar_import_jobs SET state = 'complete', progress_percent = 100
                 WHERE id = 'job'",
                [],
            )
            .unwrap();
        assert!(!update_import_progress(&connection, "job", "rendering_map", 80).unwrap());
        assert_eq!(
            get_import_job(&connection, "job")
                .unwrap()
                .unwrap()
                .progress_percent,
            Some(100)
        );

        drop(connection);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_fresh_catalogue_records_the_current_version() {
        let root = crate::test_scratch::TestScratch::new("canopi-catalogue-fresh");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("lidar-library.sqlite");
        assert_eq!(stored_version(&path).unwrap(), None);
        drop(open(&path).unwrap());
        assert_eq!(stored_version(&path).unwrap(), Some(CATALOGUE_VERSION));
        // Reopening a current catalogue is a no-op.
        drop(open(&path).unwrap());
        assert_eq!(stored_version(&path).unwrap(), Some(CATALOGUE_VERSION));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn any_other_catalogue_version_is_refused_before_writes() {
        for version in ["20", "99"] {
            let root = crate::test_scratch::TestScratch::new("canopi-catalogue-other");
            std::fs::create_dir_all(&root).unwrap();
            let path = root.join("lidar-library.sqlite");
            {
                let connection = open(&path).unwrap();
                connection
                    .execute(
                        "UPDATE lidar_catalogue_meta SET value = ?1 WHERE key = 'schema_version'",
                        [version],
                    )
                    .unwrap();
            }
            let error = open(&path).expect_err("another schema must be refused");
            assert!(error.contains("is not supported"), "{error}");
            assert_eq!(
                stored_version(&path).unwrap(),
                Some(version.parse().unwrap()),
                "a refused catalogue is left untouched"
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn unpublished_chunk_rows_are_invisible_until_the_generation_publishes() {
        let root = crate::test_scratch::TestScratch::new("canopi-chunks");
        std::fs::create_dir_all(&root).unwrap();
        let connection = open(&root.join("lidar-library.sqlite")).unwrap();
        connection
            .execute(
                "INSERT INTO lidar_raster_assets(
                    sha256, rel_path, bytes, profile, width, height, geotransform, crs_ref, nodata, created_at)
                 VALUES('sha-chunk', 'assets/sha-chunk/cog.tif', 8, 'cog-f32-t256-raw-v1',
                    1024, 1024, '[0,1,0,0,0,-1]', 'EPSG:3857', NULL, '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        let rows = vec![GenerationChunkRow {
            role: "resolved".to_string(),
            chunk_x: 0,
            chunk_y: 0,
            asset_sha256: "sha-chunk".to_string(),
            valid_cells: 12,
            min_value: 1.0,
            max_value: 3.0,
            sum_value: 24.0,
        }];
        insert_unpublished_chunks(&connection, "gen-1", &rows).unwrap();
        assert!(
            generation_chunk_page(&connection, "gen-1", "resolved", None, None, 10)
                .unwrap()
                .is_empty(),
            "an unpublished generation exposes no chunk rows"
        );
        let published = publish_generation_chunks(&connection, "gen-1").unwrap();
        assert_eq!(published, 1);
        let page = generation_chunk_page(&connection, "gen-1", "resolved", None, None, 10).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].asset.sha256, "sha-chunk");
        assert_eq!(page[0].aggregate_sum_value, 24.0);
        // A result role keeps its own rows.
        assert!(
            generation_chunk_page(&connection, "gen-1", "quality", None, None, 10)
                .unwrap()
                .is_empty()
        );
        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "ratcheted before 2.1-M188; split when this function next changes"
    )]
    fn chunk_pages_order_by_position_and_filter_spatially_in_sql() {
        let root = crate::test_scratch::TestScratch::new("canopi-chunk-pages");
        std::fs::create_dir_all(&root).unwrap();
        let connection = open(&root.join("catalogue.sqlite")).unwrap();
        connection
            .execute(
                "INSERT INTO lidar_raster_assets(
                    sha256, rel_path, bytes, profile, width, height, geotransform, crs_ref, nodata, created_at)
                 VALUES('sha-page', 'assets/sha-page/cog.tif', 8, 'cog-f32-t256-raw-v1',
                    1024, 1024, '[0,1,0,0,0,-1]', 'EPSG:3857', NULL, '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        // Four records: two rows of two columns, plus a distant record that no
        // small window may return.
        let rows: Vec<GenerationChunkRow> = [(0, 0), (1, 0), (0, 1), (1, 1), (7, 2)]
            .into_iter()
            .map(|(chunk_x, chunk_y)| GenerationChunkRow {
                role: "resolved".to_string(),
                chunk_x,
                chunk_y,
                asset_sha256: "sha-page".to_string(),
                valid_cells: 1,
                min_value: 1.0,
                max_value: 1.0,
                sum_value: 1.0,
            })
            .collect();
        insert_unpublished_chunks(&connection, "gen-1", &rows).unwrap();
        publish_generation_chunks(&connection, "gen-1").unwrap();

        // Keyset pages of two: stable position order, no repeat and no gap.
        let first = generation_chunk_page(&connection, "gen-1", "resolved", None, None, 2).unwrap();
        let cursor = first
            .last()
            .map(|row| (row.chunk_y, row.chunk_x))
            .expect("first page has rows");
        assert_eq!(
            first
                .iter()
                .map(|row| (row.chunk_y, row.chunk_x))
                .collect::<Vec<_>>(),
            vec![(0, 0), (0, 1)]
        );
        let second =
            generation_chunk_page(&connection, "gen-1", "resolved", None, Some(cursor), 2).unwrap();
        assert_eq!(
            second
                .iter()
                .map(|row| (row.chunk_y, row.chunk_x))
                .collect::<Vec<_>>(),
            vec![(1, 0), (1, 1)]
        );
        let third = generation_chunk_page(
            &connection,
            "gen-1",
            "resolved",
            None,
            second.last().map(|row| (row.chunk_y, row.chunk_x)),
            2,
        )
        .unwrap();
        assert_eq!(
            third
                .iter()
                .map(|row| (row.chunk_y, row.chunk_x))
                .collect::<Vec<_>>(),
            vec![(2, 7)]
        );

        // A window filter runs before rows load: chunk 0 covers cells 0..1024.
        let window = ChunkWindow::for_cells(0, 1024, 0, 2048, 1024).unwrap();
        assert_eq!(
            (window.min_x, window.max_x, window.min_y, window.max_y),
            (0, 0, 0, 1)
        );
        let filtered =
            generation_chunk_page(&connection, "gen-1", "resolved", Some(window), None, 10)
                .unwrap();
        assert_eq!(
            filtered
                .iter()
                .map(|row| (row.chunk_y, row.chunk_x))
                .collect::<Vec<_>>(),
            vec![(0, 0), (1, 0)],
            "only intersecting records load"
        );
        // Negative coordinates stay exact: cells -1..0 touch chunk -1 only.
        let negative = ChunkWindow::for_cells(-1, 0, 0, 1, 1024).unwrap();
        assert_eq!(
            (
                negative.min_x,
                negative.max_x,
                negative.min_y,
                negative.max_y
            ),
            (-1, -1, 0, 0)
        );
        assert!(
            generation_chunk_page(&connection, "gen-1", "resolved", Some(negative), None, 10)
                .unwrap()
                .is_empty()
        );
        // The index carries the read order, so paging needs no sort step.
        let plan: String = connection
            .query_row(
                "EXPLAIN QUERY PLAN SELECT g.chunk_x, g.chunk_y
                 FROM lidar_generation_chunks g
                 WHERE g.generation_id = 'gen-1' AND g.role = 'resolved'
                   AND g.state = 'published'
                 ORDER BY g.chunk_y, g.chunk_x LIMIT 2",
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(
            !plan.contains("TEMP B-TREE"),
            "the paged read order must come from the index: {plan}"
        );
        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }
}
