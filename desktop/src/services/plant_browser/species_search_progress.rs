//! The species search's SQLite progress handler: it stops a superseded search between SQLite
//! steps. The guard owns the plant DB connection while the handler is installed (rusqlite
//! installs connection-owned callbacks through `&mut`), so the handler is cleared before the
//! connection and its lock are released.

use std::ops::DerefMut;
use std::sync::{Arc, atomic::Ordering};

use super::{Connection, SPECIES_SEARCH_PROGRESS_INTERVAL, SpeciesSearchCancellationToken};

pub(super) struct SpeciesSearchProgressGuard<C: DerefMut<Target = Connection>> {
    pub(super) connection: C,
}

impl SpeciesSearchCancellationToken {
    pub(super) fn install_progress_handler<C: DerefMut<Target = Connection>>(
        &self,
        mut connection: C,
    ) -> Result<SpeciesSearchProgressGuard<C>, String> {
        let inner = Arc::clone(&self.cancellation.inner);
        let generation = self.generation;
        connection
            .progress_handler(
                SPECIES_SEARCH_PROGRESS_INTERVAL,
                Some(move || inner.next_generation.load(Ordering::Acquire) != generation),
            )
            .map_err(|error| error.to_string())?;
        Ok(SpeciesSearchProgressGuard { connection })
    }
}

impl<C: DerefMut<Target = Connection>> Drop for SpeciesSearchProgressGuard<C> {
    fn drop(&mut self) {
        // Removing the handler allocates nothing, so SQLite cannot refuse it.
        let _ = self.connection.progress_handler(0, None::<fn() -> bool>);
    }
}
