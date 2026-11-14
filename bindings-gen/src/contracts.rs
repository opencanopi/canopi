use specta::TypeCollection;
use specta_typescript::{BigIntExportBehavior, SerdeMode, Typescript};

/// Every type the frontend contracts export; the type manifest walks the same collection.
#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; one registration per exported type"
)]
pub(crate) fn contract_types() -> TypeCollection {
    TypeCollection::default()
        .register::<canopi_types::design::Annotation>()
        .register::<canopi_types::design::LoadedDesign>()
        .register::<canopi_types::design::ReadOnlyDesign>()
        .register::<canopi_types::design::DesignLoadFailure>()
        .register::<canopi_types::design::DesignSaveOutcome>()
        .register::<canopi_types::design::DesignDraftSummary>()
        .register::<canopi_types::design::DesignDraftAccess>()
        .register::<canopi_types::design::BudgetItem>()
        .register::<canopi_types::design::CanopiFile>()
        .register::<canopi_types::design::Consortium>()
        .register::<canopi_types::design::DesignNotebookEntry>()
        .register::<canopi_types::design::DesignNotebookSection>()
        .register::<canopi_types::design::DesignNotebookSnapshot>()
        .register::<canopi_types::design::DesignSummary>()
        .register::<canopi_types::design::DesignGroundBounds>()
        .register::<canopi_types::design::DesignSketch>()
        .register::<canopi_types::design::DesignSketchZone>()
        .register::<canopi_types::design::RecentDesignPreview>()
        .register::<canopi_types::design::RecentDesignSummary>()
        .register::<canopi_types::design::Layer>()
        .register::<canopi_types::design::ObjectGroup>()
        .register::<canopi_types::design::PanelTarget>()
        .register::<canopi_types::design::PlacedPlant>()
        .register::<canopi_types::design::GeoPoint>()
        .register::<canopi_types::design::SpeciesPanelTarget>()
        .register::<canopi_types::design::SpeciesPanelTargetKind>()
        .register::<canopi_types::design::TimelineAction>()
        .register::<canopi_types::design::Zone>()
        .register::<canopi_types::dialog::DialogKind>()
        .register::<canopi_types::dialog::PickOpenOutcome>()
        .register::<canopi_types::dialog::PickSaveOutcome>()
        .register::<canopi_types::failure::Failure>()
        .register::<canopi_types::failure::FailureCode>()
        .register::<canopi_types::failure::FailureLogLevel>()
        .register::<canopi_types::failure::FailureSource>()
        .register::<canopi_types::failure::IoFailureKind>()
        .register::<canopi_types::failure::Lane>()
        .register::<canopi_types::failure::LibraryReadOnlyReason>()
        .register::<canopi_types::failure::NetworkFailureKind>()
        .register::<canopi_types::failure::OperationId>()
        .register::<canopi_types::failure::PlantCatalogCause>()
        .register::<canopi_types::failure::RedactedText>()
        .register::<canopi_types::health::PlantDbStatus>()
        .register::<canopi_types::health::StoreHealth>()
        .register::<canopi_types::health::StoreId>()
        .register::<canopi_types::health::StoreNotice>()
        .register::<canopi_types::health::StoreOpenStatus>()
        .register::<canopi_types::health::SubsystemHealth>()
        .register::<canopi_types::library::AnalysisInputBinding>()
        .register::<canopi_types::library::AnalysisJobState>()
        .register::<canopi_types::library::AnalysisOffer>()
        .register::<canopi_types::library::AnalysisParamValue>()
        .register::<canopi_types::library::AnalysisReceipt>()
        .register::<canopi_types::library::AnalysisRequest>()
        .register::<canopi_types::library::AnalysisRunStatus>()
        .register::<canopi_types::library::AnalysisUnavailable>()
        .register::<canopi_types::library::Freshness>()
        .register::<canopi_types::library::LibraryDeleteImpact>()
        .register::<canopi_types::library::LibraryEngines>()
        .register::<canopi_types::library::LibraryItemKind>()
        .register::<canopi_types::library::LibraryItemRole>()
        .register::<canopi_types::library::LibraryItemSummary>()
        .register::<canopi_types::library::LibraryItemType>()
        .register::<canopi_types::library::LibraryJobOutcome>()
        .register::<canopi_types::library::LibraryJobState>()
        .register::<canopi_types::library::LibrarySnapshot>()
        .register::<canopi_types::library::Lineage>()
        .register::<canopi_types::library::ParamValue>()
        .register::<canopi_types::library::ProcessingHistoryPage>()
        .register::<canopi_types::library::ProcessingRun>()
        .register::<canopi_types::library::ProcessingRunOutput>()
        .register::<canopi_types::library::Provenance>()
        .register::<canopi_types::library::ProvenanceInput>()
        .register::<canopi_types::library::RasterQuantity>()
        .register::<canopi_types::library::StaleReason>()
        .register::<canopi_types::library::ToolProvenance>()
        .register::<canopi_types::lidar::LidarColourRange>()
        .register::<canopi_types::lidar::LidarDisplayAsset>()
        .register::<canopi_types::lidar::LidarDisplayDescriptor>()
        .register::<canopi_types::lidar::LidarDisplayRequest>()
        .register::<canopi_types::lidar::LidarDisplayState>()
        .register::<canopi_types::lidar::LidarEngineStatus>()
        .register::<canopi_types::lidar::LidarImportCoverage>()
        .register::<canopi_types::lidar::LidarImportJob>()
        .register::<canopi_types::lidar::LidarImportReceipt>()
        .register::<canopi_types::lidar::LidarImportRefusal>()
        .register::<canopi_types::lidar::LidarImportJobState>()
        .register::<canopi_types::lidar::LidarLayerCollection>()
        .register::<canopi_types::lidar::LidarLayerSource>()
        .register::<canopi_types::lidar::LidarPresentationEntry>()
        .register::<canopi_types::lidar::LidarPresentationSection>()
        .register::<canopi_types::lidar::LidarRamp>()
        .register::<canopi_types::lidar::LidarResultState>()
        .register::<canopi_types::lidar::LidarSamplePointsRequest>()
        .register::<canopi_types::lidar::LidarSampleSeries>()
        .register::<canopi_types::lidar::LidarSampleTarget>()
        .register::<canopi_types::lidar::LidarSampleUnavailableReason>()
        .register::<canopi_types::location::GeoResult>()
        .register::<canopi_types::report::ReportConsent>()
        .register::<canopi_types::report::ReportManifest>()
        .register::<canopi_types::report::ReportManifestEntry>()
        .register::<canopi_types::report::ReportSection>()
        .register::<canopi_types::report::ReportSectionId>()
        .register::<canopi_types::report::ReportSectionStatus>()
        .register::<canopi_types::saved_object_stamps::SavedObjectStamp>()
        .register::<canopi_types::views::RichTextBlock>()
        .register::<canopi_types::views::RichTextListItem>()
        .register::<canopi_types::views::RichTextSpan>()
        .register::<canopi_types::views::SavedView>()
        .register::<canopi_types::views::SavedViewBackground>()
        .register::<canopi_types::views::SavedViewCamera>()
        .register::<canopi_types::views::SavedViewGroundSize>()
        .register::<canopi_types::views::SavedViewHighlight>()
        .register::<canopi_types::views::SavedViewLayers>()
        .register::<canopi_types::views::SavedViewObject>()
        .register::<canopi_types::views::SavedViewTerrain>()
        .register::<canopi_types::views::Story>()
        .register::<canopi_types::views::StoryImage>()
        .register::<canopi_types::views::StoryStep>()
        .register::<canopi_types::settings::AppFolder>()
        .register::<canopi_types::settings::AppFolderLocations>()
        .register::<canopi_types::settings::LastView>()
        .register::<canopi_types::settings::Locale>()
        .register::<canopi_types::settings::Settings>()
        .register::<canopi_types::settings::Theme>()
        .register::<canopi_types::support::FrontendDiagnosticLevel>()
        .register::<canopi_types::support::ProblemReportRequest>()
        .register::<canopi_types::support::ProblemReportResult>()
        .register::<canopi_types::support::ReportSectionText>()
        .register::<canopi_types::species::CommonNameEntry>()
        .register::<canopi_types::species::DynamicFilter>()
        .register::<canopi_types::species::DynamicFilterOptions>()
        .register::<canopi_types::species::FilterOp>()
        .register::<canopi_types::species::FilterOptions>()
        .register::<canopi_types::species::FilterValue>()
        .register::<canopi_types::species::FlowerColorResolution>()
        .register::<canopi_types::species::PaginatedResult<canopi_types::species::SpeciesListItem>>(
        )
        .register::<canopi_types::species::Sort>()
        .register::<canopi_types::species::SpeciesDetail>()
        .register::<canopi_types::species::SpeciesFilter>()
        .register::<canopi_types::species::SpeciesImage>()
        .register::<canopi_types::species::SpeciesListItem>()
        .register::<canopi_types::species::SpeciesSearchRequest>()
        .register::<canopi_types::species::SpeciesUse>()
        .register::<canopi_types::update::UpdateDownload>()
        .register::<canopi_types::update::UpdateOffer>()
        .register::<canopi_types::update::UpdateOp>()
        .register::<canopi_types::update::UpdateProgress>()
}

