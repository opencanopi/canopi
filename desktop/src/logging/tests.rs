use super::*;
use crate::test_scratch::TestScratch;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const CHILD: &str = "CANOPI_LOGGING_TEST_CHILD";
const CHILD_DIR: &str = "CANOPI_LOGGING_TEST_DIR";

/// The log folder this test was handed when it runs as `test`'s child process.
fn as_child(test: &str) -> Option<PathBuf> {
    (std::env::var(CHILD).ok()? == test).then(|| std::env::var_os(CHILD_DIR).unwrap().into())
}

/// Runs `test` again in a child process: the panic hook and the global subscriber are the
/// process's, so no other test shares them. A child that hangs fails the test.
fn run_child(test: &str, dir: &Path) -> Output {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("logging::tests::{test}"), "--nocapture"])
        .env(CHILD, test)
        .env(CHILD_DIR, dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(60);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > until {
            child.kill().unwrap();
            panic!("the {test} child hung");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    output
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Every line of the daily files in `dir`, each one JSON object.
fn log_lines(dir: &Path) -> Vec<Value> {
    let mut lines = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file()
            && path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("canopi")
        {
            for line in std::fs::read_to_string(&path).unwrap().lines() {
                lines.push(serde_json::from_str(line).expect("each log line is JSON"));
            }
        }
    }
    lines
}

struct PanicsOnDisplay;

impl std::fmt::Display for PanicsOnDisplay {
    fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        panic!("Display panicked reading /home/ana/plan.canopi")
    }
}

#[test]
fn a_field_whose_display_panics_never_deadlocks_the_log() {
    const TEST: &str = "a_field_whose_display_panics_never_deadlocks_the_log";
    if let Some(dir) = as_child(TEST) {
        install_panic_hook();
        init(Some(&dir));
        let worker = std::thread::Builder::new()
            .name("worker".to_owned())
            .spawn(|| tracing::info!(field = %PanicsOnDisplay, "formatting panics"))
            .unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        while !worker.is_finished() {
            assert!(
                Instant::now() < until,
                "the panicking field deadlocked the log"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            worker.join().is_err(),
            "the field's panic reached its caller"
        );
        tracing::info!("the log still writes");
        return;
    }
    let logs = TestScratch::new("logging-display-panic");
    let child = run_child(TEST, logs.path());
    let lines = log_lines(logs.path());
    let panics: Vec<_> = lines
        .iter()
        .filter(|line| line["target"] == PANIC_TARGET)
        .collect();
    assert_eq!(panics.len(), 1, "one panic line: {lines:?}");
    assert_eq!(panics[0]["message"], "Display panicked reading <path>");
    assert_eq!(panics[0]["level"], "ERROR");
    assert_eq!(panics[0]["thread"], "worker");
    assert!(
        lines
            .iter()
            .any(|line| line["message"] == "the log still writes"),
        "{lines:?}"
    );
    assert!(
        !stderr(&child).contains("panicked at"),
        "std's own panic line is replaced"
    );
}

#[test]
fn canopi_ouxd_plant_db_log_lines_carry_no_path() {
    const TEST: &str = "canopi_ouxd_plant_db_log_lines_carry_no_path";
    if let Some(dir) = as_child(TEST) {
        init(Some(&dir));
        // lib.rs's startup lines, one formatted from a raw path as 2.0 wrote it.
        let db = Path::new("/home/ana/Applications/canopi/resources/canopi-core.db");
        tracing::info!(
            "Plant DB admitted at {}",
            canopi_types::sensitive::UserPath::from(db)
        );
        tracing::info!(
            "Failed to open plant DB at {}: file is not a database",
            db.display()
        );
        return;
    }
    let logs = TestScratch::new("logging-ouxd");
    run_child(TEST, logs.path());
    let lines = log_lines(logs.path());
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(
        lines[0]["message"]
            .as_str()
            .unwrap()
            .starts_with("Plant DB admitted at ")
    );
    assert_eq!(
        lines[1]["message"],
        "Failed to open plant DB at <path>: file is not a database"
    );
    let written = serde_json::to_string(&lines).unwrap();
    assert!(
        !written.contains("/home/ana"),
        "a plant DB log line carries its path: {written}"
    );
}

#[test]
fn a_log_folder_that_cannot_be_opened_logs_to_stderr_redacted_without_a_panic() {
    const TEST: &str = "a_log_folder_that_cannot_be_opened_logs_to_stderr_redacted_without_a_panic";
    if let Some(dir) = as_child(TEST) {
        // A file where the folder should be: neither it nor a day's file can be made.
        std::fs::write(&dir, "not a folder").unwrap();
        assert!(matches!(init(Some(&dir)), LogTarget::Stderr));
        tracing::info!("still logging about /home/ana/plan.canopi");
        return;
    }
    let scratch = TestScratch::new("logging-unwritable");
    let child = run_child(TEST, &scratch.join("logs"));
    let lines: Vec<Value> = stderr(&child)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let opened = lines
        .iter()
        .find(|line| line["op"] == LOG_OPEN_OP)
        .expect("the fallback is logged");
    assert_eq!(
        (&opened["level"], &opened["settlement"]),
        (&Value::from("WARN"), &Value::from("io"))
    );
    assert!(
        lines
            .iter()
            .any(|line| line["message"] == "still logging about <path>"),
        "{lines:?}"
    );
    assert!(!stderr(&child).contains("/home/ana"), "{}", stderr(&child));
}

#[test]
fn a_panic_before_setup_writes_one_redacted_line_to_stderr() {
    const TEST: &str = "a_panic_before_setup_writes_one_redacted_line_to_stderr";
    if as_child(TEST).is_some() {
        install_panic_hook();
        let early = std::thread::spawn(|| panic!("early panic reading /home/ana/plan.canopi"));
        assert!(early.join().is_err());
        return;
    }
    let scratch = TestScratch::new("logging-early-panic");
    let child = run_child(TEST, scratch.path());
    let panics: Vec<Value> = stderr(&child)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|line| line["target"] == PANIC_TARGET)
        .collect();
    assert_eq!(panics.len(), 1, "{}", stderr(&child));
    assert_eq!(panics[0]["message"], "early panic reading <path>");
    assert!(!stderr(&child).contains("/home/ana"), "{}", stderr(&child));
}

