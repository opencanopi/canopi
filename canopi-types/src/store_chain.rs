//! Single home for stored-data chain floors and version admission (Stage 2 Item 9;
//! ADR 0023, ADR 0026). `bindings-gen` emits the TypeScript table from [`STORE_FLOORS`];
//! `platform/store-chain.ts` holds only the thin synchronous step runner.

use crate::health::StoreId;
use serde::{Deserialize, Serialize};
use specta::Type;

/// The version bounds a store recognises at open time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StoreFloor {
    /// Store identifier from `canopi_types::health::StoreId`.
    pub store: StoreId,
    /// Lowest stored version this build can read or migrate from.
    pub min_readable: u32,
    /// Current schema/record version written by this build.
    pub current: u32,
    /// Highest stored version this build may read read-only (`None` = unbounded per 2.1-M480).
    pub max_readable: Option<u32>,
}

/// How an existing store's version compares to this build's [`StoreFloor`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoredForm {
    /// No store exists yet; caller initializes at `current`.
    Missing,
    /// Stored version equals `current`.
    Current,
    /// Stored version is older than `current` and within `[min_readable, current)`.
    Upgradable {
        /// Stored version found on disk or in browser storage.
        from: u32,
    },
    /// Stored version is newer than `current` but readable read-only (`<= max_readable`).
    NewerReadOnly {
        /// Stored version found.
        version: u32,
    },
    /// Stored version is newer than `max_readable` and must be refused untouched.
    RefusedNewer {
        /// Stored version found.
        version: u32,
        /// Highest version this build recognises.
        max_supported: u32,
    },
    /// Stored version is below `min_readable` (pre-2.0 or unrecognised legacy form).
    PreFloor {
        /// Stored version found.
        version: u32,
        /// Minimum version this build migrates from.
        min_readable: u32,
    },
}

/// Version floor for `user.db` (`PRAGMA user_version`, contracts §11, 2.1-M480).
pub const USER_DB_FLOOR: StoreFloor = StoreFloor {
    store: StoreId::UserDb,
    min_readable: 9,
    current: 9,
    max_readable: None,
};

/// Version floor for the settings record (contracts §11, 2.1-M480).
pub const SETTINGS_FLOOR: StoreFloor = StoreFloor {
    store: StoreId::Settings,
    min_readable: 1,
    current: 1,
    max_readable: None,
};

/// Version floor for the Data library catalogue (`catalogue.sqlite`, contracts §11).
pub const LIBRARY_CATALOGUE_FLOOR: StoreFloor = StoreFloor {
    store: StoreId::LibraryCatalogue,
    min_readable: 25,
    current: 25,
    max_readable: None,
};

/// Version floor for Web Drafts IndexedDB store (contracts §11, 2.1-M486).
pub const WEB_DRAFTS_FLOOR: StoreFloor = StoreFloor {
    store: StoreId::WebDrafts,
    min_readable: 4,
    current: 4,
    max_readable: None,
};

/// Version floor for Web species-list record (contracts §11, 2.1-M486).
pub const WEB_SPECIES_LISTS_FLOOR: StoreFloor = StoreFloor {
    store: StoreId::WebSpeciesLists,
    min_readable: 1,
    current: 1,
    max_readable: None,
};

/// The version floors for every versioned store (contracts §11, ADR 0026, 2.1-M480, 2.1-M486).
pub const STORE_FLOORS: &[StoreFloor] = &[
    USER_DB_FLOOR,
    SETTINGS_FLOOR,
    LIBRARY_CATALOGUE_FLOOR,
    WEB_DRAFTS_FLOOR,
    WEB_SPECIES_LISTS_FLOOR,
];

/// Closed table of every versioned stored form in Canopi (contracts §11, 2.1-M485).
///
/// Forms with a `SubsystemHealth` entry map to `Some(StoreId)`; document/payload/legacy
/// forms without a top-level health row map to `None`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "snake_case")]
pub enum FormId {
    /// `.canopi` Design, Draft, and stamp files (`canopi-format`, floor 9).
    CanopiFile,
    /// Desktop `user.db` SQLite database (floor 9).
    UserDb,
    /// Saved-stamp payload inside user storage (floor 2).
    SavedStampPayload,
    /// Device settings record on Desktop and Web (floor 1).
    Settings,
    /// Data library catalogue `catalogue.sqlite` (floor 25).
    LibraryCatalogue,
    /// Data library source `meta.json` (floor 1).
    SourceMeta,
    /// Web Drafts IndexedDB store (floor 4).
    WebDrafts,
    /// Web species-lists record (floor 1).
    WebSpeciesLists,
    /// Web 2.0 `localStorage` containers read once by 2.1 migration steps (floor 3).
    WebLegacyContainer,
}

