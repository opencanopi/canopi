//! Temporary Phase 2 process-wide target lock table for desktop callers.
//!
//! Tracks `canopi-f47t.52.189` / I5 removal bead `canopi-f47t.52.189.1` (`2.1-M545`):
//! removed once `2b-3`/`2b-4` wire owned store instances with their own [`TargetLocks`]
//! handles through the remaining desktop file writers (`design`, `db`, `problem_report`,
//! `host::updater::install`, and `host::home::DesktopHomeStore`). Kept in a leaf module
//! so callers do not add a module-graph cycle back to `crate`.

use std::sync::{Arc, OnceLock};

use canopi_support::durable::TargetLocks;

pub(crate) fn temporary_target_locks() -> &'static Arc<TargetLocks> {
    static LOCKS: OnceLock<Arc<TargetLocks>> = OnceLock::new();
    LOCKS.get_or_init(|| Arc::new(TargetLocks::new()))
}
