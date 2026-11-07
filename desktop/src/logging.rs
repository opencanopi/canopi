//! The app log (ADR 0025 Logs): one redacting JSON `tracing` layer over fourteen daily files,
//! the panic hook, and the failure logger, the one place a native failure is logged at warn or
//! error (contracts §18 R15).
//!
//! - **Layer.** Each event is one JSON line (`ts`, `level`, `target`, its fields); every text
//!   field passes the generic redactor (`canopi-redact`), so a path reads `<path>` and a
//!   credential value `<redacted>`, whatever the call site formatted. Fields are formatted into
//!   a line the layer owns before any lock is taken, so a field whose `Display` panics never
//!   holds the file while the panic hook writes.
//! - **Files.** `canopi.<yyyy-mm-dd>` in the log folder, the 2.0 name, so the day's 2.0 file
//!   carries on and the pruner counts 2.0 files with the new ones: fourteen are kept, and only
//!   files named `canopi…` are counted or removed. A folder that cannot be opened logs to
//!   stderr instead, redacted the same way; a write that fails mid-session drops its line.
//! - **Panic hook.** Installed first, before anything can panic: the panic's redacted message
//!   and location, once, as an error line in the log, or on stderr before the log is open.
//!   std's own panic line is replaced, never repeated.

use canopi_redact::{RedactedText, Redactor};
use canopi_types::failure::{
    Failure, FailureCode, FailureLogLevel, IoFailureKind, Lane, OperationId,
};
use serde_json::{Map, Value};
use std::cell::Cell;
use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use tracing::field::{Field, Visit};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::format::Writer as TimeWriter;
use tracing_subscriber::fmt::time::{FormatTime, SystemTime};
use tracing_subscriber::layer::Context;
use tracing_subscriber::{EnvFilter, Layer, prelude::*};

/// The daily files' name before their date, the 2.0 name.
const LOG_FILE_PREFIX: &str = "canopi";

/// How many daily files are kept (ADR 0025 Logs).
const MAX_LOG_FILES: usize = 14;

/// The target of the panic hook's line.
const PANIC_TARGET: &str = "canopi::panic";

/// The target of the failure logger's settlement lines.
const SETTLEMENT_TARGET: &str = "canopi::settlement";

/// The op of the log's own open, logged when the folder falls back to stderr.
const LOG_OPEN_OP: &str = "logging.open";

/// How many failure settlements the ring keeps (ADR 0025: the last 50).
const RING_CAPACITY: usize = 50;

/// Where the log's lines go once it is open: the panic hook writes there too.
static SINK: OnceLock<Arc<Sink>> = OnceLock::new();

/// The last failure settlements, whatever became of their log lines.
static RING: SettlementRing = SettlementRing::new();

thread_local! {
    /// Set while this thread holds the sink, so a panic raised inside a write falls back to
    /// stderr instead of waiting on the lock its own thread holds.
    static WRITING: Cell<bool> = const { Cell::new(false) };
}

/// Where the log writes: the day's file, or stderr when the log folder could not be opened.
pub enum LogTarget {
    /// The daily files in the log folder.
    Files,
    /// Standard error, redacted the same way.
    Stderr,
}

/// Installs the panic hook. `main` calls it first, so a panic before the log opens still
/// reaches stderr, redacted.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(write_panic));
}

/// Opens the log in `log_dir` (stderr when there is none or it cannot be opened) and installs
/// the redacting layer as the global subscriber. A second call keeps the first log.
pub fn init(log_dir: Option<&Path>) -> LogTarget {
    let (target, sink, refused) = match log_dir.map(open_appender) {
        Some(Ok(appender)) => (LogTarget::Files, Sink::writer(appender), None),
        Some(Err(error)) => (LogTarget::Stderr, Sink::Stderr, Some(error)),
        None => (LogTarget::Stderr, Sink::Stderr, None),
    };
    let sink = Arc::clone(SINK.get_or_init(|| Arc::new(sink)));
    let _ = tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(RedactingLayer::new(sink))
        .try_init();
    if let Some(error) = refused {
        let io = std::error::Error::source(&error)
            .and_then(|source| source.downcast_ref::<std::io::Error>())
            .map_or(IoFailureKind::Other, |source| source.kind().into());
        let failure = Failure::new(FailureCode::Io { io }, LOG_OPEN_OP);
        log_failure(&failure.with_english(&error.to_string()), None);
    }
    target
}

