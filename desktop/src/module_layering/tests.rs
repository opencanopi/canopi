use std::path::Path;

use super::graph::{ModulePath, module_cycle_report, module_cycles, module_graph};
use super::{LayerException, audit_layering, audit_repository};

const NO_EXCEPTIONS: &[LayerException] = &[];

fn audit(sources: &[(&str, &str)]) -> Vec<String> {
    audit_layering(sources, NO_EXCEPTIONS)
}

#[test]
fn repository_modules_keep_their_layers() {
    let violations = audit_repository();
    assert!(
        violations.is_empty(),
        "native module layering violations:\n{}",
        violations.join("\n")
    );
}

#[test]
fn design_and_db_code_naming_services_fails() {
    let violations = audit(&[
        (
            "src/design/format.rs",
            "pub fn hash(bytes: &[u8]) -> String { crate::services::lidar::grid::sha256_hex(bytes) }",
        ),
        (
            "src/db/user_db.rs",
            "use crate::{services::settings::{self, Settings as Stored}};",
        ),
        (
            "src/db/query_builder/filters.rs",
            "fn read(_: &super::super::super::services::plant_browser::Query) {}",
        ),
        (
            "src/design/preview.rs",
            r#"fn log() { tracing::info!("{}", crate::services::export::label()); }"#,
        ),
        (
            "src/design/mod.rs",
            r#"fn saved() { tracing::debug!(fingerprint = %crate::services::export::digest(), "saved"); }"#,
        ),
        (
            "src/db/plant_db.rs",
            "fn sizes() -> Vec<u8> { vec![crate::services::lidar::grid::CELL; 4] }",
        ),
        ("src/design/stamps.rs", "use crate::services::x::*;"),
    ]);

    assert_eq!(
        violations,
        [
            "design and db code must not name crate::services: src/db/plant_db.rs names crate::services::lidar::grid::CELL",
            "design and db code must not name crate::services: src/db/query_builder/filters.rs names crate::services::plant_browser::Query",
            "design and db code must not name crate::services: src/db/user_db.rs names crate::services::settings",
            "design and db code must not name crate::services: src/db/user_db.rs names crate::services::settings::Settings",
            "design and db code must not name crate::services: src/design/format.rs names crate::services::lidar::grid::sha256_hex",
            "design and db code must not name crate::services: src/design/mod.rs names crate::services::export::digest",
            "design and db code must not name crate::services: src/design/preview.rs names crate::services::export::label",
            "design and db code must not name crate::services: src/design/stamps.rs names crate::services::x::*",
        ]
    );
}

#[test]
fn services_code_naming_commands_or_app_health_fails() {
    let violations = audit(&[
        (
            "src/services/lidar/inspection.rs",
            "fn sample() { crate::commands::lidar::lidar_sample_points(); }",
        ),
        (
            "src/services/health.rs",
            "use crate::AppHealth; pub fn get(health: &AppHealth) {}",
        ),
        (
            "src/services/mod.rs",
            "use super::commands as entry; mod health { fn read(_: super::super::AppHealth) {} }",
        ),
        (
            "src/services/lidar/mod.rs",
            r#"
                fn retry(error: &str) {
                    tracing::warn!(%error, kind = crate::commands::lidar::kind(), "retry");
                    tracing::debug!(mode = ?super::super::commands::lidar::mode(), "mode");
                    tracing::info!(health = ?super::super::AppHealth::default(), "health");
                }
            "#,
        ),
    ]);

    assert_eq!(
        violations,
        [
            "services code must not name AppHealth: src/services/health.rs names AppHealth",
            "services code must not name AppHealth: src/services/lidar/mod.rs names AppHealth",
            "services code must not name AppHealth: src/services/mod.rs names AppHealth",
            "services code must not name crate::commands: src/services/lidar/inspection.rs names crate::commands::lidar::lidar_sample_points",
            "services code must not name crate::commands: src/services/lidar/mod.rs names crate::commands::lidar::kind",
            "services code must not name crate::commands: src/services/lidar/mod.rs names crate::commands::lidar::mode",
            "services code must not name crate::commands: src/services/mod.rs names crate::commands",
        ]
    );
}

#[test]
fn allowed_directions_and_test_code_pass() {
    let violations = audit(&[
        (
            "src/lib.rs",
            "mod design; mod services; pub struct AppHealth;",
        ),
        ("src/design/mod.rs", "#[cfg(test)] mod checks;"),
        (
            "src/design/checks.rs",
            "fn probe() { crate::services::design_files::capture_logs(); }",
        ),
        (
            "src/design/drafts.rs",
            r#"
                pub fn list() { crate::design::format::read(); }
                #[cfg(test)]
                mod tests { fn probe() { crate::services::design_files::capture_logs(); } }
                #[cfg(test)]
                fn helper() { crate::services::export::label(); }
            "#,
        ),
        (
            "src/services/lidar/inspection.rs",
            r#"
                use crate::design::format;
                fn sample() {
                    #[cfg(test)]
                    crate::commands::lidar::hook();
                    crate::services::lidar::grid::sha256_hex(&[]);
                }
            "#,
        ),
        (
            "src/commands/health.rs",
            "use crate::{AppHealth, services::health};",
        ),
    ]);

    assert_eq!(violations, Vec::<String>::new());
}

