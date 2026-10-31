// The planted rust-test-has-assertion violation: a test that only unwraps, in a file its family does not list.
#[cfg(test)]
mod tests {
    #[test]
    fn builds() {
        build().unwrap();
    }
}