/// The failure logger (contracts §18 R15): `failure` logged at its catalogue row's level with
/// the settlement fields, and kept among the last [`RING_CAPACITY`] for the problem report,
/// a cancel left out (2.1-M433). A panic's error line is the panic hook's, so its settlement
/// logs at info.
pub fn log_failure(failure: &Failure, lane: Option<Lane>) {
    let row = failure.code.row();
    let code = serde_json::to_string(&failure.code).unwrap_or_default();
    let operation = failure.operation.as_ref().map(OperationId::as_str);
    let detail = failure.detail.as_ref().map(RedactedText::as_str);
    let lane_name = lane.map(lane_name);
    macro_rules! settle {
        ($level:ident) => {
            tracing::$level!(
                target: SETTLEMENT_TARGET,
                op = failure.op,
                operation,
                lane = lane_name,
                settlement = row.kind,
                code = code.as_str(),
                detail,
                "Native operation settled",
            )
        };
    }
    match (row.level, &failure.code) {
        (_, FailureCode::Panicked) | (FailureLogLevel::Info, _) => settle!(info),
        (FailureLogLevel::Debug, _) => settle!(debug),
        (FailureLogLevel::Warn, _) => settle!(warn),
        (FailureLogLevel::Error, _) => settle!(error),
    }
    if failure.code != FailureCode::Cancelled {
        RING.keep(SettledFailure {
            failure: failure.clone(),
            lane,
        });
    }
}

/// The last native failure settlements, oldest first, for the problem report's native section.
pub fn recent_failures() -> Vec<SettledFailure> {
    let ring = RING.0.lock().unwrap_or_else(PoisonError::into_inner);
    ring.iter().cloned().collect()
}

/// One kept settlement: the failure as it crossed the seam, and its lane.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SettledFailure {
    pub failure: Failure,
    pub lane: Option<Lane>,
}

/// The last [`RING_CAPACITY`] failure settlements, in memory: a log write that fails never
/// loses one.
struct SettlementRing(Mutex<VecDeque<SettledFailure>>);

impl SettlementRing {
    const fn new() -> Self {
        Self(Mutex::new(VecDeque::new()))
    }

    fn keep(&self, settled: SettledFailure) {
        let mut ring = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if ring.len() == RING_CAPACITY {
            ring.pop_front();
        }
        ring.push_back(settled);
    }
}

const fn lane_name(lane: Lane) -> &'static str {
    match lane {
        Lane::Catalog => "catalog",
        Lane::UserData => "user_data",
        Lane::Library => "library",
        Lane::Local => "local",
        Lane::Network => "network",
    }
}

/// The daily file appender, pruning to [`MAX_LOG_FILES`] before it opens the day's file.
fn open_appender(
    log_dir: &Path,
) -> Result<RollingFileAppender, tracing_appender::rolling::InitError> {
    RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .max_log_files(MAX_LOG_FILES)
        .build(log_dir)
}

/// Where lines go. A failed write drops its line: logging never blocks or fails the work.
enum Sink {
    Writer(Mutex<Box<dyn Write + Send>>),
    Stderr,
}

impl Sink {
    fn writer(writer: impl Write + Send + 'static) -> Self {
        Self::Writer(Mutex::new(Box::new(writer)))
    }

    /// Writes `line` whole or drops it.
    fn write_line(&self, line: &[u8]) {
        match self {
            Self::Writer(writer) => {
                WRITING.with(|writing| writing.set(true));
                let mut writer = writer.lock().unwrap_or_else(PoisonError::into_inner);
                let _dropped_when_failed = writer.write_all(line).and_then(|()| writer.flush());
                drop(writer);
                WRITING.with(|writing| writing.set(false));
            }
            Self::Stderr => write_stderr(line),
        }
    }
}

fn write_stderr(line: &[u8]) {
    let _dropped_when_failed = std::io::stderr().write_all(line);
}

/// The JSON layer: every event one redacted line.
struct RedactingLayer {
    sink: Arc<Sink>,
    redactor: Redactor,
}

impl RedactingLayer {
    fn new(sink: Arc<Sink>) -> Self {
        Self {
            sink,
            redactor: Redactor::generic(),
        }
    }
}

impl<S: tracing::Subscriber> Layer<S> for RedactingLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let mut fields = RedactedFields {
            map: header(metadata.level().as_str(), metadata.target()),
            redactor: &self.redactor,
        };
        // Formatting runs here, before the sink is locked: a panicking field holds no lock.
        event.record(&mut fields);
        self.sink.write_line(&json_line(fields.map));
    }
}

/// A line's first fields: its time, level and target.
fn header(level: &str, target: &str) -> Map<String, Value> {
    let mut ts = String::new();
    let _ = SystemTime.format_time(&mut TimeWriter::new(&mut ts));
    let mut map = Map::new();
    map.insert("ts".to_owned(), Value::String(ts));
    map.insert("level".to_owned(), Value::String(level.to_owned()));
    map.insert("target".to_owned(), Value::String(target.to_owned()));
    map
}

