//! The plant DB connection a caller holds while it reads the catalog: only `db` builds one,
//! from the admitted connection's lock.

use rusqlite::Connection;
use std::ops::{Deref, DerefMut};
use std::sync::MutexGuard;

pub(crate) struct PlantDbConnectionGuard<'a>(pub(super) MutexGuard<'a, Connection>);

impl Deref for PlantDbConnectionGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// Mutable access is for connection-owned callbacks (rusqlite installs them through `&mut`):
/// the species search's progress handler.
impl DerefMut for PlantDbConnectionGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
