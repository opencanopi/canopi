//! A planted failing property for the seed lane's `planted-proptest` job: under any seed the lane sets
//! (`PROPTEST_RNG_SEED`, read by proptest's default configuration as in `property_config()`), one of its cases fails.

#[cfg(test)]
mod properties {
    use proptest::prelude::*;
    use proptest::test_runner::Config;

    proptest! {
        #![proptest_config(Config { failure_persistence: None, ..Config::default() })]

        #[test]
        fn stays_below_half(value in 0u32..1000) {
            prop_assert!(value < 500);
        }
    }
}
