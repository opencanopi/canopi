// A planted violation of the rust-too-many-lines family: a fresh item-level #[expect] no entry lists, which
// fires as unlisted, and a module-level #![expect] the family refuses whatever its baseline (neutral).
#![expect(clippy::too_many_lines, reason = "planted: covers every item below")]

#[expect(clippy::too_many_lines, reason = "planted")]
fn planted() {}
