//! Registered analyses: offers, definitions, runs, publication and freshness.
//!
//! What an analysis is comes from the generated registry
//! (`common-types/analysis-registry.json`); how it runs is a handwritten
//! executor per registry entry. A definition binds an analysis to library
//! items with resolved parameters and owns one derived item per selected
//! output. Every run is a job pinned to its inputs' current generations; it
//! computes without catalogue locks, stages unpublished chunks and publishes
//! all outputs in one transaction, upserting each item's head. A refresh is a
//! new run of the same definition: items keep their ids, the superseded
//! generation's chunks are revoked, and the job stays as processing history.

mod terrain;
mod windowed;

use super::LidarLibrary;
use super::analysis_registry_generated::ANALYSIS_REGISTRY;
use super::catalogue::{self, new_id, now_iso};
use super::geolibre::GeolibreTool;
use super::grid::RasterGrid;
use common_types::analysis_registry::{
    AnalysisDefinition, AnalysisInputSpec, AnalysisLane, AnalysisOutputSpec, GridRequirement,
};
use common_types::library::{
    AnalysisJobState, AnalysisOffer, AnalysisParamValue, AnalysisReceipt, AnalysisRequest,
    AnalysisUnavailable, Freshness, LibraryItemType, ProvenanceInput, RasterQuantity, StaleReason,
    ToolProvenance,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// A projected CRS in ground metres.
pub(crate) const CRS_PROJECTED_METRE: &str = "projected-metre";
/// A projected CRS whose metres are not ground metres (Web Mercator).
pub(crate) const CRS_PROJECTED_OTHER: &str = "projected-other";
pub(crate) const CRS_GEOGRAPHIC: &str = "geographic";
const CRS_UNKNOWN: &str = "unknown";

/// Classify a stored CRS reference (`EPSG:n`) for offers, from its table row.
///
/// Import records the class of the reference the raster engine reported, so
/// offers are computed from the catalogue on every poll without a raster
/// read; the class comes from the same table row the engine reads.
pub(crate) fn crs_class(reference: &str) -> &'static str {
    match super::rust_engine::crs_kind(reference) {
        Some(super::rust_engine::CrsKind::ProjectedMetre) => CRS_PROJECTED_METRE,
        Some(super::rust_engine::CrsKind::ProjectedOther) => CRS_PROJECTED_OTHER,
        Some(super::rust_engine::CrsKind::Geographic) => CRS_GEOGRAPHIC,
        None => CRS_UNKNOWN,
    }
}

/// Whether a unit label names metres.
pub(crate) fn values_in_metres(units: &str) -> bool {
    matches!(
        units.trim().to_ascii_lowercase().as_str(),
        "m" | "metre" | "meter" | "metres" | "meters"
    )
}

/// The registered analysis with this id.
pub(crate) fn definition(analysis_id: &str) -> Option<&'static AnalysisDefinition> {
    ANALYSIS_REGISTRY
        .iter()
        .find(|definition| definition.id == analysis_id)
}

/// What one run publishes for one output: unpublished chunk rows under a
/// pre-assigned generation id, and the facts its generation row records.
pub(crate) struct StagedRaster {
    pub output_key: &'static str,
    pub generation_id: String,
    pub grid: RasterGrid,
    pub crs_ref: String,
    pub crs_class: String,
    pub bounds_3857: String,
    pub coverage_cells: u64,
    pub value_range: Option<(f64, f64)>,
}

/// Everything an executor produced, and the tool that produced it.
pub(crate) struct ExecutorOutcome {
    pub outputs: Vec<StagedRaster>,
    pub tool: ToolProvenance,
}

/// One input as its run pinned it.
pub(crate) struct PinnedInput {
    pub key: String,
    pub item_id: String,
    pub generation_id: String,
    pub units: String,
}

/// What an executor may read and where it may write.
pub(crate) struct RunContext<'a> {
    pub library: &'a LidarLibrary,
    pub analysis: &'static AnalysisDefinition,
    pub parameters: &'a [AnalysisParamValue],
    pub outputs: &'a [&'static AnalysisOutputSpec],
    pub inputs: &'a [PinnedInput],
    /// Job-owned scratch, removed when the run settles.
    pub scratch: &'a Path,
    pub cancel: &'a AtomicBool,
}