/// Metadata row for one entry in the closed [`FORM_SPECS`] table (contracts §11, 2.1-M485).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FormSpec {
    /// Form identifier.
    pub form: FormId,
    /// Associated `SubsystemHealth` store key, or `None` when the form has no health row.
    pub store: Option<StoreId>,
    /// Lowest stored version this release line recognises (ADR 0026).
    pub floor: u32,
}

/// Every versioned stored form and its floor (contracts §11, ADR 0026, 2.1-M485).
pub const FORM_SPECS: &[FormSpec] = &[
    FormSpec {
        form: FormId::CanopiFile,
        store: None,
        floor: 9,
    },
    FormSpec {
        form: FormId::UserDb,
        store: Some(StoreId::UserDb),
        floor: USER_DB_FLOOR.min_readable,
    },
    FormSpec {
        form: FormId::SavedStampPayload,
        store: None,
        floor: 2,
    },
    FormSpec {
        form: FormId::Settings,
        store: Some(StoreId::Settings),
        floor: SETTINGS_FLOOR.min_readable,
    },
    FormSpec {
        form: FormId::LibraryCatalogue,
        store: Some(StoreId::LibraryCatalogue),
        floor: LIBRARY_CATALOGUE_FLOOR.min_readable,
    },
    FormSpec {
        form: FormId::SourceMeta,
        store: None,
        floor: 1,
    },
    FormSpec {
        form: FormId::WebDrafts,
        store: Some(StoreId::WebDrafts),
        floor: WEB_DRAFTS_FLOOR.min_readable,
    },
    FormSpec {
        form: FormId::WebSpeciesLists,
        store: Some(StoreId::WebSpeciesLists),
        floor: WEB_SPECIES_LISTS_FLOOR.min_readable,
    },
    FormSpec {
        form: FormId::WebLegacyContainer,
        store: None,
        floor: 3,
    },
];

/// Returns the [`FormSpec`] for `form`.
#[must_use]
pub const fn form_spec(form: FormId) -> &'static FormSpec {
    let idx = match form {
        FormId::CanopiFile => 0,
        FormId::UserDb => 1,
        FormId::SavedStampPayload => 2,
        FormId::Settings => 3,
        FormId::LibraryCatalogue => 4,
        FormId::SourceMeta => 5,
        FormId::WebDrafts => 6,
        FormId::WebSpeciesLists => 7,
        FormId::WebLegacyContainer => 8,
    };
    &FORM_SPECS[idx]
}

/// One synchronous migration step advancing a store from `from` to `from + 1` (contracts §11, 2.1-M157).
pub struct Step<T, E> {
    /// Input version this step accepts; its output version is `from + 1`.
    pub from: u32,
    /// Pure/synchronous upgrade function.
    pub run: fn(T) -> Result<T, E>,
}

/// Failure returned when a [`Step`] fails during [`Chain::run`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepError<E> {
    /// Version the failing step started from.
    pub from: u32,
    /// Underlying step error.
    pub error: E,
}

/// Outcome of running a [`Chain`] against a stored value (contracts §11, 2.1-M157).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainOutcome<T> {
    /// No store exists yet; caller initializes at `current`.
    Missing,
    /// Store is at `current` (either already current or upgraded via `steps_run` steps).
    Current {
        /// Final version (`chain.current()`).
        version: u32,
        /// Resulting value.
        value: T,
        /// Number of migration steps applied (`0` when already current).
        steps_run: usize,
    },
    /// Store is newer than `current` but within `reads_newer_up_to` (read-only).
    NewerReadOnly {
        /// Stored version found.
        version: u32,
        /// Original value untouched.
        value: T,
    },
    /// Store is newer than `reads_newer_up_to` and must be refused untouched.
    RefusedNewer {
        /// Stored version found.
        version: u32,
        /// Highest version this build recognises.
        max_supported: u32,
    },
    /// Store is below `floor` (pre-2.0 or unrecognised legacy form).
    PreFloor {
        /// Stored version found.
        version: u32,
        /// Minimum version this chain migrates from.
        min_readable: u32,
    },
}

