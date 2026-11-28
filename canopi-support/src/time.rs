//! Wall-clock and duration helpers for native services (ADR 0023, 2.1-M28).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Current wall-clock instant.
#[must_use]
pub fn now_system_time() -> SystemTime {
    SystemTime::now()
}

/// Current wall-clock timestamp in whole milliseconds since the Unix epoch.
/// Returns `0` if the system clock precedes the Unix epoch.
#[must_use]
pub fn now_unix_ms() -> u64 {
    now_system_time()
        .duration_since(UNIX_EPOCH)
        .map_or(0, duration_millis)
}

/// Whole milliseconds of `duration`, saturating at `u64::MAX`.
#[must_use]
pub fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{duration_millis, now_unix_ms};
    use std::time::Duration;

    #[test]
    fn duration_millis_saturates_large_values() {
        assert_eq!(duration_millis(Duration::from_millis(42)), 42);
        assert_eq!(duration_millis(Duration::MAX), u64::MAX);
    }

    #[test]
    fn now_unix_ms_is_positive() {
        assert!(now_unix_ms() > 0);
    }
}