impl RunContext<'_> {
    pub(crate) fn input(&self, key: &str) -> Result<&PinnedInput, String> {
        self.inputs
            .iter()
            .find(|input| input.key == key)
            .ok_or_else(|| format!("{} has no input '{key}'", self.analysis.id))
    }

    pub(crate) fn input_spec(&self, key: &str) -> Result<&'static AnalysisInputSpec, String> {
        self.analysis
            .inputs
            .iter()
            .find(|input| input.key == key)
            .ok_or_else(|| format!("{} has no input '{key}'", self.analysis.id))
    }

    /// The selected output with this key.
    pub(crate) fn output(&self, key: &str) -> Result<&'static AnalysisOutputSpec, String> {
        self.outputs
            .iter()
            .copied()
            .find(|output| output.key == key)
            .ok_or_else(|| format!("{} does not produce '{key}' in this run", self.analysis.id))
    }
}

/// How one registered analysis runs.
pub(crate) trait AnalysisExecutor: Sync {
    fn analysis_id(&self) -> &'static str;
    fn run(&self, context: &RunContext<'_>) -> Result<ExecutorOutcome, String>;
}

static EXECUTORS: &[&dyn AnalysisExecutor] = &[&terrain::SLOPE];

/// The executor of one registered analysis.
pub(crate) fn executor(analysis_id: &str) -> Option<&'static dyn AnalysisExecutor> {
    EXECUTORS
        .iter()
        .copied()
        .find(|executor| executor.analysis_id() == analysis_id)
}

/// The storage of one derived generation; provenance lives in the catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DerivedManifest {
    pub item_id: String,
    pub output_key: String,
    pub grid: RasterGrid,
    /// CRS of the lattice, so the item can be sampled without its input.
    pub crs_ref: String,
    /// `chunks`: sparse result and quality chunks.
    pub storage: String,
}

pub(crate) fn read_derived_manifest(json: &str) -> Result<DerivedManifest, String> {
    serde_json::from_str(json).map_err(|e| format!("Invalid derived item manifest: {e}"))
}

// ---------------------------------------------------------------------------
// Items as analysis inputs
// ---------------------------------------------------------------------------

/// The facts offers and input checks read about one library item.
pub(crate) struct ItemFacts {
    pub item_type: LibraryItemType,
    pub units: String,
    /// Current generation and its CRS class.
    pub head: Option<(String, String)>,
}