#[test]
fn a_named_exception_excuses_only_its_breach_and_an_unused_one_fails() {
    let exceptions = [
        LayerException {
            path: "src/services/health.rs",
            name: "AppHealth",
            bead: "canopi-test.1",
            reason: "planted",
        },
        LayerException {
            path: "src/design/mod.rs",
            name: "crate::services::lidar::grid::sha256_hex",
            bead: "canopi-test.2",
            reason: "planted",
        },
    ];
    let violations = audit_layering(
        &[
            (
                "src/services/health.rs",
                "use crate::AppHealth; fn read() { crate::commands::health::get_health(); }",
            ),
            ("src/design/mod.rs", "fn fingerprint() {}"),
        ],
        &exceptions,
    );

    assert_eq!(
        violations,
        [
            "services code must not name crate::commands: src/services/health.rs names crate::commands::health::get_health",
            "unused layering exception: src/design/mod.rs names crate::services::lidar::grid::sha256_hex (canopi-test.2; planted)",
        ]
    );
}

fn cycles(sources: &[(&str, &str)]) -> Vec<Vec<String>> {
    module_cycles(&module_graph(sources))
        .into_iter()
        .map(|component| component.iter().map(|module| module.join("::")).collect())
        .collect()
}

#[test]
fn two_modules_naming_each_other_are_one_cycle_and_a_visibility_names_nothing() {
    assert_eq!(
        cycles(&[
            (
                "src/lib.rs",
                "mod a; mod b; mod c; pub fn start() { c::c(); }"
            ),
            ("src/a.rs", "use crate::b::Thing; pub fn run() {}"),
            (
                "src/b.rs",
                "pub struct Thing; fn back() { super::a::run(); }"
            ),
            ("src/c.rs", "pub(crate) fn c() {} pub(super) fn d() {}"),
        ]),
        [["a", "b"]]
    );
}

#[test]
fn a_three_module_ring_is_one_cycle_and_its_tail_is_none() {
    assert_eq!(
        cycles(&[
            ("src/lib.rs", "mod a; mod b; mod c; mod d;"),
            ("src/a.rs", "fn f() { crate::b::f(); }"),
            ("src/b.rs", "fn f() { crate::c::f(); }"),
            ("src/c.rs", "fn f() { crate::a::f(); }"),
            ("src/d.rs", "fn f() { crate::a::f(); }"),
        ]),
        [["a", "b", "c"]]
    );
}

#[test]
fn a_dag_has_no_cycle() {
    assert_eq!(
        cycles(&[
            ("src/lib.rs", "mod a; mod b; mod c;"),
            ("src/a.rs", "use crate::{b::f, c::g};"),
            ("src/b.rs", "use crate::c::g; pub fn f() {}"),
            ("src/c.rs", "pub fn g() {}"),
        ]),
        Vec::<Vec<String>>::new()
    );
}

#[test]
fn a_bare_child_path_is_an_edge_and_test_code_and_main_rs_are_no_nodes() {
    let sources = [
        (
            "src/lib.rs",
            "mod lidar; #[cfg(test)] mod checks; pub fn start() { lidar::run(); }",
        ),
        (
            "src/lidar/mod.rs",
            "mod import; fn run() { import::start(); }",
        ),
        ("src/lidar/import.rs", "use super::LIMIT; pub fn start() {}"),
        ("src/main.rs", "fn main() { canopi::run(); }"),
        ("src/checks.rs", "fn probe() { crate::lidar::run(); }"),
        (
            "src/lidar/report.rs",
            "#[cfg(test)] mod tests { fn t() { crate::lidar::import::start(); } }",
        ),
    ];
    let graph = module_graph(&sources);
    let module = |path: &str| -> ModulePath { path.split("::").map(str::to_owned).collect() };

    assert_eq!(cycles(&sources), [["lidar", "lidar::import"]]);
    assert!(
        !graph.contains_key(&module("checks")),
        "a test-only module is no node"
    );
    assert!(
        graph[&module("lidar::report")].is_empty(),
        "inline test code names nothing"
    );
    assert_eq!(
        graph[&Vec::new()],
        [module("lidar")].into(),
        "the binary's main.rs is no root"
    );
}

#[test]
fn a_single_segment_name_never_names_a_child_module() {
    // `format!`, a local, a field shorthand and a lone identifier in a macro body share the
    // child's name; only `format::…` would name it.
    assert_eq!(
        cycles(&[
            ("src/lib.rs", "mod design;"),
            (
                "src/design/mod.rs",
                r#"mod format; pub struct S { format: u8 }
                pub fn f() -> S { let format = 1; let _ = format!("x"); tracing::info!(format); S { format } }"#,
            ),
            ("src/design/format.rs", "fn g() { super::f(); }"),
        ]),
        Vec::<Vec<String>>::new()
    );
}

#[test]
fn the_report_prints_one_site_per_module_in_a_cycle_and_an_end_marker() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../policy/fixtures/rules/rust-scc");

    assert_eq!(
        module_cycle_report(&root),
        [
            r#"POLICY-SITE {"count":2,"key":"planted::a"}"#,
            r#"POLICY-SITE {"count":2,"key":"planted::b"}"#,
            "POLICY-SITES-END 2",
        ]
    );
}

/// The `rust-scc` family's reporter: `CANOPI_RUST_SCC_ROOT` names another crate directory (the
/// planted fixture) relative to the repository root; the adapter refuses output without the
/// end marker.
#[test]
#[ignore = "run by policy/adapters/rust-module-graph.mjs for the rust-scc family"]
fn report_module_cycles() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = std::env::var_os("CANOPI_RUST_SCC_ROOT").map_or_else(
        || manifest.to_path_buf(),
        |dir| manifest.join("..").join(dir),
    );
    let report = module_cycle_report(&root);
    let sites = report.len() - 1;
    assert_eq!(
        report.last(),
        Some(&format!("POLICY-SITES-END {sites}")),
        "the report ends with a marker counting its site lines"
    );
    for line in report {
        println!("{line}");
    }
}
