use canopi_types::dialog::FileKind;
use canopi_types::failure::{Failure, FailureCode, IoFailureKind, ops};
use tauri::State;

use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};
use crate::services::export::{MAX_EXPORT_BYTES, is_deliverable_kind};

const DELIVERY_KIND_HEADER: &str = "x-canopi-delivery-kind";
const DELIVERY_PATH_HEADER: &str = "x-canopi-delivery-path";

fn invalid_delivery(detail: &str) -> Failure {
    Failure::new(FailureCode::Invalid, ops::EXPORT_DELIVER_FILE).with_english(detail)
}

fn percent_decode_utf8(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return Err("Invalid percent-encoding in delivery path header".to_string());
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| "Invalid percent-encoding in delivery path header".to_string())?;
            let value = u8::from_str_radix(hex, 16)
                .map_err(|_| "Invalid percent-encoding in delivery path header".to_string())?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Delivery path header is not valid UTF-8".to_string())
}

fn parse_deliver_file_request(
    headers: &tauri::http::HeaderMap,
    body: &tauri::ipc::InvokeBody,
) -> Result<(FileKind, String, Vec<u8>), Failure> {
    let kind_literal = headers
        .get(DELIVERY_KIND_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| invalid_delivery("Missing delivery kind header"))?;
    let kind = FileKind::from_literal(kind_literal)
        .filter(|parsed| is_deliverable_kind(*parsed))
        .ok_or_else(|| invalid_delivery("Unsupported delivery kind"))?;
    let raw_path = headers
        .get(DELIVERY_PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| invalid_delivery("Missing delivery path header"))?;
    let path = percent_decode_utf8(raw_path).map_err(|msg| invalid_delivery(&msg))?;
    let data = match body {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            if bytes.len() > MAX_EXPORT_BYTES {
                return Err(Failure::new(
                    FailureCode::Io {
                        io: IoFailureKind::TooLarge,
                    },
                    ops::EXPORT_DELIVER_FILE,
                )
                .with_english("Export exceeds the 64 MiB limit"));
            }
            bytes.clone()
        }
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(invalid_delivery("ipc_body_not_raw"));
        }
    };
    Ok((kind, path, data))
}

/// Deliver a binary or UTF-8 payload to a Save-dialog destination over a raw binary IPC body
/// (contracts §16, 2.1-M154, 2.1-M155, 2.1-M522).
#[tauri::command]
pub async fn deliver_file(
    request: tauri::ipc::Request<'_>,
    executor: State<'_, NativeOperationExecutor>,
) -> Result<String, Failure> {
    let (kind, path, data) = parse_deliver_file_request(request.headers(), request.body())?;
    deliver_file_with_executor(executor.inner(), kind, data, path).await
}

async fn deliver_file_with_executor(
    executor: &NativeOperationExecutor,
    kind: FileKind,
    data: Vec<u8>,
    path: String,
) -> Result<String, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            ops::EXPORT_DELIVER_FILE,
            move || crate::services::export::deliver_file(kind, data, path),
        )
        .await
}

/// A GeoJSON file the user chose in the native dialog, read for the shared
/// frontend codec.
#[derive(serde::Serialize)]
pub struct GeoJsonSource {
    name: String,
    text: String,
}

