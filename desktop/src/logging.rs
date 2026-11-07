use std::path::Path;
use tracing_appender::rolling;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

pub fn init(log_dir: &Path) {
    let file_appender = rolling::daily(log_dir, "canopi");

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(
            fmt::layer()
                .with_writer(file_appender)
                .with_ansi(false)
                .with_target(true),
        )
        .init();
}

#[cfg(test)]
mod tests {
    use super::init;
    use crate::test_scratch::TestScratch;
    use std::path::Path;

    #[test]
    #[ignore = "expected-fail 1a-c4 canopi-ouxd"]
    fn canopi_ouxd_plant_db_log_lines_carry_no_path() {
        let logs = TestScratch::new("logging-ouxd");
        init(logs.path());
        // The admitted line lib.rs writes at startup, through the one log layer.
        let db = Path::new("/home/ana/Applications/canopi/resources/canopi-core.db");
        tracing::info!("Plant DB admitted at {}", db.display());
        tracing::error!(
            "Failed to open plant DB at {}: file is not a database. Species search unavailable.",
            db.display()
        );
        let written: String = std::fs::read_dir(logs.path())
            .expect("the log folder lists")
            .map(|entry| {
                std::fs::read_to_string(entry.expect("a log file").path())
                    .expect("a log file reads")
            })
            .collect();
        assert!(
            written.contains("Plant DB admitted"),
            "the line reached the log: {written}"
        );
        assert!(
            !written.contains("/home/ana"),
            "a plant DB log line carries its path: {written}"
        );
    }
}
