//! Typed library items, analysis requests and provenance (ADR 0011).
//!
//! Every Data Library item has a role (imported source or derived result) and
//! an item type; layers, legends and value readouts dispatch on the type and
//! nothing assumes an elevation raster. A derived item records what produced
//! it: its analysis, recipe version, inputs and their generations, parameters
//! and the tool that ran. The analyses themselves are declared in the authored
//! `canopi-types/analysis-registry.json`, generated into Rust and TypeScript.

use crate::lidar::{LidarDisplayRange, LidarEngineStatus, LidarImportJob, LidarResultState};
use serde::{Deserialize, Serialize};
use specta::Type;

/// What the samples of a raster item measure.
///
/// Imported sources declare one of the importable quantities; derived results
/// carry the quantity their analysis output produces. Never inferred from a
/// filename or a value range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum RasterQuantity {
    /// Bare-earth elevation (MNT/DTM).
    GroundElevation,
    /// Top surface including vegetation and buildings (MNS/DSM).
    SurfaceElevation,
    /// Height relative to compatible terrain (MNH).
    AboveGroundHeight,
    /// User-described continuous numeric value; numeric display only.
    OtherContinuous,
    /// Terrain slope, in degrees or percent (derived only).
    Slope,
}

impl RasterQuantity {
    /// Every quantity, in declaration order.
    pub const ALL: [Self; 5] = [
        Self::GroundElevation,
        Self::SurfaceElevation,
        Self::AboveGroundHeight,
        Self::OtherContinuous,
        Self::Slope,
    ];

    /// The stable catalogue and registry key.
    pub const fn key(self) -> &'static str {
        match self {
            Self::GroundElevation => "ground-elevation",
            Self::SurfaceElevation => "surface-elevation",
            Self::AboveGroundHeight => "above-ground-height",
            Self::OtherContinuous => "other-continuous",
            Self::Slope => "slope",
        }
    }

    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|quantity| quantity.key() == key)
    }

    /// The contract spelling, as TypeScript sees it.
    pub const fn variant_name(self) -> &'static str {
        match self {
            Self::GroundElevation => "GroundElevation",
            Self::SurfaceElevation => "SurfaceElevation",
            Self::AboveGroundHeight => "AboveGroundHeight",
            Self::OtherContinuous => "OtherContinuous",
            Self::Slope => "Slope",
        }
    }

    /// Whether a user may import files declaring this quantity. Derived
    /// quantities only ever come from an analysis.
    pub const fn is_importable(self) -> bool {
        matches!(
            self,
            Self::GroundElevation
                | Self::SurfaceElevation
                | Self::AboveGroundHeight
                | Self::OtherContinuous
        )
    }
}

/// The type of one library item.
///
/// Point clouds and vector results join this union with the analyses that
/// produce them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(tag = "kind")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum LibraryItemType {
    Raster { quantity: RasterQuantity },
}

// Whether an item was imported or produced by an analysis; also the kind a
// Design's Site data entry stores (the schema decoder takes no doc comments).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum LibraryItemRole {
    Source,
    Derived,
}

// Catalogue 26's stored enums (contracts §7 Stored enums and §8; 2.1-M488). Each has one `literal()`, its
// stored spelling in the catalogue column, the CHECK and the wire, and an `ALL` table the catalogue steps
// generate their CHECK text from. The frozen `catalogue-26.sql` lists these literals verbatim, and a test in
// `services/lidar/catalogue.rs` holds every frozen literal to `ALL`, so a literal is never removed or respelled.
// Parsing a stored literal belongs to the library's one row decoder; these types offer no parse.

/// The kind of one Data library item, stored in `library_items.kind` from catalogue 26.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LibraryItemKind {
    /// A gridded item: an imported elevation model or an analysis raster.
    Raster,
    /// Vector features: bring-your-own vectors and hydrology outputs (2.1-Q100).
    Vector,
}

impl LibraryItemKind {
    /// Every kind, in declaration order.
    pub const ALL: [Self; 2] = [Self::Raster, Self::Vector];

    /// The stored literal.
    pub const fn literal(self) -> &'static str {
        match self {
            Self::Raster => "raster",
            Self::Vector => "vector",
        }
    }
}

/// Where a library item came from, stored as `library_items.lineage_tag` from catalogue 26. The tag only:
/// what an analysis or external item also records lives in its lineage's own detail table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Lineage {
    /// Imported by the user from a file.
    Source,
    /// Produced by a registered analysis; the only lineage that can be out of date and refreshed.
    Analysis,
    /// Made by another tool, recorded with that tool, its date, notes and links.
    External,
}

impl Lineage {
    /// Every lineage, in declaration order.
    pub const ALL: [Self; 3] = [Self::Source, Self::Analysis, Self::External];

    /// The stored literal.
    pub const fn literal(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Analysis => "analysis",
            Self::External => "external",
        }
    }
}

/// The stored state of one `library_jobs` row (contracts §8), for imports and analyses alike.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LibraryJobState {
    /// Submitted, waiting for the runner.
    Queued,
    /// The runner is working on it.
    Running,
    /// The work returned or was cancelled; its result is being published or discarded.
    Settling,
    /// Final; the row's outcome says how it ended.
    Settled,
}

