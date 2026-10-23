// A planted violation of the suppressions family: an #[expect] no entry lists.
#[expect(clippy::expect_used, reason = "planted")]
fn planted() {}
