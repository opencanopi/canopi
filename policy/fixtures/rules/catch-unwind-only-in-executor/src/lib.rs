//! A planted violation of catch-unwind-only-in-executor (§18 R22): a reasoned exemption containing a panic outside
//! the executor settlement that no disallowed-methods entry lists.

#[expect(clippy::disallowed_methods, reason = "planted")]
pub fn planted() -> bool {
    std::panic::catch_unwind(|| ()).is_ok()
}
