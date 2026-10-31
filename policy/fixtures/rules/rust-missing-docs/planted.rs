// A planted violation of the rust-missing-docs family: a fresh item-level #[expect] no entry lists, which
// fires as unlisted, and a module-level #![expect] the family refuses whatever its baseline (neutral).
#![expect(missing_docs, reason = "planted: covers every item below")]

#[expect(missing_docs, reason = "planted")]
pub struct Planted;