/// The newtypes rendered as branded strings.
const BRANDED_STRINGS: [&str; 2] = ["OperationId", "RedactedText"];

pub(crate) fn render_typescript_contracts() -> Result<String, Box<dyn std::error::Error>> {
    let types = contract_types();
    let rendered = Typescript::default()
        .header(concat!(
            "// Generated by `cargo run -p bindings-gen`. Do not edit by hand.\n",
            "// Owner of GeoPoint, the one lon/lat point type (single-lonlat-point-type, ADR 0028; §18 F39).\n",
            "// Invariant: no other module declares a {lon, lat} or [lon, lat] point type.",
        ))
        .bigint(BigIntExportBehavior::String)
        .with_serde(SerdeMode::Serialize)
        .export(&types)?;
    // The TypeScript exporter leaves a trailing space on multi-line union
    // heads. Normalize here rather than hand-editing a generated file, so the
    // committed output passes the repository's whitespace check and stays
    // byte-identical to what regeneration produces.
    let mut normalized: String = rendered
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    normalized.push('\n');
    // Opaque strings cross the seam as plain strings and are branded in TS
    // (2.1-M420, 2.1-M424): only their owners mint them.
    for brand in BRANDED_STRINGS {
        let plain = format!("export type {brand} = string;\n");
        if !normalized.contains(&plain) {
            return Err(format!("{brand} is not rendered as a plain string to brand").into());
        }
        normalized = normalized.replace(
            &plain,
            &format!("export type {brand} = string & {{ readonly __brand: \"{brand}\" }};\n"),
        );
    }
    // The problem report's sections (ADR 0025, 2.1-M421): the one TS builder
    // reads the rows Rust declares.
    normalized.push_str(&format!(
        "\nexport const REPORT_SECTIONS: readonly ReportSection[] = {}\n\nexport const REPORT_MANIFEST_FILE = {}\nexport const REPORT_NOT_COLLECTED_NOTE = {}\n",
        serde_json::to_string_pretty(&canopi_types::report::REPORT_SECTIONS)?,
        serde_json::to_string(canopi_types::report::MANIFEST_FILE)?,
        serde_json::to_string(canopi_types::report::NOT_COLLECTED_NOTE)?,
    ));
    // The failure catalogue's rows (contracts §2, 2.1-M413): the frontend's one
    // message map skips the silent rows, and the transport records none of them.
    let rows: std::collections::BTreeMap<_, _> = canopi_types::failure::FailureCode::ROWS
        .iter()
        .map(|row| (row.kind, row))
        .collect();
    normalized.push_str(&format!(
        "\nexport type FailureRow = {{ readonly source: FailureSource; readonly user_may_retry: boolean; readonly silent: boolean; readonly level: FailureLogLevel }}\n\nexport const FAILURE_CATALOGUE: {{ readonly [K in FailureCode[\"kind\"]]: FailureRow }} = {}\n",
        serde_json::to_string_pretty(&rows)?
    ));
    // The updater's narrowing (contracts §2 updater row): the kinds an update command settles
    // with and its op, so the updater's message map stays exhaustive over what it can receive.
    let kinds: Vec<String> = canopi_types::update::UPDATER_FAILURE_KINDS
        .iter()
        .map(|kind| format!("\"{kind}\""))
        .collect();
    normalized.push_str(&format!(
        "\nexport type UpdaterFailureKind = {}\n\nexport type UpdaterFailure = Omit<Failure, \"code\" | \"op\"> & {{ code: Extract<FailureCode, {{ kind: UpdaterFailureKind }}>; op: UpdateOp }}\n",
        kinds.join(" | ")
    ));
    // The sampler's caps: Rust refuses a request beyond either, so the
    // frontend batches by the same numbers.
    normalized.push_str(&format!(
        "\nexport const LIDAR_SAMPLE_MAX_TARGETS = {}\nexport const LIDAR_SAMPLE_MAX_POINTS = {}\n",
        canopi_types::lidar::LIDAR_SAMPLE_MAX_TARGETS,
        canopi_types::lidar::LIDAR_SAMPLE_MAX_POINTS,
    ));
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_sample_caps_reach_typescript_from_rust() {
        let rendered = super::render_typescript_contracts().expect("contracts render");
        assert!(rendered.contains(&format!(
            "export const LIDAR_SAMPLE_MAX_TARGETS = {}\n",
            canopi_types::lidar::LIDAR_SAMPLE_MAX_TARGETS
        )));
        assert!(rendered.contains(&format!(
            "export const LIDAR_SAMPLE_MAX_POINTS = {}\n",
            canopi_types::lidar::LIDAR_SAMPLE_MAX_POINTS
        )));
    }

    #[test]
    fn every_catalogue_row_reaches_typescript_keyed_by_its_kind() {
        let rendered = super::render_typescript_contracts().expect("contracts render");
        let table = rendered
            .split("export const FAILURE_CATALOGUE: { readonly [K in FailureCode[\"kind\"]]: FailureRow } = ")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .map(|body| format!("{body}\n}}"))
            .expect("FAILURE_CATALOGUE is exported");
        let table: serde_json::Value = serde_json::from_str(&table).expect("the table is JSON");
        for row in canopi_types::failure::FailureCode::ROWS {
            assert_eq!(
                table[row.kind],
                serde_json::json!({
                    "source": row.source,
                    "user_may_retry": row.user_may_retry,
                    "silent": row.silent,
                    "level": row.level,
                }),
                "{}",
                row.kind
            );
        }
        assert_eq!(
            table.as_object().map(serde_json::Map::len),
            Some(canopi_types::failure::FailureCode::ROWS.len())
        );
    }

    /// The updater's message map is a mapped type over `UpdaterFailure["code"]["kind"]`
    /// (app/updates/state.ts), so the narrowing carries exactly the kinds Rust says the updater
    /// settles with: one Rust adds there fails the typecheck until the map has its rule.
    #[test]
    fn the_updater_failure_narrows_to_the_kinds_the_updater_settles_with() {
        let rendered = super::render_typescript_contracts().expect("contracts render");
        let kinds = rendered
            .split("export type UpdaterFailureKind =")
            .nth(1)
            .and_then(|rest| rest.split('\n').next())
            .expect("UpdaterFailureKind is exported");
        let listed: Vec<&str> = kinds
            .split('|')
            .map(|kind| kind.trim().trim_end_matches(';').trim_matches('"'))
            .collect();
        assert_eq!(listed, canopi_types::update::UPDATER_FAILURE_KINDS);
        assert!(rendered.contains(
            "export type UpdaterFailure = Omit<Failure, \"code\" | \"op\"> & { code: Extract<FailureCode, { kind: UpdaterFailureKind }>; op: UpdateOp }\n"
        ));
        assert!(!rendered.contains("UpdateLane"), "UpdateLane is deleted");
        assert!(
            !rendered.contains("export type UpdateFailure"),
            "UpdateFailure is deleted"
        );
    }

    #[test]
    fn the_dialog_contract_reaches_typescript_from_rust() {
        let rendered = super::render_typescript_contracts().expect("contracts render");
        let union = rendered
            .split("export type DialogKind =")
            .nth(1)
            .and_then(|rest| rest.split("\n\n").next())
            .expect("DialogKind is exported");
        for kind in canopi_types::dialog::DialogKind::ALL {
            assert!(
                union.contains(&format!("\"{}\"", kind.literal())),
                "{} is missing from DialogKind",
                kind.literal()
            );
        }
        assert!(rendered.contains("export type PickOpenOutcome ="));
        assert!(rendered.contains("export type PickSaveOutcome ="));
    }

    /// Catalogue 26's stored enums reach TypeScript as unions of exactly their stored literals (contracts §7).
    #[test]
    fn r2_canopi_f47t_52_271_catalogue_26_stored_enums_reach_typescript_as_their_literals() {
        use canopi_types::library::{LibraryItemKind, LibraryJobOutcome, LibraryJobState, Lineage};
        let rendered = super::render_typescript_contracts().expect("contracts render");
        let union_of = |name: &str| -> Vec<String> {
            rendered
                .split(&format!("export type {name} ="))
                .nth(1)
                .and_then(|rest| rest.split(";\n").next())
                .unwrap_or_else(|| panic!("{name} is exported"))
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<String>()
                .split('|')
                .map(|literal| literal.trim().trim_matches('"').to_owned())
                .collect()
        };
        let literals = |all: &[&str]| all.iter().map(|&l| l.to_owned()).collect::<Vec<_>>();
        assert_eq!(
            union_of("LibraryItemKind"),
            literals(&LibraryItemKind::ALL.map(LibraryItemKind::literal))
        );
        assert_eq!(
            union_of("Lineage"),
            literals(&Lineage::ALL.map(Lineage::literal))
        );
        assert_eq!(
            union_of("LibraryJobState"),
            literals(&LibraryJobState::ALL.map(LibraryJobState::literal))
        );
        assert_eq!(
            union_of("LibraryJobOutcome"),
            literals(&LibraryJobOutcome::ALL.map(LibraryJobOutcome::literal))
        );
    }
}