/// Declarative store migration chain where `current() = floor + steps.len()` (contracts §11, 2.1-M157, 2.1-M540).
pub struct Chain<'a, T, E> {
    /// Store identifier from `canopi_types::health::StoreId`.
    pub store: StoreId,
    /// Lowest stored version this chain migrates from.
    pub floor: u32,
    /// Ordered contiguous steps (`steps[i].from == floor + i`).
    pub steps: &'a [Step<T, E>],
    /// Highest newer version readable read-only (`None` = unbounded per 2.1-M480).
    pub reads_newer_up_to: Option<u32>,
}

impl<T, E> Chain<'_, T, E> {
    /// Current version written by this chain (`floor + steps.len()`).
    #[must_use]
    pub const fn current(&self) -> u32 {
        let mut count: u32 = 0;
        let mut idx = 0;
        while idx < self.steps.len() {
            count += 1;
            idx += 1;
        }
        self.floor + count
    }

    /// Derived [`StoreFloor`] for admission checks.
    #[must_use]
    pub const fn store_floor(&self) -> StoreFloor {
        StoreFloor {
            store: self.store,
            min_readable: self.floor,
            current: self.current(),
            max_readable: self.reads_newer_up_to,
        }
    }

    /// Returns `true` iff every step has `steps[i].from == floor + i` and `reads_newer_up_to`
    /// is either `None` or `>= current()`.
    #[must_use]
    pub const fn is_valid(&self) -> bool {
        let mut expected_from = self.floor;
        let mut idx = 0;
        while idx < self.steps.len() {
            if self.steps[idx].from != expected_from {
                return false;
            }
            expected_from += 1;
            idx += 1;
        }
        match self.reads_newer_up_to {
            Some(max) => max >= self.current(),
            None => true,
        }
    }

    /// Classifies an optional stored version against this chain.
    #[must_use]
    pub fn admit(&self, version: Option<u32>) -> StoredForm {
        admit_version(self.store_floor(), version)
    }

    /// Classifies `version` and, when upgradable, runs each step in order up to `current()`.
    pub fn run(&self, version: Option<u32>, mut value: T) -> Result<ChainOutcome<T>, StepError<E>> {
        debug_assert!(
            self.is_valid(),
            "store chain steps must be contiguous from floor"
        );
        match self.admit(version) {
            StoredForm::Missing => Ok(ChainOutcome::Missing),
            StoredForm::Current => Ok(ChainOutcome::Current {
                version: self.current(),
                value,
                steps_run: 0,
            }),
            StoredForm::NewerReadOnly { version } => {
                Ok(ChainOutcome::NewerReadOnly { version, value })
            }
            StoredForm::RefusedNewer {
                version,
                max_supported,
            } => Ok(ChainOutcome::RefusedNewer {
                version,
                max_supported,
            }),
            StoredForm::PreFloor {
                version,
                min_readable,
            } => Ok(ChainOutcome::PreFloor {
                version,
                min_readable,
            }),
            StoredForm::Upgradable { from } => {
                let start_index = (from - self.floor) as usize;
                let mut steps_run = 0;
                for step in &self.steps[start_index..] {
                    value = (step.run)(value).map_err(|error| StepError {
                        from: step.from,
                        error,
                    })?;
                    steps_run += 1;
                }
                Ok(ChainOutcome::Current {
                    version: self.current(),
                    value,
                    steps_run,
                })
            }
        }
    }
}

/// Returns the [`StoreFloor`] for `store`, or `None` for stores without a version chain
/// (such as the bundled read-only plant catalog).
pub fn floor_for(store: StoreId) -> Option<StoreFloor> {
    STORE_FLOORS.iter().copied().find(|row| row.store == store)
}

/// Returns true iff `found` is non-negative and [`admit_version`] classifies it as [`StoredForm::Current`].
pub fn is_current_version(store: StoreId, found: i32) -> bool {
    let (Some(floor), Ok(version)) = (floor_for(store), u32::try_from(found)) else {
        return false;
    };
    admit_version(floor, Some(version)) == StoredForm::Current
}

/// Classifies an optional stored version against `floor`.
pub fn admit_version(floor: StoreFloor, version: Option<u32>) -> StoredForm {
    let Some(version) = version else {
        return StoredForm::Missing;
    };
    if version < floor.min_readable {
        StoredForm::PreFloor {
            version,
            min_readable: floor.min_readable,
        }
    } else if version < floor.current {
        StoredForm::Upgradable { from: version }
    } else if version == floor.current {
        StoredForm::Current
    } else if floor.max_readable.is_none_or(|max| version <= max) {
        StoredForm::NewerReadOnly { version }
    } else {
        StoredForm::RefusedNewer {
            version,
            max_supported: floor.max_readable.unwrap_or(floor.current),
        }
    }
}

#[cfg(test)]
mod tests;
