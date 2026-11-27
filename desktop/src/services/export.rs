use std::path::{Path, PathBuf};

use canopi_types::dialog::FileKind;

/// Upper bound for one delivered export file, matching the Canvas PDF and GeoJSON caps.
pub const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

/// Upper bound for an imported GeoJSON file; the read stops one byte past it.
const MAX_GEOJSON_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

/// Resolve the destination path for `kind`, enforcing the host-side extension rule (2.1-M155):
/// - If `path` already has one of `kind`'s extensions (case-insensitive), use it as-is.
/// - If `path` has a different extension, refuse it so the boundary cannot overwrite a Design or
///   other unrelated file.
/// - If `path` has no extension, append `kind`'s primary extension and refuse with an `exists`
///   error when that appended file already exists on disk.
fn resolve_delivery_path(kind: FileKind, path: &Path) -> Result<PathBuf, String> {
    let allowed = kind.extensions();
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => {
            if allowed
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
            {
                Ok(path.to_path_buf())
            } else {
                Err(format!(
                    "Export destination for {} must have a .{} extension",
                    kind.literal(),
                    allowed.join(" or .")
                ))
            }
        }
        None => {
            let primary = allowed
                .first()
                .ok_or_else(|| format!("No extensions configured for {}", kind.literal()))?;
            let mut appended = path.as_os_str().to_os_string();
            appended.push(".");
            appended.push(primary);
            let appended_path = PathBuf::from(appended);
            if appended_path.exists() {
                return Err("exists: destination already exists".to_string());
            }
            Ok(appended_path)
        }
    }
}

/// Atomically write an exported payload chosen through the Save dialog (contracts §16,
/// 2.1-M154, 2.1-M155, 2.1-M522).
pub fn deliver_file(kind: FileKind, data: Vec<u8>, path: String) -> Result<String, String> {
    if data.len() > MAX_EXPORT_BYTES {
        return Err(format!(
            "Export exceeds the {} MiB limit",
            MAX_EXPORT_BYTES / (1024 * 1024)
        ));
    }
    if kind == FileKind::Pdf && (!data.starts_with(b"%PDF-") || !data.ends_with(b"%%EOF\n")) {
        return Err("Invalid Canvas PDF output".to_string());
    }
    let resolved = resolve_delivery_path(kind, Path::new(&path))?;
    crate::design::write_derived_file(&resolved, &data)
        .map_err(|error| format!("Could not write export: {error}"))?;
    Ok(resolved.display().to_string())
}

