//! The catalogue's row types, as its queries read them.

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
