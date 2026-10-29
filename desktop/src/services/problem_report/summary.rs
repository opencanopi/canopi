use common_types::health::SubsystemHealth;
use common_types::settings::Settings;
use common_types::support::ProblemReportRequest;

use super::redactions::Redactions;
use super::{BUNDLE_FILENAME, ProblemReportContext, SUMMARY_FILENAME};

pub(crate) fn build_report_summary(
    request: &ProblemReportRequest,
    context: &ProblemReportContext,
    timestamp_iso: &str,
    redactions: &Redactions,
) -> String {
    let description = normalized_description(&request.description);
    let includes_current_design = request.sensitive_attachments.current_design.is_some();
    let sensitive_attachments = if includes_current_design {
        "- Current Design (.canopi) included by explicit consent"
    } else {
        "- None selected"
    };
    let privacy_note = if includes_current_design {
        "The diagnostic bundle includes the current Design because you opted in. It includes its objects and their map coordinates, notes, timeline and budget. Screenshots are still excluded by default."
    } else {
        "The diagnostic bundle excludes Design contents (including object coordinates), screenshots and raw filesystem paths by default."
    };
    let settings_line = match (&context.settings, &context.settings_error) {
        (Some(settings), _) => format!(
            "Settings: locale {}, theme {}",
            locale_label(settings),
            theme_label(settings)
        ),
        (None, Some(error)) => format!("Settings: unavailable ({})", redactions.sanitize(error)),
        (None, None) => "Settings: unavailable".to_owned(),
    };

    // The webview's version (2.1-M82): a line only when the shell could read it.
    let webview_line = context
        .webview_version
        .as_deref()
        .map(|version| format!("Webview: {version}\n"))
        .unwrap_or_default();

    let summary = format!(
        "Canopi Problem Report\n\
         Created: {timestamp_iso}\n\
         App: Canopi {app_version}\n\
         Platform: {target}\n\
         {webview_line}\
         Health: plant catalog {plant_db}, Data library {lidar_library}\n\
         {settings_line}\n\
         \n\
         What happened:\n\
         {description}\n\
         \n\
         Attached files:\n\
         - {summary_file}\n\
         - {bundle_file}\n\
         \n\
         Sensitive attachments:\n\
         {sensitive_attachments}\n\
         \n\
         Privacy note:\n\
         {privacy_note}\n",
        app_version = context.app_version,
        target = context.target,
        plant_db = plant_db_label(&context.health),
        lidar_library = lidar_library_label(&context.health),
        summary_file = SUMMARY_FILENAME,
        bundle_file = BUNDLE_FILENAME,
    );

    redactions.sanitize(&summary)
}

pub(crate) fn normalized_description(description: &str) -> String {
    let trimmed = description.trim();
    if trimmed.is_empty() {
        "No description provided.".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn locale_label(settings: &Settings) -> &'static str {
    match settings.locale {
        common_types::settings::Locale::En => "en",
        common_types::settings::Locale::Fr => "fr",
        common_types::settings::Locale::Es => "es",
        common_types::settings::Locale::Pt => "pt",
        common_types::settings::Locale::It => "it",
        common_types::settings::Locale::Zh => "zh",
        common_types::settings::Locale::De => "de",
        common_types::settings::Locale::Ja => "ja",
        common_types::settings::Locale::Ko => "ko",
        common_types::settings::Locale::Nl => "nl",
        common_types::settings::Locale::Ru => "ru",
    }
}

fn theme_label(settings: &Settings) -> &'static str {
    match settings.theme {
        common_types::settings::Theme::Light => "light",
        common_types::settings::Theme::Dark => "dark",
    }
}

/// The Data library's open state, without counts, paths or reasons.
fn lidar_library_label(health: &SubsystemHealth) -> &'static str {
    match health.lidar_library {
        common_types::health::LidarLibraryStatus::Ready => "ready",
        common_types::health::LidarLibraryStatus::Recovered { .. } => "recovered",
        common_types::health::LidarLibraryStatus::RefusedNewer => "refused (newer version)",
        common_types::health::LidarLibraryStatus::Unavailable => "unavailable",
    }
}

fn plant_db_label(health: &SubsystemHealth) -> &'static str {
    match health.plant_db {
        common_types::health::PlantDbStatus::Available => "available",
        common_types::health::PlantDbStatus::Missing => "missing",
        common_types::health::PlantDbStatus::Corrupt => "corrupt",
    }
}

#[cfg(test)]
mod tests {
    use common_types::health::{
        LidarLibraryStatus, LocalDataStatus, PlantDbStatus, SubsystemHealth,
    };
    use common_types::support::{ProblemReportRequest, ProblemReportSensitiveAttachments};

    use super::super::ProblemReportContext;
    use super::super::redactions::Redactions;
    use super::build_report_summary;

    fn summary_with(webview_version: Option<&str>) -> String {
        let context = ProblemReportContext {
            output_root: std::path::PathBuf::from("reports"),
            log_dir: None,
            app_data_dir: None,
            timestamp_secs: 0,
            app_version: "2.1.0".to_owned(),
            target: "linux/x86_64".to_owned(),
            webview_version: webview_version.map(str::to_owned),
            settings: None,
            settings_error: None,
            health: SubsystemHealth {
                plant_db: PlantDbStatus::Available,
                lidar_library: LidarLibraryStatus::Ready,
                local_data: LocalDataStatus::Current,
            },
        };
        let request = ProblemReportRequest {
            description: String::new(),
            frontend_diagnostics: Vec::new(),
            sensitive_attachments: ProblemReportSensitiveAttachments::default(),
        };
        let redactions = Redactions::from_context(&context);
        build_report_summary(&request, &context, "1970-01-01T00:00:00Z", &redactions)
    }

    #[test]
    fn the_summary_names_the_webview_version_after_the_platform_and_omits_it_when_unread() {
        assert!(
            summary_with(Some("2.44.0"))
                .contains("Platform: linux/x86_64\nWebview: 2.44.0\nHealth:")
        );
        assert!(summary_with(None).contains("Platform: linux/x86_64\nHealth:"));
    }
}