/// Show the host's GeoJSON Open dialog and read the chosen file. The path never
/// crosses to the webview, so page script cannot ask for any other file.
/// `None` means the user cancelled.
#[tauri::command]
pub async fn pick_geojson_file(
    window: tauri::WebviewWindow,
    executor: State<'_, NativeOperationExecutor>,
    dialogs: State<'_, crate::host::dialogs::HostDialogs>,
    extensions: Option<Vec<String>>,
) -> Result<Option<GeoJsonSource>, String> {
    let Some(path) = crate::host::dialogs::pick_host_read(
        executor.inner(),
        dialogs.inner(),
        window.label(),
        canopi_types::dialog::DialogKind::GeojsonImport,
    )
    .await?
    else {
        return Ok(None);
    };
    executor
        .run(NativeOperationClass::Local, "GeoJSON import", move || {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string());
            let text = crate::services::export::read_geojson_file(path, extensions.as_deref())?;
            Ok(Some(GeoJsonSource { name, text }))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::{
        DELIVERY_KIND_HEADER, DELIVERY_PATH_HEADER, deliver_file_with_executor,
        parse_deliver_file_request, percent_decode_utf8,
    };
    use crate::native_operation::{
        NativeOperationClass, NativeOperationClassLimits, NativeOperationExecutor,
        NativeOperationLimits,
    };
    use crate::services::export::MAX_EXPORT_BYTES;
    use crate::test_scratch::TestScratch;
    use canopi_types::dialog::FileKind;
    use canopi_types::failure::{FailureCode, Lane};
    use std::sync::mpsc;
    use std::task::{Context, Poll, Waker};
    use std::time::Duration;
    use std::{future::Future, path::PathBuf};
    use tauri::http::{HeaderMap, HeaderValue};
    use tauri::ipc::InvokeBody;

    const WAIT_TIMEOUT: Duration = Duration::from_secs(2);

    struct TempTestDir {
        root: TestScratch,
    }

    impl TempTestDir {
        fn new(label: &str) -> Self {
            Self {
                root: TestScratch::new(&format!("export-command-{label}")),
            }
        }

        fn file(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }
    }

    fn local_test_executor(admitted: usize, running: usize) -> NativeOperationExecutor {
        let limits = NativeOperationClassLimits::new(admitted, running);
        NativeOperationExecutor::new(NativeOperationLimits::new(
            limits, limits, limits, limits, limits,
        ))
        .unwrap()
    }

    #[test]
    fn percent_decode_handles_unicode_paths_and_rejects_malformed_sequences() {
        assert_eq!(
            percent_decode_utf8("/tmp/Caf%C3%A9%20Plan.pdf").unwrap(),
            "/tmp/Café Plan.pdf"
        );
        assert!(percent_decode_utf8("/tmp/bad%2").is_err());
        assert!(percent_decode_utf8("/tmp/bad%ZZ").is_err());
        assert!(percent_decode_utf8("/tmp/bad%+A").is_err());
    }

    #[test]
    fn parse_deliver_file_request_validates_headers_kinds_and_raw_body() {
        let raw = InvokeBody::Raw(b"a,b".to_vec());
        let empty = HeaderMap::new();
        assert_eq!(
            parse_deliver_file_request(&empty, &raw).unwrap_err().code,
            FailureCode::Invalid
        );

        let headers_with = |kind: Option<&str>, path: Option<&str>| {
            let mut map = HeaderMap::new();
            if let Some(k) = kind {
                map.insert(DELIVERY_KIND_HEADER, HeaderValue::from_str(k).unwrap());
            }
            if let Some(p) = path {
                map.insert(DELIVERY_PATH_HEADER, HeaderValue::from_str(p).unwrap());
            }
            map
        };

        for bad_kind in ["unknown", "canopi", "geotiff", "zip"] {
            let h = headers_with(Some(bad_kind), Some("%2Ftmp%2Fout.csv"));
            assert_eq!(
                parse_deliver_file_request(&h, &raw).unwrap_err().code,
                FailureCode::Invalid,
                "{bad_kind}"
            );
        }

        let missing_path = headers_with(Some("csv"), None);
        assert_eq!(
            parse_deliver_file_request(&missing_path, &raw)
                .unwrap_err()
                .code,
            FailureCode::Invalid
        );

        let valid_headers = headers_with(Some("csv"), Some("%2Ftmp%2Fout.csv"));
        let json_err = parse_deliver_file_request(
            &valid_headers,
            &InvokeBody::Json(serde_json::json!([1, 2, 3])),
        )
        .unwrap_err();
        assert_eq!(json_err.code, FailureCode::Invalid);
        assert_eq!(
            json_err.detail.as_ref().map(|d| d.as_str()),
            Some("ipc_body_not_raw")
        );

        let oversized = InvokeBody::Raw(vec![0u8; MAX_EXPORT_BYTES + 1]);
        assert_eq!(
            parse_deliver_file_request(&valid_headers, &oversized)
                .unwrap_err()
                .code,
            FailureCode::Io {
                io: super::IoFailureKind::TooLarge,
            }
        );

        let (kind, path, bytes) = parse_deliver_file_request(&valid_headers, &raw).unwrap();
        assert_eq!(kind, FileKind::Csv);
        assert_eq!(path, "/tmp/out.csv");
        assert_eq!(bytes, b"a,b");
    }

    #[test]
    fn queued_delivery_yields_without_publishing_before_local_capacity() {
        tauri::async_runtime::block_on(async {
            let executor = local_test_executor(2, 1);
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let blocking_executor = executor.clone();
            let blocker = tauri::async_runtime::spawn(async move {
                blocking_executor
                    .run(
                        NativeOperationClass::Local,
                        "test export blocker",
                        move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(())
                        },
                    )
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let temp_dir = TempTestDir::new("queued-local");
            let text_path = temp_dir.file("queued.csv");
            let mut export = Box::pin(deliver_file_with_executor(
                &executor,
                FileKind::Csv,
                b"hello".to_vec(),
                text_path.display().to_string(),
            ));
            {
                let mut context = Context::from_waker(Waker::noop());
                assert!(matches!(export.as_mut().poll(&mut context), Poll::Pending));
            }
            assert!(!text_path.exists());

            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();
            assert_eq!(export.await.unwrap(), text_path.display().to_string());
            assert_eq!(std::fs::read(text_path).unwrap(), b"hello");
        });
    }

    #[test]
    fn busy_delivery_rejects_before_validation_or_publication() {
        tauri::async_runtime::block_on(async {
            let executor = local_test_executor(1, 1);
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let blocking_executor = executor.clone();
            let blocker = tauri::async_runtime::spawn(async move {
                blocking_executor
                    .run(
                        NativeOperationClass::Local,
                        "test export blocker",
                        move || {
                            started_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                            Ok(())
                        },
                    )
                    .await
            });
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

            let temp_dir = TempTestDir::new("busy-local");
            let text_path = temp_dir.file("rejected.csv");
            let error = deliver_file_with_executor(
                &executor,
                FileKind::Csv,
                b"must not be written".to_vec(),
                text_path.display().to_string(),
            )
            .await
            .unwrap_err();

            assert_eq!(error.code, FailureCode::Busy { lane: Lane::Local });
            assert!(!text_path.exists());

            release_tx.send(()).unwrap();
            blocker.await.unwrap().unwrap();
        });
    }

    #[test]
    fn executor_backed_delivery_writes_through_service_boundary() {
        let temp_dir = TempTestDir::new("files");
        let text_path = temp_dir.file("export.csv");
        let executor = local_test_executor(1, 1);

        tauri::async_runtime::block_on(deliver_file_with_executor(
            &executor,
            FileKind::Csv,
            b"hello".to_vec(),
            text_path.display().to_string(),
        ))
        .unwrap();

        assert_eq!(std::fs::read(text_path).unwrap(), b"hello");
    }
}