/// Read one item's facts, whichever role it has.
pub(crate) fn item_facts(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<ItemFacts>, String> {
    if let Some(layer) = catalogue::get_layer(connection, item_id)? {
        let quantity = parse_quantity(&layer.quantity)?;
        let head =
            catalogue::head_generation(connection, item_id)?.map(|head| (head.id, head.crs_class));
        return Ok(Some(ItemFacts {
            item_type: LibraryItemType::Raster { quantity },
            units: layer.units,
            head,
        }));
    }
    if let Some(item) = catalogue::get_derived_item(connection, item_id)? {
        let quantity = parse_quantity(&item.quantity)?;
        let head =
            catalogue::derived_head(connection, item_id)?.map(|head| (head.id, head.crs_class));
        return Ok(Some(ItemFacts {
            item_type: LibraryItemType::Raster { quantity },
            units: item.units,
            head,
        }));
    }
    Ok(None)
}

pub(crate) fn parse_quantity(key: &str) -> Result<RasterQuantity, String> {
    RasterQuantity::from_key(key)
        .ok_or_else(|| format!("the library records an unknown quantity '{key}'"))
}

/// Why `spec` cannot take this item, or `None` when it can. The engine is
/// checked only when `engine` is given.
pub(crate) fn input_unavailable(
    analysis: &AnalysisDefinition,
    spec: &AnalysisInputSpec,
    facts: &ItemFacts,
    engine: Option<&Result<GeolibreTool, String>>,
) -> Option<AnalysisUnavailable> {
    if !spec.accepts.contains(&facts.item_type) {
        return Some(AnalysisUnavailable::WrongInput {
            expected: spec.accepts.to_vec(),
        });
    }
    let Some((_, crs_class)) = &facts.head else {
        return Some(AnalysisUnavailable::NotReady);
    };
    for requirement in spec.requires {
        match requirement {
            GridRequirement::MetreValues if !values_in_metres(&facts.units) => {
                return Some(AnalysisUnavailable::ValuesNotMetres {
                    units: facts.units.clone(),
                });
            }
            GridRequirement::ProjectedMetreGrid if crs_class != CRS_PROJECTED_METRE => {
                return Some(AnalysisUnavailable::GridNotProjectedMetres);
            }
            _ => {}
        }
    }
    match (analysis.lane, engine) {
        (AnalysisLane::GeolibreWindowed { .. }, Some(Err(detail))) => {
            Some(AnalysisUnavailable::EngineMissing {
                detail: detail.clone(),
            })
        }
        _ => None,
    }
}

/// Every registered analysis, with whether this item can feed its first input.
pub(crate) fn offers(
    facts: &ItemFacts,
    engine: &Result<GeolibreTool, String>,
) -> Vec<AnalysisOffer> {
    ANALYSIS_REGISTRY
        .iter()
        .map(|analysis| AnalysisOffer {
            analysis_id: analysis.id.to_string(),
            unavailable: analysis
                .inputs
                .first()
                .and_then(|spec| input_unavailable(analysis, spec, facts, Some(engine))),
        })
        .collect()
}

/// A refusal message naming why an input cannot be used.
fn unavailable_message(key: &str, reason: &AnalysisUnavailable) -> String {
    match reason {
        AnalysisUnavailable::WrongInput { expected } => {
            let names: Vec<&str> = expected
                .iter()
                .map(|item| match item {
                    LibraryItemType::Raster { quantity } => quantity.key(),
                })
                .collect();
            format!("input '{key}' must be {}", names.join(" or "))
        }
        AnalysisUnavailable::NotReady => format!("input '{key}' has no published data yet"),
        AnalysisUnavailable::ValuesNotMetres { units } => {
            format!("input '{key}' must hold values in metres; it reports '{units}'")
        }
        AnalysisUnavailable::GridNotProjectedMetres => {
            format!(
                "input '{key}' must be on a projected grid in ground metres, \
                 not Web Mercator or longitude and latitude"
            )
        }
        AnalysisUnavailable::EngineMissing { detail } => detail.clone(),
    }
}

/// Bind every input of `analysis` to its item and current generation.
fn pin_inputs(
    connection: &Connection,
    analysis: &AnalysisDefinition,
    bindings: &[(String, String)],
    engine: Option<&Result<GeolibreTool, String>>,
) -> Result<Vec<ProvenanceInput>, String> {
    for (index, (key, _)) in bindings.iter().enumerate() {
        if !analysis.inputs.iter().any(|spec| spec.key == key) {
            return Err(format!("{} has no input '{key}'", analysis.id));
        }
        if bindings[..index].iter().any(|(earlier, _)| earlier == key) {
            return Err(format!("input '{key}' is given twice"));
        }
    }
    analysis
        .inputs
        .iter()
        .map(|spec| {
            let (_, item_id) = bindings
                .iter()
                .find(|(key, _)| key == spec.key)
                .ok_or_else(|| format!("choose an item for input '{}'", spec.key))?;
            let facts = item_facts(connection, item_id)?
                .ok_or_else(|| format!("input '{}': item {item_id} does not exist", spec.key))?;
            if let Some(reason) = input_unavailable(analysis, spec, &facts, engine) {
                return Err(unavailable_message(spec.key, &reason));
            }
            let (generation_id, _) = facts
                .head
                .ok_or_else(|| format!("input '{}' has no published data yet", spec.key))?;
            Ok(ProvenanceInput {
                key: spec.key.to_string(),
                item_id: item_id.clone(),
                generation_id,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Definitions and jobs
// ---------------------------------------------------------------------------

/// Record a new definition, its inputs, one derived item per output and its
/// first job pinned to the inputs' current generations, in one transaction.
///
/// `engine` is checked when given; the job is recorded `preparing` and the
/// caller starts it.
pub(crate) fn record_definition(
    connection: &Connection,
    request: &AnalysisRequest,
    engine: Option<&Result<GeolibreTool, String>>,
) -> Result<AnalysisReceipt, String> {
    let analysis = definition(&request.analysis_id)
        .ok_or_else(|| format!("there is no analysis '{}'", request.analysis_id))?;
    let parameters =
        common_types::analysis_registry::resolve_parameters(analysis, &request.parameters)?;
    let outputs = common_types::analysis_registry::resolve_outputs(analysis, &request.outputs)?;
    let bindings: Vec<(String, String)> = request
        .inputs
        .iter()
        .map(|binding| (binding.key.clone(), binding.item_id.clone()))
        .collect();
    let pinned = pin_inputs(connection, analysis, &bindings, engine)?;
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let now = now_iso();
    let definition_id = new_id("adef");
    let job_id = new_id("anl");
    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| format!("Failed to start the analysis record: {e}"))?;
    transaction
        .execute(
            "INSERT INTO lidar_analysis_definitions(id, analysis_id, parameters_json, outputs_json, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                definition_id,
                analysis.id,
                serde_json::to_string(&parameters).map_err(|e| e.to_string())?,
                serde_json::to_string(
                    &outputs.iter().map(|output| output.key).collect::<Vec<_>>()
                )
                .map_err(|e| e.to_string())?,
                now,
            ],
        )
        .map_err(|e| format!("Failed to record the analysis: {e}"))?;
    for input in &pinned {
        transaction
            .execute(
                "INSERT INTO lidar_analysis_inputs(definition_id, input_key, item_id)
                 VALUES(?1, ?2, ?3)",
                rusqlite::params![definition_id, input.key, input.item_id],
            )
            .map_err(|e| format!("Failed to record the analysis inputs: {e}"))?;
    }
    let mut item_ids = Vec::with_capacity(outputs.len());
    for output in &outputs {
        let item_id = new_id("item");
        let LibraryItemType::Raster { quantity } = output.item;
        let units = common_types::analysis_registry::output_units(output, &parameters)?;
        transaction
            .execute(
                "INSERT INTO lidar_derived_items(id, definition_id, output_key, item_kind, quantity, units, name, created_at)
                 VALUES(?1, ?2, ?3, 'raster', ?4, ?5, ?6, ?7)",
                rusqlite::params![item_id, definition_id, output.key, quantity.key(), units, name, now],
            )
            .map_err(|e| format!("Failed to record the analysis results: {e}"))?;
        item_ids.push(item_id);
    }
    insert_job(
        &transaction,
        &job_id,
        &definition_id,
        analysis.version,
        &pinned,
    )?;
    transaction
        .commit()
        .map_err(|e| format!("Failed to record the analysis: {e}"))?;
    Ok(AnalysisReceipt {
        definition_id,
        job_id,
        item_ids,
    })
}

fn insert_job(
    connection: &Connection,
    job_id: &str,
    definition_id: &str,
    recipe_version: u32,
    pinned: &[ProvenanceInput],
) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "INSERT INTO lidar_analysis_jobs(id, definition_id, state, recipe_version, input_generations_json, created_at, updated_at)
             VALUES(?1, ?2, 'preparing', ?3, ?4, ?5, ?5)",
            rusqlite::params![
                job_id,
                definition_id,
                recipe_version,
                serde_json::to_string(pinned).map_err(|e| e.to_string())?,
                now,
            ],
        )
        .map_err(|e| format!("Failed to enqueue the analysis: {e}"))?;
    Ok(())
}

/// Record a new run of an existing definition: Retry when it has no result
/// yet, Refresh when it has one.
///
/// The stored parameters are revalidated against the current recipe and the
/// inputs pinned to their current generations; settings the recipe no longer
/// accepts, a missing input and a run already in progress are refused by name.
pub(crate) fn record_rerun(
    connection: &Connection,
    definition_id: &str,
    engine: Option<&Result<GeolibreTool, String>>,
) -> Result<AnalysisReceipt, String> {
    let row = catalogue::get_definition(connection, definition_id)?
        .ok_or_else(|| format!("Analysis {definition_id} does not exist"))?;
    let analysis = definition(&row.analysis_id).ok_or_else(|| {
        format!(
            "the analysis '{}' is no longer available in this version of Canopi",
            row.analysis_id
        )
    })?;
    if catalogue::latest_analysis_job(connection, definition_id)?
        .is_some_and(|job| job.state == "preparing")
    {
        return Err("this analysis is already running".to_string());
    }
    let stored = parse_parameters(&row.parameters_json)?;
    common_types::analysis_registry::resolve_parameters(analysis, &stored).map_err(|error| {
        format!("the saved settings are no longer valid ({error}); run a new analysis")
    })?;
    let bindings: Vec<(String, String)> = catalogue::definition_inputs(connection, definition_id)?
        .into_iter()
        .map(|input| (input.input_key, input.item_id))
        .collect();
    let pinned = pin_inputs(connection, analysis, &bindings, engine)?;
    let item_ids = catalogue::definition_items(connection, definition_id)?
        .into_iter()
        .map(|item| item.id)
        .collect();
    let job_id = new_id("anl");
    insert_job(
        connection,
        &job_id,
        definition_id,
        analysis.version,
        &pinned,
    )?;
    Ok(AnalysisReceipt {
        definition_id: definition_id.to_string(),
        job_id,
        item_ids,
    })
}

pub(crate) fn parse_parameters(json: &str) -> Result<Vec<AnalysisParamValue>, String> {
    serde_json::from_str(json)
        .map_err(|e| format!("the saved analysis settings are unreadable: {e}"))
}

pub(crate) fn parse_pinned_inputs(json: &str) -> Result<Vec<ProvenanceInput>, String> {
    serde_json::from_str(json).map_err(|e| format!("the saved run inputs are unreadable: {e}"))
}

pub(crate) fn parse_tool(json: Option<&str>) -> Option<ToolProvenance> {
    json.and_then(|json| serde_json::from_str(json).ok())
}

pub(crate) fn parse_job_state(raw: &str) -> AnalysisJobState {
    match raw {
        "complete" => AnalysisJobState::Complete,
        "cancelled" => AnalysisJobState::Cancelled,
        "preparing" => AnalysisJobState::Preparing,
        _ => AnalysisJobState::Failed,
    }
}

/// A published run, for logs.
#[derive(Debug)]
pub(crate) struct RunOutcome {
    pub coverage_cells: u64,
    pub outputs: usize,
}

impl RunOutcome {
    pub(crate) fn summary(&self) -> String {
        format!(
            "{} output(s) published, {} cells",
            self.outputs, self.coverage_cells
        )
    }
}

/// Run one recorded job to publication. Every other ending is an error and
/// publishes nothing; `"cancelled"` means the job was cancelled.
pub(crate) fn run_job(
    library: &LidarLibrary,
    job_id: &str,
    cancel: &AtomicBool,
) -> Result<RunOutcome, String> {
    // Short read: the job, its definition and pinned inputs.
    let (job, analysis, parameters, outputs, inputs) = {
        let connection = library.catalogue()?;
        let job = catalogue::get_analysis_job(&connection, job_id)?
            .ok_or_else(|| format!("analysis job {job_id} no longer exists"))?;
        let row = catalogue::get_definition(&connection, &job.definition_id)?
            .ok_or_else(|| format!("analysis {} no longer exists", job.definition_id))?;
        let analysis = definition(&row.analysis_id).ok_or_else(|| {
            format!(
                "the analysis '{}' is not available in this version of Canopi",
                row.analysis_id
            )
        })?;
        // The recipe the job pinned decides the method; an unknown one fails
        // here, before any input is read, and published data stays as it is.
        if job.recipe_version != i64::from(analysis.version) {
            return Err(format!(
                "recipe version {} of {} is not supported by this version of Canopi",
                job.recipe_version, analysis.id
            ));
        }
        let parameters = common_types::analysis_registry::resolve_parameters(
            analysis,
            &parse_parameters(&row.parameters_json)?,
        )?;
        let selected: Vec<String> = serde_json::from_str(&row.outputs_json)
            .map_err(|e| format!("the saved analysis outputs are unreadable: {e}"))?;
        let outputs = common_types::analysis_registry::resolve_outputs(analysis, &selected)?;
        let inputs = parse_pinned_inputs(&job.input_generations_json)?
            .into_iter()
            .map(|input| {
                let facts = item_facts(&connection, &input.item_id)?
                    .ok_or_else(|| format!("input '{}' was deleted before the run", input.key))?;
                Ok(PinnedInput {
                    key: input.key,
                    item_id: input.item_id,
                    generation_id: input.generation_id,
                    units: facts.units,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        (job, analysis, parameters, outputs, inputs)
    };
    let executor = executor(analysis.id)
        .ok_or_else(|| format!("{} has no executor in this build", analysis.id))?;
    let scratch = library.inner.paths.analysis_scratch_dir(job_id);
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("Failed to create analysis scratch: {e}"))?;
    let context = RunContext {
        library,
        analysis,
        parameters: &parameters,
        outputs: &outputs,
        inputs: &inputs,
        scratch: &scratch,
        cancel,
    };
    let result = executor.run(&context).and_then(|outcome| {
        let staged: Vec<String> = outcome
            .outputs
            .iter()
            .map(|output| output.generation_id.clone())
            .collect();
        let published = publish(library, &job, &inputs, &outcome);
        if published.is_err()
            && let Ok(connection) = library.catalogue()
        {
            for generation_id in &staged {
                let _ =
                    catalogue::discard_unpublished_generation_chunks(&connection, generation_id);
            }
        }
        published.map(|()| RunOutcome {
            coverage_cells: outcome
                .outputs
                .iter()
                .map(|output| output.coverage_cells)
                .sum(),
            outputs: outcome.outputs.len(),
        })
    });
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// Publish every staged output of one run atomically.
///
/// The job must still be preparing, the definition and each output item must
/// still exist, and every input must still be at the generation the run was
/// pinned to. Each item's head is upserted and the superseded generation's
/// chunk rows are revoked (the startup sweep removes their files); the
/// superseded generation row stays for the processing history.
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn publish(
    library: &LidarLibrary,
    job: &catalogue::AnalysisJobRow,
    inputs: &[PinnedInput],
    outcome: &ExecutorOutcome,
) -> Result<(), String> {
    let connection = library.catalogue()?;
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let publish = (|| -> Result<(), String> {
        let state: String = connection
            .query_row(
                "SELECT state FROM lidar_analysis_jobs WHERE id = ?1",
                [&job.id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if state != "preparing" {
            return Err(if state == "cancelled" {
                "cancelled".to_string()
            } else {
                format!("analysis job cannot publish from state {state}")
            });
        }
        if catalogue::get_definition(&connection, &job.definition_id)?.is_none() {
            return Err(format!(
                "analysis {} was deleted during the calculation",
                job.definition_id
            ));
        }
        for input in inputs {
            let current = catalogue::item_head_generation_id(&connection, &input.item_id)?;
            if current.as_deref() != Some(input.generation_id.as_str()) {
                return Err(format!(
                    "input '{}' changed during the calculation; refresh to use its current data",
                    input.key
                ));
            }
        }
        let now = now_iso();
        for output in &outcome.outputs {
            let item_id: String = connection
                .query_row(
                    "SELECT id FROM lidar_derived_items WHERE definition_id = ?1 AND output_key = ?2",
                    rusqlite::params![job.definition_id, output.output_key],
                    |row| row.get(0),
                )
                .map_err(|_| {
                    format!(
                        "the result '{}' was deleted during the calculation",
                        output.output_key
                    )
                })?;
            let manifest = DerivedManifest {
                item_id: item_id.clone(),
                output_key: output.output_key.to_string(),
                grid: output.grid.clone(),
                crs_ref: output.crs_ref.clone(),
                storage: "chunks".to_string(),
            };
            let (min_value, max_value) = output.value_range.unzip();
            connection
                .execute(
                    "INSERT INTO lidar_derived_generations(id, item_id, job_id, manifest_json, coverage_cells, min_value, max_value, bounds_3857, crs_class, published_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    rusqlite::params![
                        output.generation_id,
                        item_id,
                        job.id,
                        serde_json::to_string(&manifest).map_err(|e| e.to_string())?,
                        i64::try_from(output.coverage_cells).unwrap_or(i64::MAX),
                        min_value,
                        max_value,
                        output.bounds_3857,
                        output.crs_class,
                        now,
                    ],
                )
                .map_err(|e| e.to_string())?;
            catalogue::publish_generation_chunks(&connection, &output.generation_id)?;
            if let Some(previous) = catalogue::derived_head(&connection, &item_id)? {
                connection
                    .execute(
                        "DELETE FROM lidar_generation_chunks WHERE generation_id = ?1",
                        [&previous.id],
                    )
                    .map_err(|e| e.to_string())?;
            }
            connection
                .execute(
                    "INSERT INTO lidar_derived_heads(item_id, generation_id) VALUES(?1, ?2)
                     ON CONFLICT(item_id) DO UPDATE SET generation_id = excluded.generation_id",
                    rusqlite::params![item_id, output.generation_id],
                )
                .map_err(|e| e.to_string())?;
        }
        connection
            .execute(
                "UPDATE lidar_analysis_jobs
                 SET state = 'complete', message = NULL, tool_provenance = ?2,
                     finished_at = ?3, updated_at = ?3
                 WHERE id = ?1",
                rusqlite::params![
                    job.id,
                    serde_json::to_string(&outcome.tool).map_err(|e| e.to_string())?,
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    match publish {
        Ok(()) => connection.execute_batch("COMMIT").map_err(|e| {
            // A COMMIT refused under contention leaves the transaction open on
            // the library's only connection; end it so later work can begin.
            let _ = connection.execute_batch("ROLLBACK");
            e.to_string()
        }),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Settle a job that ended without publishing. A cancel keeps no message:
/// the state is the status, which the UI words; a failure keeps its reason.
pub(crate) fn settle_unpublished(connection: &Connection, job_id: &str, error: &str) {
    let (state, message) = if error == "cancelled" {
        ("cancelled", None)
    } else {
        ("failed", Some(error))
    };
    let now = now_iso();
    let _ = connection.execute(
        "UPDATE lidar_analysis_jobs SET state = ?2, message = ?3, finished_at = ?4, updated_at = ?4
         WHERE id = ?1 AND state = 'preparing'",
        rusqlite::params![job_id, state, message, now],
    );
}

/// Startup recovery: jobs interrupted by a restart fail explicitly so the UI
/// never reports ghost activity; published data is unaffected, and nothing is
/// recalculated because the app reopened. They keep no message: the UI words
/// the failed state.
pub(crate) fn recover_interrupted_jobs(connection: &Connection) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE lidar_import_jobs SET state = 'failed', message = NULL,
             updated_at = ?1 WHERE state IN ('staging', 'applying')",
            [&now],
        )
        .map_err(|e| format!("Failed to recover import jobs: {e}"))?;
    connection
        .execute(
            "UPDATE lidar_analysis_jobs SET state = 'failed', message = NULL,
             finished_at = ?1, updated_at = ?1 WHERE state = 'preparing'",
            [&now],
        )
        .map_err(|e| format!("Failed to recover analysis jobs: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/// Compare what produced derived items with what exists now.
///
/// Catalogue reads only, memoised per item, so a chain is walked once: an
/// input whose head moved is `InputUpdated`, an input that is itself stale is
/// `InputStale`, a newer registry recipe is `RecipeUpdated` and a different
/// engine build is `ToolUpdated`.
pub(crate) struct FreshnessCheck<'a> {
    connection: &'a Connection,
    engine: Option<ToolProvenance>,
    memo: HashMap<String, Freshness>,
}

impl<'a> FreshnessCheck<'a> {
    pub(crate) fn new(connection: &'a Connection, engine: &Result<GeolibreTool, String>) -> Self {
        Self {
            connection,
            engine: engine.as_ref().ok().map(|tool| tool.provenance(Vec::new())),
            memo: HashMap::new(),
        }
    }

    /// The freshness of one derived item; a source is always current.
    pub(crate) fn of(&mut self, item_id: &str) -> Result<Freshness, String> {
        if let Some(known) = self.memo.get(item_id) {
            return Ok(known.clone());
        }
        // Inputs always exist before the definitions that use them, so the
        // walk ends; the placeholder guards a damaged catalogue.
        self.memo.insert(item_id.to_string(), Freshness::Current);
        let freshness = self.compute(item_id)?;
        self.memo.insert(item_id.to_string(), freshness.clone());
        Ok(freshness)
    }

    fn compute(&mut self, item_id: &str) -> Result<Freshness, String> {
        let Some(item) = catalogue::get_derived_item(self.connection, item_id)? else {
            return Ok(Freshness::Current);
        };
        let Some(head) = catalogue::derived_head(self.connection, item_id)? else {
            return Ok(Freshness::Current);
        };
        let Some(job) = catalogue::get_analysis_job(self.connection, &head.job_id)? else {
            return Ok(Freshness::Current);
        };
        let mut reasons = Vec::new();
        for input in parse_pinned_inputs(&job.input_generations_json)? {
            let current = catalogue::item_head_generation_id(self.connection, &input.item_id)?;
            if current.as_deref() != Some(input.generation_id.as_str()) {
                reasons.push(StaleReason::InputUpdated {
                    input_key: input.key,
                    item_id: input.item_id,
                });
            } else if matches!(self.of(&input.item_id)?, Freshness::Stale { .. }) {
                reasons.push(StaleReason::InputStale {
                    input_key: input.key,
                    item_id: input.item_id,
                });
            }
        }
        let analysis_id = catalogue::get_definition(self.connection, &item.definition_id)?
            .map(|row| row.analysis_id);
        if let Some(analysis) = analysis_id.as_deref().and_then(definition) {
            let ran = u32::try_from(job.recipe_version).unwrap_or(0);
            if ran != analysis.version {
                reasons.push(StaleReason::RecipeUpdated {
                    from: ran,
                    to: analysis.version,
                });
            }
        }
        if let (Some(ran), Some(installed)) =
            (parse_tool(job.tool_provenance.as_deref()), &self.engine)
            && (ran.version != installed.version || ran.revision != installed.revision)
        {
            reasons.push(StaleReason::ToolUpdated {
                from: tool_label(&ran),
                to: tool_label(installed),
            });
        }
        Ok(if reasons.is_empty() {
            Freshness::Current
        } else {
            Freshness::Stale { reasons }
        })
    }
}

/// `geolibre-cli 1.5.3 (aac2b743978)`.
pub(crate) fn tool_label(tool: &ToolProvenance) -> String {
    let revision: String = tool.revision.chars().take(11).collect();
    format!("{} ({revision})", tool.version)
}

/// Test support: slope requests and catalogue rows of published results.
#[cfg(test)]
pub(crate) mod test_support {
    use super::super::LidarLibrary;
    use common_types::library::{
        AnalysisInputBinding, AnalysisParamValue, AnalysisReceipt, AnalysisRequest, ParamValue,
    };
    use rusqlite::Connection;

    /// A `terrain.slope` request over one source.
    pub(crate) fn slope_request(source: &str, unit: &str, name: Option<&str>) -> AnalysisRequest {
        AnalysisRequest {
            analysis_id: "terrain.slope".to_string(),
            inputs: vec![AnalysisInputBinding {
                key: "dem".to_string(),
                item_id: source.to_string(),
            }],
            parameters: vec![AnalysisParamValue {
                key: "unit".to_string(),
                value: ParamValue::Choice(unit.to_string()),
            }],
            outputs: vec!["slope".to_string()],
            name: name.map(str::to_string),
        }
    }

    /// Record a definition without the engine check and without starting it.
    pub(crate) fn record(library: &LidarLibrary, request: &AnalysisRequest) -> AnalysisReceipt {
        super::record_definition(&library.catalogue().unwrap(), request, None)
            .expect("the definition is recorded")
    }

    /// Record a slope over `source` and run its job synchronously.
    pub(crate) fn run_slope(
        library: &LidarLibrary,
        source: &str,
        unit: &str,
        name: Option<&str>,
    ) -> AnalysisReceipt {
        let receipt = record(library, &slope_request(source, unit, name));
        let outcome = super::run_job(
            library,
            &receipt.job_id,
            &std::sync::atomic::AtomicBool::new(false),
        )
        .expect("the slope job runs");
        assert!(outcome.coverage_cells > 0, "{}", outcome.summary());
        receipt
    }

    /// A completed `terrain.slope@1` run over `source_layer_id`: definition,
    /// input, degrees item named `name`, job `<definition_id>-job` pinned to
    /// `source_generation_id`, and a published generation as the item's head.
    pub(crate) fn seed_published_slope(
        connection: &Connection,
        source_layer_id: &str,
        source_generation_id: &str,
        definition_id: &str,
        item_id: &str,
        generation_id: &str,
        name: Option<&str>,
    ) {
        let job_id = format!("{definition_id}-job");
        let pinned = format!(
            r#"[{{"key":"dem","item_id":"{source_layer_id}","generation_id":"{source_generation_id}"}}]"#
        );
        let manifest = format!(
            r#"{{"item_id":"{item_id}","output_key":"slope","grid":{{"width":1024,"height":1024,"geotransform":[0.0,1.0,0.0,0.0,0.0,-1.0]}},"crs_ref":"EPSG:32631","storage":"chunks"}}"#
        );
        let tool = r#"{"engine":"geolibre","version":"geolibre-cli 1.5.3","revision":"aac2b743978666f3c3119b5c93de1b30963b1493","tools":["slope"]}"#;
        connection
            .execute(
                "INSERT INTO lidar_analysis_definitions(id, analysis_id, parameters_json, outputs_json, created_at)
                 VALUES(?1, 'terrain.slope', '[{\"key\":\"unit\",\"value\":{\"Choice\":\"degrees\"}}]', '[\"slope\"]', '1')",
                [definition_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO lidar_analysis_inputs(definition_id, input_key, item_id) VALUES(?1, 'dem', ?2)",
                [definition_id, source_layer_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO lidar_derived_items(id, definition_id, output_key, item_kind, quantity, units, name, created_at)
                 VALUES(?1, ?2, 'slope', 'raster', 'slope', '°', ?3, '1')",
                rusqlite::params![item_id, definition_id, name],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO lidar_analysis_jobs(id, definition_id, state, recipe_version, input_generations_json, tool_provenance, created_at, finished_at, updated_at)
                 VALUES(?1, ?2, 'complete', 1, ?3, ?4, '1', '2', '2')",
                rusqlite::params![job_id, definition_id, pinned, tool],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO lidar_derived_generations(id, item_id, job_id, manifest_json, coverage_cells, min_value, max_value, bounds_3857, crs_class, published_at)
                 VALUES(?1, ?2, ?3, ?4, 32, 1, 2, '[0,0,1,1]', 'projected-metre', '2')",
                rusqlite::params![generation_id, item_id, job_id, manifest],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO lidar_derived_heads(item_id, generation_id) VALUES(?1, ?2)",
                [item_id, generation_id],
            )
            .unwrap();
    }
}

#[cfg(test)]
mod tests;
