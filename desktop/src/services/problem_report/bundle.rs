use common_types::support::ProblemReportRequest;
use serde_json::json;

use super::redactions::Redactions;
use super::summary::normalized_description;
use super::zip::{ZipEntry, create_stored_zip};
use super::{CURRENT_DESIGN_ATTACHMENT_FILENAME, ProblemReportContext};

const MAX_LOG_FILES: usize = 3;
const MAX_LOG_BYTES_PER_FILE: usize = 64 * 1024;
const MAX_LOG_LINES: usize = 200;

pub(crate) fn build_diagnostic_bundle(
    request: &ProblemReportRequest,
    context: &ProblemReportContext,
    timestamp_iso: &str,
    summary: &str,
    redactions: &Redactions,
) -> Result<Vec<u8>, String> {
    let includes_current_design = request.sensitive_attachments.current_design.is_some();
    let mut manifest_files = vec![
        "report-summary.txt",
        "system.json",
        "frontend-diagnostics.json",
        "backend-log.txt",
    ];
    if includes_current_design {
        manifest_files.push(CURRENT_DESIGN_ATTACHMENT_FILENAME);
    }
    let privacy_defaults = if includes_current_design {
        vec![
            "Current Design included by explicit user consent",
            "Screenshots excluded",
            "Filesystem paths sanitized in diagnostics",
        ]
    } else {
        vec![
            "Design contents excluded, including object coordinates",
            "Screenshots excluded",
            "Filesystem paths sanitized",
        ]
    };
    let sensitive_attachments = if includes_current_design {
        vec![json!({
            "kind": "current_design",
            "file": CURRENT_DESIGN_ATTACHMENT_FILENAME,
            "included_by_user_consent": true,
        })]
    } else {
        Vec::new()
    };
    let system = json!({
        "app": {
            "name": "Canopi",
            "version": context.app_version,
            "target": context.target,
            "webview_version": context.webview_version,
        },
        "created_at": timestamp_iso,
        "health": context.health,
        "settings": settings_summary(context),
        "privacy": {
            "includes_design_contents": includes_current_design,
            "includes_screenshot": false,
            "filesystem_paths_sanitized": true,
        },
    });
    let manifest = json!({
        "format": "canopi-diagnostic-bundle-v1",
        "created_at": timestamp_iso,
        "files": manifest_files,
        "privacy_defaults": privacy_defaults,
        "sensitive_attachments": sensitive_attachments,
    });

    let backend_log = collect_backend_log_excerpt(context, redactions);
    let description = redactions.sanitize(&normalized_description(&request.description));
    let frontend_diagnostics = json!({
        "entries": &request.frontend_diagnostics,
    });

    let system_json = serde_json::to_string_pretty(&system)
        .map_err(|error| format!("Failed to encode diagnostic system info: {error}"))?;
    let frontend_diagnostics_json = serde_json::to_string_pretty(&frontend_diagnostics)
        .map_err(|error| format!("Failed to encode frontend diagnostics: {error}"))?;
    let mut entries = vec![
        ZipEntry::new(
            "manifest.json",
            serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("Failed to encode diagnostic manifest: {error}"))?,
        ),
        ZipEntry::new(
            "system.json",
            redactions.sanitize(&system_json).into_bytes(),
        ),
        ZipEntry::new(
            "report-summary.txt",
            format!("{summary}\n\nDescription only:\n{description}\n").into_bytes(),
        ),
        ZipEntry::new(
            "frontend-diagnostics.json",
            redactions.sanitize(&frontend_diagnostics_json).into_bytes(),
        ),
        ZipEntry::new("backend-log.txt", backend_log.into_bytes()),
    ];
    if let Some(current_design) = &request.sensitive_attachments.current_design {
        entries.push(ZipEntry::new(
            CURRENT_DESIGN_ATTACHMENT_FILENAME,
            current_design.as_bytes().to_vec(),
        ));
    }

    create_stored_zip(&entries)
}

fn settings_summary(context: &ProblemReportContext) -> serde_json::Value {
    if let Some(settings) = &context.settings {
        json!({
            "locale": settings.locale,
            "theme": settings.theme,
            "basemap_style": settings.basemap_style,
            "basemap_visible": settings.basemap_visible,
            "satellite_visible": settings.satellite_visible,
            "contour_visible": settings.contour_visible,
            "hillshade_visible": settings.hillshade_visible,
            "plant_spacing_interval_m": settings.plant_spacing_interval_m,
        })
    } else {
        json!({
            "available": false,
            "error": context.settings_error.as_deref().unwrap_or("unknown"),
        })
    }
}

fn collect_backend_log_excerpt(context: &ProblemReportContext, redactions: &Redactions) -> String {
    let Some(log_dir) = &context.log_dir else {
        return "No backend log directory was available.\n".to_owned();
    };

    let mut files = match std::fs::read_dir(log_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let name = path.file_name()?.to_str()?;
                if !name.starts_with("canopi") {
                    return None;
                }
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                Some((modified, path))
            })
            .collect::<Vec<_>>(),
        Err(error) => {
            return format!(
                "Backend log directory could not be read: {}\n",
                redactions.sanitize(&error.to_string())
            );
        }
    };

    files.sort_by_key(|(modified, _)| *modified);
    let mut excerpts = Vec::new();
    for (_, path) in files.into_iter().rev().take(MAX_LOG_FILES).rev() {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let start = bytes.len().saturating_sub(MAX_LOG_BYTES_PER_FILE);
        let text = String::from_utf8_lossy(&bytes[start..]);
        let lines = text
            .lines()
            .rev()
            .take(MAX_LOG_LINES)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        excerpts.push(format!(
            "== {} ==\n{}\n",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("canopi.log"),
            redactions.sanitize(&lines)
        ));
    }

    if excerpts.is_empty() {
        "No backend log files were available.\n".to_owned()
    } else {
        excerpts.join("\n")
    }
}
