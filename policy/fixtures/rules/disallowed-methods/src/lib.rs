//! A planted violation of the disallowed-methods family: an exempted call to a disallowed method no entry lists.

#[expect(clippy::disallowed_methods, reason = "planted")]
pub fn planted() {
    let _thread = std::thread::spawn(|| ());
}