impl LibraryJobState {
    /// Every state, in declaration order.
    pub const ALL: [Self; 4] = [Self::Queued, Self::Running, Self::Settling, Self::Settled];

    /// The stored literal.
    pub const fn literal(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Settling => "settling",
            Self::Settled => "settled",
        }
    }
}

/// How a settled `library_jobs` row ended (contracts §8); present exactly when the state is settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LibraryJobOutcome {
    /// Published.
    Succeeded,
    /// Discarded with a failure, which the row stores as catalogue JSON.
    Failed,
    /// Cancelled by the user.
    Cancelled,
    /// Stopped by quit, or found unfinished at open; offers Run again.
    Interrupted,
}

impl LibraryJobOutcome {
    /// Every outcome, in declaration order.
    pub const ALL: [Self; 4] = [
        Self::Succeeded,
        Self::Failed,
        Self::Cancelled,
        Self::Interrupted,
    ];

    /// The stored literal.
    pub const fn literal(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}

/// State of one analysis job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum AnalysisJobState {
    Preparing,
    Complete,
    Failed,
    Cancelled,
}

/// One typed parameter value, in the units the registry declares (metres, m²,
/// degrees). Executors convert to tool units; users never see cells.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum ParamValue {
    Number(f64),
    Integer(i32),
    Boolean(bool),
    Choice(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisParamValue {
    pub key: String,
    pub value: ParamValue,
}

/// One named input of an analysis bound to a library item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisInputBinding {
    pub key: String,
    pub item_id: String,
}

/// A request to run a registered analysis as a new definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisRequest {
    /// Registry id, e.g. `terrain.slope`.
    pub analysis_id: String,
    pub inputs: Vec<AnalysisInputBinding>,
    /// Omitted parameters take their registry default; a parameter without a
    /// default must be given.
    pub parameters: Vec<AnalysisParamValue>,
    /// Keys of the outputs to produce; required outputs are always produced.
    pub outputs: Vec<String>,
    /// The name to publish the results under; blank publishes unnamed items.
    pub name: Option<String>,
}

/// Receipt for one created definition or one rerun.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisReceipt {
    pub definition_id: String,
    pub job_id: String,
    /// The derived items the definition publishes, in registry output order.
    pub item_ids: Vec<String>,
}

/// One input as a run pinned it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct ProvenanceInput {
    pub key: String,
    pub item_id: String,
    pub generation_id: String,
}

/// The engine that ran, as recorded when a run published.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ToolProvenance {
    /// Engine family, e.g. `geolibre`.
    pub engine: String,
    /// The runner's own version line, e.g. `geolibre-cli 1.5.3`.
    pub version: String,
    /// Source revision the runner was built from.
    pub revision: String,
    /// Tool ids the run actually invoked.
    pub tools: Vec<String>,
}

/// What produced a derived item.
///
/// With a published result it describes the run that produced it; before the
/// first result it describes the latest run's pinned inputs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct Provenance {
    pub definition_id: String,
    pub analysis_id: String,
    pub recipe_version: u32,
    pub output_key: String,
    pub inputs: Vec<ProvenanceInput>,
    pub parameters: Vec<AnalysisParamValue>,
    /// Recorded when the run published; `None` before that.
    pub tool: Option<ToolProvenance>,
    pub job_id: String,
    pub created_at: String,
}

/// Why a derived item is out of date. Refresh is always explicit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "reason")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum StaleReason {
    /// An input item now has a different generation than the run used.
    InputUpdated { input_key: String, item_id: String },
    /// An input item is itself out of date.
    InputStale { input_key: String, item_id: String },
    /// The registry's recipe version moved on.
    RecipeUpdated { from: u32, to: u32 },
    /// A different engine build is installed.
    ToolUpdated { from: String, to: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "state")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum Freshness {
    Current,
    Stale { reasons: Vec<StaleReason> },
}

/// The latest job of a derived item's definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisRunStatus {
    pub job_id: String,
    pub state: AnalysisJobState,
    pub message: Option<String>,
}

/// Why an analysis cannot run on an item. Only reasons that need the
/// catalogue, stored grid facts or the engine are native; the frontend adds
/// its own (Web edition, already in Layers).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "reason")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum AnalysisUnavailable {
    /// The item is not a type the analysis accepts.
    WrongInput { expected: Vec<LibraryItemType> },
    /// The item has no published data yet.
    NotReady,
    /// The analysis needs values in metres.
    ValuesNotMetres { units: String },
    /// The analysis needs a projected grid in ground metres, not Web Mercator.
    GridNotProjectedMetres,
    /// The engine the analysis runs on is not installed.
    EngineMissing { detail: String },
}

/// One registered analysis this item could feed, or why it cannot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct AnalysisOffer {
    pub analysis_id: String,
    /// `None` when the analysis can run on this item.
    pub unavailable: Option<AnalysisUnavailable>,
}