fn json_line(map: Map<String, Value>) -> Vec<u8> {
    let mut line = serde_json::to_vec(&Value::Object(map)).unwrap_or_default();
    line.push(b'\n');
    line
}

/// An event's fields, each text one redacted.
struct RedactedFields<'a> {
    map: Map<String, Value>,
    redactor: &'a Redactor,
}

impl RedactedFields<'_> {
    fn insert_text(&mut self, field: &Field, text: &str) {
        let redacted = self.redactor.redact(text);
        self.map.insert(
            field.name().to_owned(),
            Value::String(redacted.as_str().to_owned()),
        );
    }
}

impl Visit for RedactedFields<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.insert_text(field, &format!("{value:?}"));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert_text(field, value);
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }
}

/// The panic hook: one redacted error line with the panic's message and location, in the log
/// or, before it opens (or from inside a write), on stderr.
fn write_panic(info: &std::panic::PanicHookInfo<'_>) {
    let redactor = Redactor::generic();
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a panic with no message");
    let mut map = header(tracing::Level::ERROR.as_str(), PANIC_TARGET);
    map.insert(
        "message".to_owned(),
        Value::String(redactor.redact(message).as_str().to_owned()),
    );
    if let Some(location) = info.location() {
        let location = format!(
            "{}:{}:{}",
            location.file(),
            location.line(),
            location.column()
        );
        map.insert(
            "location".to_owned(),
            Value::String(redactor.redact(&location).as_str().to_owned()),
        );
    }
    if let Some(thread) = std::thread::current().name() {
        map.insert(
            "thread".to_owned(),
            Value::String(redactor.redact(thread).as_str().to_owned()),
        );
    }
    let line = json_line(map);
    match SINK.get() {
        Some(sink) if !WRITING.with(Cell::get) => sink.write_line(&line),
        _ => write_stderr(&line),
    }
}

/// The last `max` lines of the daily files in `log_dir`, oldest first, each redacted
/// by `redactor` (the report's, which names this machine's folders): a JSON line is redacted
/// again, idempotently, and a 2.0 plain-text line, written before the layer, is redacted
/// here for the first time. Also how many could not be read (a file gone or locked since the
/// listing, or the folder itself), so the report marks its section rather than omitting it.
pub fn log_tail(log_dir: &Path, redactor: &Redactor, max: usize) -> (Vec<RedactedText>, usize) {
    use std::io::{Read, Seek, SeekFrom};
    const MAX_BYTES_PER_FILE: u64 = 256 * 1024;
    let Ok(entries) = std::fs::read_dir(log_dir) else {
        return (Vec::new(), 1);
    };
    let mut files: Vec<_> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(LOG_FILE_PREFIX))
        })
        .collect();
    // `canopi.<yyyy-mm-dd>` sorts by day.
    files.sort();
    let (mut tail, mut unreadable) = (Vec::new(), 0);
    for path in files.iter().rev() {
        let mut text = Vec::new();
        let read = std::fs::File::open(path).and_then(|mut file| {
            let start = file.metadata()?.len().saturating_sub(MAX_BYTES_PER_FILE);
            file.seek(SeekFrom::Start(start))?;
            file.read_to_end(&mut text).map(|_| start > 0)
        });
        let Ok(cut) = read else {
            unreadable += 1;
            continue;
        };
        let text = String::from_utf8_lossy(&text);
        // A line cut by the byte cap could hide a path's start from the redactor: it goes.
        let lines: Vec<_> = text.lines().skip(usize::from(cut)).collect();
        let room = max.saturating_sub(tail.len());
        tail.extend(lines.iter().rev().take(room).map(|l| redactor.redact(l)));
        if tail.len() == max {
            break;
        }
    }
    tail.reverse();
    (tail, unreadable)
}

/// The JSON lines the redacting layer writes for what `run` logs on this thread.
#[cfg(test)]
pub(crate) fn lines_of(run: impl FnOnce()) -> Vec<Value> {
    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let written = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::new(Sink::writer(Shared(Arc::clone(&written))));
    let subscriber = tracing_subscriber::registry().with(RedactingLayer::new(sink));
    tracing::subscriber::with_default(subscriber, run);
    let written = written.lock().unwrap();
    String::from_utf8_lossy(&written)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[cfg(test)]
mod tests {
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
        const TEST: &str =
            "a_log_folder_that_cannot_be_opened_logs_to_stderr_redacted_without_a_panic";
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
            for _ in 0..RING_CAPACITY {
                log_failure(&Failure::new(FailureCode::Internal, "probe.flood"), None);
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
}
