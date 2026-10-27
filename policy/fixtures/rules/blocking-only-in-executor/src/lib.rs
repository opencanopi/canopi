//! A planted violation of blocking-only-in-executor (§18 R2): an exempted thread outside the executor that no
//! disallowed-methods entry lists.

#[expect(clippy::disallowed_methods, reason = "planted")]
pub fn planted() {
    std::thread::scope(|_| ());
}
