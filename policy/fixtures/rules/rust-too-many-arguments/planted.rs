// A planted violation of the rust-too-many-arguments family: a fresh item-level #[expect] no entry lists, which
// fires as unlisted, and a module-level #![expect] the family refuses whatever its baseline (neutral).
#![expect(clippy::too_many_arguments, reason = "planted: covers every item below")]

#[expect(clippy::too_many_arguments, reason = "planted")]
fn planted() {}
