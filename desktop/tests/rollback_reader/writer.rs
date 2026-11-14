//! The rollback harness's writer of the frozen fixtures, beside the reader in `rollback_reader.rs` (Step 2.0.4 R4,
//! canopi-f47t.52.239): for every store no build writes yet it lays down each row of `spec/rollback/manifest.json` from
//! its frozen form and reports each `FIXTURES-ONLY`.

use std::path::{Path, PathBuf};

use crate::reader::{DESKTOP_STORES, Form, Scratch, WEB_STORES, files, manifest_forms, repository};

/// Runs `sql` into a new SQLite file at `path`, in WAL mode when `wal`, and closes it (a clean close leaves no
/// `-wal` or `-shm`).
fn sqlite(path: &Path, sql: &str, wal: bool) -> rusqlite::Connection {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    assert!(
        !path.exists(),
        "the writer never writes over {}",
        path.display()
    );
    let connection = rusqlite::Connection::open(path).unwrap();
    if wal {
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
    }
    connection.execute_batch(sql).unwrap();
    connection
}

fn copy(source: &str, target: &Path) {
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    assert!(
        !target.exists(),
        "the writer never writes over {}",
        target.display()
    );
    std::fs::copy(repository().join(source), target).unwrap();
}

fn frozen_sql(name: &str) -> String {
    std::fs::read_to_string(
        repository()
            .join("desktop/src/test_fixtures/frozen")
            .join(name),
    )
    .unwrap()
}

/// The writer for every store no build writes yet: lays down each row of `spec/rollback/manifest.json` from its
/// frozen form in `dest`, with the manifest beside them, and returns one `FIXTURES-ONLY` line per row.
pub(crate) fn write_frozen_fixtures(dest: &Path) -> Vec<String> {
    let manifest = repository().join("spec/rollback/manifest.json");
    let forms = manifest_forms(&manifest);
    std::fs::create_dir_all(dest).unwrap();
    std::fs::copy(&manifest, dest.join("manifest.json")).unwrap();
    let mut report = Vec::new();
    // The settings record lives in the user DB on Desktop, so its row names the user DB's file and is written there.
    let mut desktop_settings = Vec::new();
    for form in &forms {
        let target = dest.join(&form.path);
        match (form.edition.as_str(), form.store.as_str()) {
            ("desktop", "canopi_file" | "desktop_draft") => {
                copy("canopi-format/spec/v10/read-fixture.canopi", &target);
            }
            ("desktop", "user_db") => {
                drop(sqlite(&target, &frozen_sql("user-db-10.sql"), false));
            }
            ("desktop", "settings") => desktop_settings.push(target.clone()),
            ("desktop", "library_catalogue") => {
                drop(sqlite(&target, &frozen_sql("catalogue-26.sql"), true));
            }
            ("web", "settings") => copy("spec/web/frozen/settings.json", &target),
            ("web", "web_drafts") => copy("spec/web/frozen/drafts.json", &target),
            ("web", "web_species_lists") => copy("spec/web/frozen/species-lists.json", &target),
            (edition, store) => {
                panic!("the writer has no frozen form for the {edition} {store} row")
            }
        }
        report.push(format!(
            "FIXTURES-ONLY {} {} {} {}: no build writes it yet, so the readers read its frozen form",
            form.edition, form.store, form.form_version, form.path
        ));
    }
    for user_db in desktop_settings {
        assert!(
            user_db.is_file(),
            "the Desktop settings row names the user DB's file, {}",
            user_db.display()
        );
        let record: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                repository().join("desktop/src/test_fixtures/frozen/settings-record-2.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let connection = rusqlite::Connection::open(&user_db).unwrap();
        let changed = connection
            .execute(
                "UPDATE settings SET value = ?1 WHERE key = 'settings'",
                [record.to_string()],
            )
            .unwrap();
        assert_eq!(changed, 1, "user DB 10 holds the settings row");
    }
    report
}

#[test]
fn r4_canopi_f47t_52_239_the_writer_lays_down_every_frozen_form_the_manifest_lists_and_reports_each_fixtures_only()
 {
    let scratch = Scratch::new("writer");
    let dest = std::env::var_os("CANOPI_ROLLBACK_WRITE")
        .map(PathBuf::from)
        .unwrap_or_else(|| scratch.0.join("fixtures"));
    let report = write_frozen_fixtures(&dest);
    for line in &report {
        println!("{line}");
    }

    let forms = manifest_forms(&dest.join("manifest.json"));
    assert_eq!(report.len(), forms.len(), "one report line per row");
    for (store, edition) in DESKTOP_STORES
        .iter()
        .map(|store| (store, "desktop"))
        .chain(WEB_STORES.iter().map(|store| (store, "web")))
    {
        assert!(
            forms
                .iter()
                .any(|form| &form.store == store && form.edition == edition),
            "the manifest lists a {edition} {store} form"
        );
    }
    for form in &forms {
        assert!(dest.join(&form.path).is_file(), "{} is written", form.path);
        assert!(
            report.iter().any(|line| line.starts_with(&format!(
                "FIXTURES-ONLY {} {} {} {}:",
                form.edition, form.store, form.form_version, form.path
            ))),
            "{} {} is reported fixtures only",
            form.edition,
            form.store
        );
    }
    assert_each_desktop_form_at_its_version(&dest, &forms);
}

/// Each frozen Desktop form is at the version its row names, so a reader opening it reads a newer form, and the
/// writer's clean close leaves no SQLite sidecar for the lane to mistake for a reader's write.
fn assert_each_desktop_form_at_its_version(dest: &Path, forms: &[Form]) {
    let path = |store: &str, edition: &str| {
        dest.join(
            &forms
                .iter()
                .find(|form| form.store == store && form.edition == edition)
                .unwrap()
                .path,
        )
    };
    let version = |store: &str, edition: &str| {
        forms
            .iter()
            .find(|form| form.store == store && form.edition == edition)
            .unwrap()
            .form_version
    };
    for store in ["canopi_file", "desktop_draft"] {
        let design: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path(store, "desktop")).unwrap())
                .unwrap();
        assert_eq!(
            design["version"].as_u64(),
            Some(version(store, "desktop")),
            "{store}"
        );
    }
    let user_db = rusqlite::Connection::open_with_flags(
        path("user_db", "desktop"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let user_version: i64 = user_db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(
        user_version.to_string(),
        version("user_db", "desktop").to_string()
    );
    let settings: String = user_db
        .query_row(
            "SELECT value FROM settings WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let settings: serde_json::Value = serde_json::from_str(&settings).unwrap();
    assert_eq!(
        settings["version"].as_u64(),
        Some(version("settings", "desktop"))
    );
    let catalogue = rusqlite::Connection::open_with_flags(
        path("library_catalogue", "desktop"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let schema: String = catalogue
        .query_row(
            "SELECT value FROM lidar_catalogue_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(schema, version("library_catalogue", "desktop").to_string());
    drop((user_db, catalogue));
    assert!(
        files(dest).keys().all(|file| {
            let name = file.to_string_lossy();
            !name.ends_with("-wal") && !name.ends_with("-journal")
        }),
        "the writer leaves no SQLite sidecar"
    );
}
