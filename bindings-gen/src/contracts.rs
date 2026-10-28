use specta::TypeCollection;
use specta_typescript::{BigIntExportBehavior, SerdeMode, Typescript};

#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
pub(crate) fn render_typescript_contracts() -> Result<String, Box<dyn std::error::Error>> {
    let types = TypeCollection::default()
        .register::<common_types::design::Annotation>()
        .register::<common_types::design::LoadedDesign>()
        .register::<common_types::design::DesignLoadFailure>()
        .register::<common_types::design::DesignSaveOutcome>()
        .register::<common_types::design::DesignDraftSummary>()
        .register::<common_types::design::BudgetItem>()
        .register::<common_types::design::CanopiFile>()
        .register::<common_types::design::Consortium>()
        .register::<common_types::design::DesignNotebookEntry>()
        .register::<common_types::design::DesignNotebookSection>()
        .register::<common_types::design::DesignNotebookSnapshot>()
        .register::<common_types::design::DesignSummary>()
        .register::<common_types::design::DesignGroundBounds>()
        .register::<common_types::design::DesignSketch>()
        .register::<common_types::design::DesignSketchZone>()
        .register::<common_types::design::RecentDesignPreview>()
        .register::<common_types::design::RecentDesignSummary>()
        .register::<common_types::design::Layer>()
        .register::<common_types::design::ObjectGroup>()
        .register::<common_types::design::PanelTarget>()
        .register::<common_types::design::PlacedPlant>()
        .register::<common_types::design::GeoPoint>()
        .register::<common_types::design::SpeciesPanelTarget>()
        .register::<common_types::design::SpeciesPanelTargetKind>()
        .register::<common_types::design::TimelineAction>()
        .register::<common_types::design::Zone>()
        .register::<common_types::dialog::DialogKind>()
        .register::<common_types::dialog::PickOpenOutcome>()
        .register::<common_types::dialog::PickSaveOutcome>()
        .register::<common_types::health::LidarLibraryStatus>()
        .register::<common_types::health::LocalDataStatus>()
        .register::<common_types::health::PlantDbStatus>()
        .register::<common_types::health::SubsystemHealth>()
        .register::<common_types::library::AnalysisInputBinding>()
        .register::<common_types::library::AnalysisJobState>()
        .register::<common_types::library::AnalysisOffer>()
        .register::<common_types::library::AnalysisParamValue>()
        .register::<common_types::library::AnalysisReceipt>()
        .register::<common_types::library::AnalysisRequest>()
        .register::<common_types::library::AnalysisRunStatus>()
        .register::<common_types::library::AnalysisUnavailable>()
        .register::<common_types::library::Freshness>()
        .register::<common_types::library::LibraryDeleteImpact>()
        .register::<common_types::library::LibraryEngines>()
        .register::<common_types::library::LibraryItemRole>()
        .register::<common_types::library::LibraryItemSummary>()
        .register::<common_types::library::LibraryItemType>()
        .register::<common_types::library::LibrarySnapshot>()
        .register::<common_types::library::ParamValue>()
        .register::<common_types::library::ProcessingHistoryPage>()
        .register::<common_types::library::ProcessingRun>()
        .register::<common_types::library::ProcessingRunOutput>()
        .register::<common_types::library::Provenance>()
        .register::<common_types::library::ProvenanceInput>()
        .register::<common_types::library::RasterQuantity>()
        .register::<common_types::library::StaleReason>()
        .register::<common_types::library::ToolProvenance>()
        .register::<common_types::lidar::LidarColourRange>()
        .register::<common_types::lidar::LidarDisplayAsset>()
        .register::<common_types::lidar::LidarDisplayDescriptor>()
        .register::<common_types::lidar::LidarDisplayRequest>()
        .register::<common_types::lidar::LidarDisplayState>()
        .register::<common_types::lidar::LidarEngineStatus>()
        .register::<common_types::lidar::LidarImportCoverage>()
        .register::<common_types::lidar::LidarImportJob>()
        .register::<common_types::lidar::LidarImportReceipt>()
        .register::<common_types::lidar::LidarImportRefusal>()
        .register::<common_types::lidar::LidarImportJobState>()
        .register::<common_types::lidar::LidarLayerCollection>()
        .register::<common_types::lidar::LidarLayerSource>()
        .register::<common_types::lidar::LidarPresentationEntry>()
        .register::<common_types::lidar::LidarPresentationSection>()
        .register::<common_types::lidar::LidarRamp>()
        .register::<common_types::lidar::LidarResultState>()
        .register::<common_types::lidar::LidarSamplePointsRequest>()
        .register::<common_types::lidar::LidarSampleSeries>()
        .register::<common_types::lidar::LidarSampleTarget>()
        .register::<common_types::lidar::LidarSampleUnavailableReason>()
        .register::<common_types::location::GeoResult>()
        .register::<common_types::saved_object_stamps::SavedObjectStamp>()
        .register::<common_types::views::RichTextBlock>()
        .register::<common_types::views::RichTextListItem>()
        .register::<common_types::views::RichTextSpan>()
        .register::<common_types::views::SavedView>()
        .register::<common_types::views::SavedViewBackground>()
        .register::<common_types::views::SavedViewCamera>()
        .register::<common_types::views::SavedViewGroundSize>()
        .register::<common_types::views::SavedViewHighlight>()
        .register::<common_types::views::SavedViewLayers>()
        .register::<common_types::views::SavedViewObject>()
        .register::<common_types::views::SavedViewTerrain>()
        .register::<common_types::views::Story>()
        .register::<common_types::views::StoryImage>()
        .register::<common_types::views::StoryStep>()
        .register::<common_types::settings::AppFolder>()
        .register::<common_types::settings::AppFolderLocations>()
        .register::<common_types::settings::LastView>()
        .register::<common_types::settings::Locale>()
        .register::<common_types::settings::Settings>()
        .register::<common_types::settings::Theme>()
        .register::<common_types::support::FrontendDiagnosticEntry>()
        .register::<common_types::support::ProblemReportRequest>()
        .register::<common_types::support::ProblemReportResult>()
        .register::<common_types::species::CommonNameEntry>()
        .register::<common_types::species::DynamicFilter>()
        .register::<common_types::species::DynamicFilterOptions>()
        .register::<common_types::species::FilterOp>()
        .register::<common_types::species::FilterOptions>()
        .register::<common_types::species::FilterValue>()
        .register::<common_types::species::FlowerColorResolution>()
        .register::<common_types::species::PaginatedResult<common_types::species::SpeciesListItem>>(
        )
        .register::<common_types::species::Sort>()
        .register::<common_types::species::SpeciesDetail>()
        .register::<common_types::species::SpeciesFilter>()
        .register::<common_types::species::SpeciesImage>()
        .register::<common_types::species::SpeciesListItem>()
        .register::<common_types::species::SpeciesSearchRequest>()
        .register::<common_types::species::SpeciesUse>();

    let rendered = Typescript::default()
        .header("// Generated by `cargo run -p bindings-gen`. Do not edit by hand.")
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
    // The sampler's caps: Rust refuses a request beyond either, so the
    // frontend batches by the same numbers.
    normalized.push_str(&format!(
        "\nexport const LIDAR_SAMPLE_MAX_TARGETS = {}\nexport const LIDAR_SAMPLE_MAX_POINTS = {}\n",
        common_types::lidar::LIDAR_SAMPLE_MAX_TARGETS,
        common_types::lidar::LIDAR_SAMPLE_MAX_POINTS,
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
            common_types::lidar::LIDAR_SAMPLE_MAX_TARGETS
        )));
        assert!(rendered.contains(&format!(
            "export const LIDAR_SAMPLE_MAX_POINTS = {}\n",
            common_types::lidar::LIDAR_SAMPLE_MAX_POINTS
        )));
    }

    #[test]
    fn the_dialog_contract_reaches_typescript_from_rust() {
        let rendered = super::render_typescript_contracts().expect("contracts render");
        let union = rendered
            .split("export type DialogKind =")
            .nth(1)
            .and_then(|rest| rest.split("\n\n").next())
            .expect("DialogKind is exported");
        for kind in common_types::dialog::DialogKind::ALL {
            assert!(
                union.contains(&format!("\"{}\"", kind.literal())),
                "{} is missing from DialogKind",
                kind.literal()
            );
        }
        assert!(rendered.contains("export type PickOpenOutcome ="));
        assert!(rendered.contains("export type PickSaveOutcome ="));
    }
}