/// Read a user-chosen GeoJSON file as UTF-8 text. Decoding and validation
/// happen in the shared frontend codec; a leading UTF-8 BOM is dropped so both
/// editions hand it the same text. The path comes from the native dialog, never
/// from the webview; caller-supplied `extensions` are validated against
/// [`FileKind::Geojson`] so the webview can narrow (but never widen) the filter.
pub fn read_geojson_file(
    path: impl AsRef<Path>,
    extensions: Option<&[String]>,
) -> Result<String, String> {
    use std::io::Read;

    let canonical = FileKind::Geojson.extensions();
    let allowed: Vec<&str> = match extensions {
        Some(requested) if !requested.is_empty() => {
            let mut filtered = Vec::with_capacity(requested.len());
            for ext in requested {
                let normalized = ext.trim().trim_start_matches('.');
                let Some(matched) = canonical
                    .iter()
                    .find(|allowed_ext| allowed_ext.eq_ignore_ascii_case(normalized))
                else {
                    return Err(format!(
                        "Unsupported GeoJSON import extension .{normalized}"
                    ));
                };
                filtered.push(*matched);
            }
            filtered
        }
        _ => canonical.to_vec(),
    };

    let path = path.as_ref();
    if !path.extension().is_some_and(|extension| {
        allowed
            .iter()
            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
    }) {
        return Err("GeoJSON source must have a .geojson or .json extension".to_string());
    }
    let shown = path.display();
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open GeoJSON file {shown}: {e}"))?;
    if !file
        .metadata()
        .map_err(|e| format!("Failed to inspect GeoJSON file {shown}: {e}"))?
        .is_file()
    {
        return Err(format!("GeoJSON source {shown} is not a file"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_GEOJSON_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read GeoJSON file {shown}: {e}"))?;
    if bytes.len() as u64 > MAX_GEOJSON_IMPORT_BYTES {
        return Err(format!(
            "GeoJSON file {shown} exceeds the {} MiB import limit",
            MAX_GEOJSON_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let text =
        String::from_utf8(bytes).map_err(|_| format!("GeoJSON file {shown} is not UTF-8 text"))?;
    Ok(text
        .strip_prefix('\u{feff}')
        .map(str::to_owned)
        .unwrap_or(text))
}

#[cfg(test)]
mod tests {
    use super::{MAX_EXPORT_BYTES, MAX_GEOJSON_IMPORT_BYTES, deliver_file, read_geojson_file};
    use crate::test_scratch::TestScratch;
    use canopi_types::dialog::FileKind;
    use std::path::PathBuf;

    struct TempTestDir {
        root: TestScratch,
    }

    impl TempTestDir {
        fn new(label: &str) -> Self {
            Self {
                root: TestScratch::new(&format!("export-service-{label}")),
            }
        }

        fn file(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }
    }

    #[test]
    fn canvas_pdf_publishes_exact_bytes_and_replaces_only_the_requested_pdf() {
        let temp = TempTestDir::new("shared-pdf");
        let target = temp.file("plan.pdf");
        let unrelated = temp.file("garden.canopi");
        std::fs::write(&target, b"previous PDF").unwrap();
        std::fs::write(&unrelated, b"editable design").unwrap();
        let bytes = b"%PDF-1.7\n\0binary content\n%%EOF\n".to_vec();
        let written =
            deliver_file(FileKind::Pdf, bytes.clone(), target.display().to_string()).unwrap();
        assert_eq!(written, target.display().to_string());
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert_eq!(std::fs::read(&unrelated).unwrap(), b"editable design");
        assert_eq!(std::fs::read_dir(&temp.root).unwrap().count(), 2);
    }

    #[test]
    fn canvas_pdf_invalid_payload_or_destination_preserves_existing_files() {
        let temp = TempTestDir::new("shared-pdf-invalid");
        let target = temp.file("plan.pdf");
        std::fs::write(&target, b"original").unwrap();
        assert!(
            deliver_file(
                FileKind::Pdf,
                b"not a PDF".to_vec(),
                target.display().to_string()
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        let design = temp.file("garden.canopi");
        std::fs::write(&design, b"design").unwrap();
        let bytes = b"%PDF-1.7\n%%EOF\n".to_vec();
        assert!(deliver_file(FileKind::Pdf, bytes.clone(), design.display().to_string()).is_err());
        assert_eq!(std::fs::read(&design).unwrap(), b"design");
        let directory = temp.file("directory.pdf");
        std::fs::create_dir(&directory).unwrap();
        assert!(deliver_file(FileKind::Pdf, bytes, directory.display().to_string()).is_err());
        assert!(directory.is_dir());
        assert_eq!(std::fs::read_dir(&temp.root).unwrap().count(), 3);
    }

    #[test]
    fn deliver_file_replaces_only_the_requested_export_file() {
        let temp_dir = TempTestDir::new("text");
        let csv = temp_dir.file("budget.csv");
        let geojson = temp_dir.file("plan.GeoJSON");
        let json = temp_dir.file("plan.json");
        std::fs::write(&csv, b"previous").unwrap();

        for (kind, path) in [
            (FileKind::Csv, &csv),
            (FileKind::Geojson, &geojson),
            (FileKind::Geojson, &json),
        ] {
            let written =
                deliver_file(kind, b"hello".to_vec(), path.display().to_string()).unwrap();
            assert_eq!(written, path.display().to_string());
            assert_eq!(std::fs::read(path).unwrap(), b"hello");
        }
        assert_eq!(std::fs::read_dir(&temp_dir.root).unwrap().count(), 3);
    }

    #[test]
    fn deliver_file_appends_missing_extension_and_refuses_when_appended_exists() {
        let temp_dir = TempTestDir::new("append-ext");
        let bare = temp_dir.file("orchard");
        let written =
            deliver_file(FileKind::Csv, b"a,b".to_vec(), bare.display().to_string()).unwrap();
        let expected = temp_dir.file("orchard.csv");
        assert_eq!(written, expected.display().to_string());
        assert_eq!(std::fs::read(&expected).unwrap(), b"a,b");

        // Second write to the bare name must refuse with `exists` rather than overwrite orchard.csv.
        let err = deliver_file(
            FileKind::Csv,
            b"overwrite".to_vec(),
            bare.display().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("exists"), "{err}");
        assert_eq!(std::fs::read(&expected).unwrap(), b"a,b");
    }

    #[test]
    fn deliver_file_refuses_wrong_extensions_and_oversized_payloads() {
        let temp_dir = TempTestDir::new("text-refuse");
        let design = temp_dir.file("garden.canopi");
        std::fs::write(&design, b"design").unwrap();
        for name in ["garden.canopi", "notes.txt", "user.db"] {
            let path = temp_dir.file(name);
            assert!(
                deliver_file(FileKind::Csv, b"x".to_vec(), path.display().to_string())
                    .unwrap_err()
                    .contains("extension"),
                "{name}"
            );
        }
        assert_eq!(std::fs::read(&design).unwrap(), b"design");

        let directory = temp_dir.file("directory.csv");
        std::fs::create_dir(&directory).unwrap();
        assert!(
            deliver_file(
                FileKind::Csv,
                b"x".to_vec(),
                directory.display().to_string()
            )
            .is_err()
        );
        assert!(directory.is_dir());

        let oversized = temp_dir.file("oversized.csv");
        let error = deliver_file(
            FileKind::Csv,
            vec![b'x'; MAX_EXPORT_BYTES + 1],
            oversized.display().to_string(),
        )
        .unwrap_err();
        assert!(error.contains("limit"), "{error}");
        assert!(!oversized.exists());
        assert_eq!(std::fs::read_dir(&temp_dir.root).unwrap().count(), 2);
    }

    #[test]
    fn geojson_import_reads_utf8_text_without_a_byte_order_mark() {
        let temp_dir = TempTestDir::new("geojson-read");
        let plain = temp_dir.file("plain.geojson");
        let marked = temp_dir.file("marked.geojson");
        std::fs::write(&plain, "{\"type\":\"FeatureCollection\",\"features\":[]}").unwrap();
        std::fs::write(&marked, "\u{feff}{\"type\":\"Feature\"}").unwrap();

        assert_eq!(
            read_geojson_file(plain.display().to_string(), None).unwrap(),
            "{\"type\":\"FeatureCollection\",\"features\":[]}"
        );
        assert_eq!(
            read_geojson_file(marked.display().to_string(), None).unwrap(),
            "{\"type\":\"Feature\"}"
        );
    }

    #[test]
    fn geojson_import_reads_only_geojson_or_json_files_and_honours_caller_extensions() {
        let temp_dir = TempTestDir::new("geojson-extension");
        for name in [
            "id_ed25519",
            "credentials",
            "notes.txt",
            "garden.canopi",
            "user.db",
        ] {
            let other = temp_dir.file(name);
            std::fs::write(&other, "{\"type\":\"FeatureCollection\",\"features\":[]}").unwrap();
            let error = read_geojson_file(other.display().to_string(), None).unwrap_err();
            assert!(error.contains("extension"), "{name}: {error}");
        }
        for name in ["upper.GEOJSON", "plain.json"] {
            let accepted = temp_dir.file(name);
            std::fs::write(&accepted, "{}").unwrap();
            assert_eq!(
                read_geojson_file(accepted.display().to_string(), None).unwrap(),
                "{}"
            );
        }
        let json_only = temp_dir.file("narrow.json");
        std::fs::write(&json_only, "{}").unwrap();
        let geojson_only_ext = vec!["geojson".to_string()];
        assert!(
            read_geojson_file(&json_only, Some(&geojson_only_ext))
                .unwrap_err()
                .contains("extension")
        );
        let disallowed_ext = vec!["txt".to_string()];
        assert!(
            read_geojson_file(&json_only, Some(&disallowed_ext))
                .unwrap_err()
                .contains("Unsupported")
        );
    }

    #[test]
    fn geojson_import_refuses_non_text_directories_and_oversized_files() {
        let temp_dir = TempTestDir::new("geojson-refuse");
        let binary = temp_dir.file("binary.geojson");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_geojson_file(binary.display().to_string(), None).is_err());

        let directory = temp_dir.file("directory.geojson");
        std::fs::create_dir(&directory).unwrap();
        assert!(read_geojson_file(directory.display().to_string(), None).is_err());

        let oversized = temp_dir.file("oversized.geojson");
        std::fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_GEOJSON_IMPORT_BYTES + 1)
            .unwrap();
        assert!(
            read_geojson_file(oversized.display().to_string(), None)
                .unwrap_err()
                .contains("import limit")
        );

        assert!(
            read_geojson_file(temp_dir.file("missing.geojson").display().to_string(), None)
                .is_err()
        );
    }
}
