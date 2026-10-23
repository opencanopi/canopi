// Recorded from desktop/src/native_command_policy.rs at fa9e24f91 (lines 748-754 and 1715-1775): doc comments and a
// test's raw strings that name #[expect]; none of them is an attribute, so the adapter finds no site here.
/// Every way to start a thread or reach a blocking pool. `clippy.toml` disallows each one
/// (`disallowed-methods`), and clippy resolves calls by type, so an alias, a re-export, a
/// macro body or a function value is caught as well as a plain call; the Rust gate runs
/// clippy with `-D warnings`. A reviewed escape (the executor's own pool call, the folder
/// opener's reaper, Tauri's generated context) carries a statement-level
/// `#[expect(clippy::disallowed_methods, reason = "...")]`, which fails when the escape goes,
/// and is listed in `BLOCKING_ESCAPE_ALLOWLIST`.
fn audit_fixture() {
        let violations = audit_escape_exemptions(&[
            (
                "src/services/fixture.rs",
                r#"
                    fn reviewed() {
                        #[expect(clippy::disallowed_methods, reason = "reaps the opener")]
                        let reaper = std::thread::Builder::new().spawn(work);
                        #[expect(clippy::disallowed_methods, reason = "joined at once")]
                        std::thread::Builder::new().spawn(work)?;
                    }
                    #[expect(clippy::disallowed_methods, reason = "covers every thread below")]
                    fn whole_function() { std::thread::spawn(work); std::thread::spawn(heavy); }
                    impl Opener {
                        #[allow(clippy::disallowed_methods)]
                        fn method(&self) { std::thread::spawn(work); }
                    }
                    fn unexplained() {
                        #[expect(clippy::disallowed_methods)]
                        let thread = std::thread::spawn(work);
                        #[expect(clippy::disallowed_methods, reason = " ")]
                        let blank = std::thread::spawn(work);
                        #[allow(clippy::style)]
                        let grouped = std::thread::spawn(work);
                    }
                    #[cfg(test)]
                    mod tests {
                        #![allow(clippy::disallowed_methods)]
                    }
                "#,
            ),
            (
                "src/lib.rs",
                "#![cfg_attr(test, allow(clippy::disallowed_methods))]\nmod services;",
            ),
            (
                "src/services/mod.rs",
                "#![cfg_attr(test, allow(clippy::disallowed_methods))]\nmod fixture;",
            ),
        ]);

        assert_eq!(
            violations,
            [
                exemption("#[allow(clippy::disallowed_methods)]"),
                exemption("#[allow(clippy::style)]"),
                exemption("#[expect(clippy::disallowed_methods)]"),
                exemption(r#"#[expect(clippy::disallowed_methods, reason = " ")]"#),
                exemption(
                    r#"#[expect(clippy::disallowed_methods, reason = "covers every thread below")]"#
                ),
                "an exemption from clippy::disallowed_methods must be one statement's #[expect] with a reason: src/services/mod.rs (#![cfg_attr(test, allow(clippy::disallowed_methods))])".to_owned(),
            ]
        );
    }
}
