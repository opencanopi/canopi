//! A planted failing property for the seed lane's planted proptest entry (.github/workflows/seed-lane.yml): it fails
//! only at `PROPTEST_RNG_SEED=3` (read by proptest's default configuration, as in `property_config()`), whose first
//! case is the value below under the locked proptest version. At another seed its 256 cases miss that one u64, so a
//! lane step that stops passing the seed on passes this property, and the planted entry goes red.

#[cfg(test)]
mod properties {
    use proptest::prelude::*;
    use proptest::test_runner::Config;

    /// The first value `any::<u64>()` draws at seed 3 (proptest 1.12.0, ChaCha).
    const SEED_THREE_FIRST_CASE: u64 = 11_343_691_154_469_835_854;

    proptest! {
        #![proptest_config(Config { failure_persistence: None, ..Config::default() })]

        #[test]
        fn fails_at_seed_three(value in any::<u64>()) {
            prop_assert_ne!(value, SEED_THREE_FIRST_CASE);
        }
    }
}