/// One Data Library item as the UI reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct LibraryItemSummary {
    pub id: String,
    /// The name its author gave. A source always has one; a derived item
    /// published unnamed has none, and the UI names it by its analysis.
    pub name: Option<String>,
    pub role: LibraryItemRole,
    pub item_type: LibraryItemType,
    pub units: String,
    pub state: LidarResultState,
    /// Current generation, when the item has published data.
    pub generation_id: Option<String>,
    /// WGS84 `[west, south, east, north]`.
    pub bounds: Option<[f64; 4]>,
    pub value_range: Option<[f64; 2]>,
    pub display_range: Option<LidarDisplayRange>,
    /// One cell's size on the ground in metres, whatever the grid's units
    /// (degrees and Web Mercator converted at the grid's centre).
    pub resolution_m: Option<f64>,
    /// Exact valid cells, `None` when not measured.
    pub coverage_cells: Option<u64>,
    /// The latest import of a source.
    pub import_job: Option<LidarImportJob>,
    /// What produced a derived item.
    pub provenance: Option<Provenance>,
    pub freshness: Freshness,
    /// The latest analysis job of a derived item.
    pub run: Option<AnalysisRunStatus>,
    /// Every registered analysis, with whether this item can feed it.
    pub offers: Vec<AnalysisOffer>,
    /// Derived items whose definitions use this item as an input.
    pub dependents: u32,
    /// When the item was added to the library: its catalogue row's
    /// `created_at`, Unix milliseconds as text, for sorting by Recently added.
    pub created_at: String,
}

/// The engines library work depends on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LibraryEngines {
    /// The in-process raster engine: import, display and inspection. Always
    /// available; its version names the crates it is built from.
    pub raster: LidarEngineStatus,
    /// The pinned GeoLibre CLI sidecar: new analysis runs. Published results
    /// stay readable whatever this reports.
    pub geolibre: LidarEngineStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct LibrarySnapshot {
    pub items: Vec<LibraryItemSummary>,
    pub engines: LibraryEngines,
}

/// What deleting one item would affect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LibraryDeleteImpact {
    /// Derived items calculated from this item; deletion is refused while any
    /// exist.
    pub dependent_item_ids: Vec<String>,
}

/// One output a run published.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct ProcessingRunOutput {
    pub item_id: String,
    pub generation_id: String,
    pub coverage_cells: Option<u64>,
}

/// One run of a definition, newest first in a history page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct ProcessingRun {
    pub job_id: String,
    pub state: AnalysisJobState,
    pub message: Option<String>,
    pub recipe_version: u32,
    pub tool: Option<ToolProvenance>,
    pub inputs: Vec<ProvenanceInput>,
    pub created_at: String,
    pub finished_at: Option<String>,
    /// Empty for a run that published nothing.
    pub outputs: Vec<ProcessingRunOutput>,
}

/// One bounded page of a definition's processing history. The data of runs
/// a refresh superseded is deleted; the record of the run stays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct ProcessingHistoryPage {
    pub definition_id: String,
    pub runs: Vec<ProcessingRun>,
    pub next_cursor: Option<String>,
}

/// Largest processing-history page.
pub const PROCESSING_HISTORY_PAGE: i64 = 50;

#[cfg(test)]
mod tests {
    use super::{LibraryItemKind, LibraryJobOutcome, LibraryJobState, Lineage, RasterQuantity};

    #[test]
    fn quantity_keys_round_trip_and_only_sources_are_importable() {
        for quantity in RasterQuantity::ALL {
            assert_eq!(RasterQuantity::from_key(quantity.key()), Some(quantity));
        }
        assert_eq!(RasterQuantity::from_key("elevation"), None);
        assert!(RasterQuantity::GroundElevation.is_importable());
        assert!(!RasterQuantity::Slope.is_importable());
    }

    /// Each stored enum's `ALL` lists every variant once, and serde writes exactly its stored literal, so the
    /// wire, the TypeScript union and the catalogue CHECK spell a value one way (contracts §7 Stored enums).
    fn assert_stored_enum<T>(all: &[T], literal: fn(T) -> &'static str)
    where
        T: Copy + std::fmt::Debug + PartialEq + serde::Serialize + serde::de::DeserializeOwned,
    {
        let mut seen = std::collections::BTreeSet::new();
        for &value in all {
            assert!(seen.insert(literal(value)), "{value:?} repeats a literal");
            let wire = serde_json::to_value(value).unwrap_or_default();
            assert_eq!(wire, serde_json::json!(literal(value)), "{value:?}");
            let back: Option<T> = serde_json::from_value(wire).ok();
            assert_eq!(back, Some(value));
        }
    }

    #[test]
    fn r2_canopi_f47t_52_271_catalogue_26_stored_enums_serialise_as_their_literals() {
        assert_stored_enum(&LibraryItemKind::ALL, LibraryItemKind::literal);
        assert_stored_enum(&Lineage::ALL, Lineage::literal);
        assert_stored_enum(&LibraryJobState::ALL, LibraryJobState::literal);
        assert_stored_enum(&LibraryJobOutcome::ALL, LibraryJobOutcome::literal);
    }
}