/// The probe of stream 1a's riskiest assumption (Phase 1 design check §9): specta `=2.0.0-rc.23` renders a flat
/// internally tagged failure code whose variants carry nested internally tagged enums as a TypeScript union that
/// round-trips serde. Today's catalogue has no nested code; `design_load` (1a-c7) and `import_refused{refusal}` (N1)
/// will, each sub-kind under its code's name as contracts §2 puts it. The spike types stand in for them, so a specta
/// upgrade that breaks the shape fails here first.
#[cfg(test)]
mod failure_probe {
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use specta::{Type, TypeCollection};
    use specta_typescript::{SerdeMode, Typescript};

    #[derive(Debug, PartialEq, Serialize, Deserialize, Type)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum SpikeCode {
        Busy { lane: SpikeLane },
        DesignLoad { design_load: SpikeDesignLoad },
        ImportRefused { refusal: SpikeRefusal },
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize, Type)]
    #[serde(rename_all = "snake_case")]
    enum SpikeLane {
        Library,
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize, Type)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum SpikeDesignLoad {
        MigrationFailed { from: u32 },
        NewerVersion,
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize, Type)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum SpikeRefusal {
        UnsupportedCrs { crs: String },
        Empty,
    }

    fn rendered() -> String {
        let types = TypeCollection::default().register::<SpikeCode>();
        Typescript::default()
            .with_serde(SerdeMode::Serialize)
            .export(&types)
            .expect("the spike renders")
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_nested_internally_tagged_code_round_trips_serde() {
        let cases = [
            (
                SpikeCode::DesignLoad {
                    design_load: SpikeDesignLoad::MigrationFailed { from: 9 },
                },
                json!({ "kind": "design_load", "design_load": { "kind": "migration_failed", "from": 9 } }),
            ),
            (
                SpikeCode::DesignLoad {
                    design_load: SpikeDesignLoad::NewerVersion,
                },
                json!({ "kind": "design_load", "design_load": { "kind": "newer_version" } }),
            ),
            (
                SpikeCode::ImportRefused {
                    refusal: SpikeRefusal::UnsupportedCrs {
                        crs: "EPSG:2154".to_owned(),
                    },
                },
                json!({ "kind": "import_refused", "refusal": { "kind": "unsupported_crs", "crs": "EPSG:2154" } }),
            ),
            (
                SpikeCode::Busy {
                    lane: SpikeLane::Library,
                },
                json!({ "kind": "busy", "lane": "library" }),
            ),
        ];
        for (code, wire) in cases {
            assert_eq!(serde_json::to_value(&code).expect("serializes"), wire);
            assert_eq!(
                serde_json::from_value::<SpikeCode>(wire).expect("deserializes"),
                code
            );
        }
    }

    #[test]
    fn a_nested_internally_tagged_code_renders_a_discriminated_typescript_union() {
        let rendered = rendered();
        let union_of = |name: &str| {
            rendered
                .split(&format!("export type {name} ="))
                .nth(1)
                .and_then(|rest| rest.split(";\n").next())
                .unwrap_or_else(|| panic!("{name} is exported:\n{rendered}"))
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .trim_end_matches(';')
                .to_owned()
        };
        assert_eq!(
            union_of("SpikeCode"),
            "{ kind: \"busy\"; lane: SpikeLane } | { kind: \"design_load\"; design_load: SpikeDesignLoad } | { kind: \"import_refused\"; refusal: SpikeRefusal }",
            "{rendered}"
        );
        assert_eq!(
            union_of("SpikeDesignLoad"),
            "{ kind: \"migration_failed\"; from: number } | { kind: \"newer_version\" }",
            "{rendered}"
        );
        assert_eq!(
            union_of("SpikeRefusal"),
            "{ kind: \"unsupported_crs\"; crs: string } | { kind: \"empty\" }",
            "{rendered}"
        );
    }
}