#[test]
fn a_panic_in_an_executor_job_writes_one_error_line_and_one_settlement() {
    use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};
    const TEST: &str = "a_panic_in_an_executor_job_writes_one_error_line_and_one_settlement";
    if let Some(dir) = as_child(TEST) {
        install_panic_hook();
        init(Some(&dir));
        let settled = tauri::async_runtime::block_on(
            NativeOperationExecutor::production().run_typed::<(), Failure, _>(
                NativeOperationClass::Local,
                "probe.panicking_job",
                || panic!("job panicked reading /home/ana/plan.canopi"),
            ),
        );
        assert_eq!(settled.unwrap_err().code, FailureCode::Panicked);
        let kept = recent_failures();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(
            (kept[0].failure.op, kept[0].lane),
            ("probe.panicking_job", Some(Lane::Local))
        );
        return;
    }
    let logs = TestScratch::new("logging-executor-panic");
    run_child(TEST, logs.path());
    let lines = log_lines(logs.path());
    let errors: Vec<_> = lines
        .iter()
        .filter(|line| line["level"] == "ERROR")
        .collect();
    assert_eq!(errors.len(), 1, "{lines:?}");
    assert_eq!(errors[0]["message"], "job panicked reading <path>");
    let settlements: Vec<_> = lines
        .iter()
        .filter(|line| line["target"] == SETTLEMENT_TARGET)
        .collect();
    assert_eq!(settlements.len(), 1, "{lines:?}");
    assert_eq!(settlements[0]["settlement"], "panicked");
    assert_eq!(settlements[0]["op"], "probe.panicking_job");
    assert!(
        settlements[0].get("detail").is_none(),
        "the settlement repeats no panic text"
    );
}

/// A writer whose disk is full.
struct FullDisk;

impl Write for FullDisk {
    fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
        Err(std::io::ErrorKind::StorageFull.into())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn a_log_file_deleted_or_full_mid_session_drops_lines_and_keeps_every_settlement() {
    const TEST: &str =
        "a_log_file_deleted_or_full_mid_session_drops_lines_and_keeps_every_settlement";
    if let Some(dir) = as_child(TEST) {
        init(Some(&dir));
        // Windows refuses to delete the open file: there the line lands, nothing else differs.
        for entry in std::fs::read_dir(&dir).unwrap() {
            let _ = std::fs::remove_file(entry.unwrap().path());
        }
        let started = Instant::now();
        log_failure(&Failure::new(FailureCode::Internal, "probe.deleted"), None);
        let full = tracing_subscriber::registry()
            .with(RedactingLayer::new(Arc::new(Sink::writer(FullDisk))));
        tracing::subscriber::with_default(full, || {
            let failure = Failure::new(
                FailureCode::Io {
                    io: IoFailureKind::NoSpace,
                },
                "probe.full",
            );
            log_failure(&failure, Some(Lane::Local));
            log_failure(
                &Failure::new(FailureCode::Cancelled, "probe.cancelled"),
                None,
            );
        });
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a failed write blocked"
        );
        let kept: Vec<_> = recent_failures()
            .iter()
            .map(|kept| kept.failure.op)
            .collect();
        assert_eq!(
            kept,
            ["probe.deleted", "probe.full"],
            "every settlement kept, a cancel left out"
        );
        for flood in 0..RING_CAPACITY {
            let failure = Failure::new(FailureCode::Internal, "probe.flood");
            log_failure(&failure.with_english(&format!("flood {flood}")), None);
        }
        let kept = recent_failures();
        assert_eq!(kept.len(), RING_CAPACITY);
        assert!(
            kept.iter().all(|kept| kept.failure.op == "probe.flood"),
            "the oldest go first"
        );
        return;
    }
    let logs = TestScratch::new("logging-mid-session");
    run_child(TEST, logs.path());
    if cfg!(unix) {
        assert!(
            log_lines(logs.path()).is_empty(),
            "the deleted file's lines are dropped"
        );
    }
}

#[test]
fn a_2_0_plain_text_line_holding_a_home_path_reaches_the_tail_redacted() {
    let logs = TestScratch::new("logging-tail");
    let older =
        "2026-10-01T08:00:00Z  INFO canopi: Plant DB admitted at /home/ana/canopi-core.db\n";
    std::fs::write(logs.join("canopi.2026-10-01"), older).unwrap();
    let today = lines_of(|| tracing::info!("Saved /home/ana/Designs/plan.canopi"));
    let today = format!("{}\n", serde_json::to_string(&today[0]).unwrap());
    std::fs::write(logs.join("canopi.2026-10-02"), today).unwrap();
    std::fs::write(logs.join("notes.txt"), "/home/ana/elsewhere\n").unwrap();
    let home = canopi_redact::NamedFolder::Home;
    let redactor = Redactor::with_roots([(home, Path::new("/home/ana"))]);

    let (tail, unreadable) = log_tail(logs.path(), &redactor, 10);
    assert_eq!(unreadable, 0);
    let tail: Vec<&str> = tail.iter().map(RedactedText::as_str).collect();
    assert_eq!(tail.len(), 2, "{tail:?}");
    assert!(
        tail[0].ends_with("Plant DB admitted at <home-dir>"),
        "{tail:?}"
    );
    let line: Value = serde_json::from_str(tail[1]).expect("a JSON line stays JSON");
    assert_eq!(line["message"], "Saved <path>");
    assert_eq!(
        log_tail(logs.path(), &redactor, 1).0.len(),
        1,
        "the newest line only"
    );
}

#[test]
fn twenty_old_daily_files_leave_fourteen_and_no_other_file_is_touched() {
    let logs = TestScratch::new("logging-prune");
    for day in 1..=20 {
        std::fs::write(
            logs.join(format!("canopi.2025-01-{day:02}")),
            "a 2.0 line\n",
        )
        .unwrap();
    }
    std::fs::write(logs.join("notes.txt"), "kept").unwrap();
    std::fs::write(logs.join("engine-1-out.log"), "kept").unwrap();
    std::fs::create_dir(logs.join("canopi.2025-02-01")).unwrap();
    drop(open_appender(logs.path()).unwrap());
    let daily = std::fs::read_dir(logs.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("canopi.")
        })
        .count();
    assert_eq!(daily, MAX_LOG_FILES, "13 old daily files and the day's own");
    for kept in ["notes.txt", "engine-1-out.log", "canopi.2025-02-01"] {
        assert!(logs.join(kept).exists(), "{kept} is untouched");
    }
}

/// 2.1-M459 on the native ring: a repeat (same lane, code, op and redacted detail) counts on
/// its held entry and takes the newest place, so a burst of busy refusals never pushes out the
/// failure the user is reporting; the operation stays out of the key.
#[test]
fn canopi_f47t_52_36_repeated_busy_settlements_keep_the_earlier_failure_in_the_ring() {
    let ring = SettlementRing::new();
    let settled = |failure: Failure, lane| SettledFailure {
        failure,
        lane,
        count: 1,
    };
    ring.keep(settled(
        Failure::new(FailureCode::Internal, "probe.catalog_open"),
        None,
    ));
    let busy = Failure::new(
        FailureCode::Busy {
            lane: Lane::Catalog,
        },
        "probe.search",
    );
    let mut newest = None;
    for _ in 0..60 {
        let operation = OperationId::system();
        newest = Some(operation.clone());
        ring.keep(settled(
            busy.clone().with_operation(operation),
            Some(Lane::Catalog),
        ));
    }
    ring.keep(settled(
        busy.clone().with_english("a different reason"),
        Some(Lane::Catalog),
    ));

    let kept = ring.held();
    let summary: Vec<_> = kept
        .iter()
        .map(|kept| (kept.failure.op, kept.failure.detail.is_some(), kept.count))
        .collect();
    assert_eq!(
        summary,
        [
            ("probe.catalog_open", false, 1),
            ("probe.search", false, 60),
            ("probe.search", true, 1),
        ]
    );
    assert_eq!(
        kept[1].failure.operation, newest,
        "the newest occurrence's operation"
    );
}
