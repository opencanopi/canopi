//! Single home for stored-data forms, chain floors, and version admission
//! (Stage 2 Item 9; contracts §11, ADR 0023, ADR 0026, 2.1-M157, 2.1-M485, 2.1-M540).
//!
//! `bindings-gen` emits the TypeScript tables and admission helper from [`FORM_SPECS`]
//! and [`STORE_FLOORS`]; `platform/store-chain.ts` holds only the thin synchronous step runner.

use crate::health::StoreId;
use serde::{Deserialize, Serialize};
use specta::Type;

/// Closed table of every versioned stored form in Canopi (contracts §11, 2.1-M485, 2.1-M540).
///
/// Forms with a `SubsystemHealth` entry map to `Some(StoreId)`; document/payload/legacy
/// forms without a top-level health row map to `None`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "snake_case")]
pub enum StoredForm {
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
    /// Stored form identifier.
    pub form: StoredForm,
    /// Associated `SubsystemHealth` store key, or `None` when the form has no health row.
    pub store: Option<StoreId>,
    /// Lowest stored version this release line recognises (ADR 0026).
    pub floor: u32,
}

/// The version bounds a store recognises at open time.
///
/// `current` is always derived as `min_readable + step_count` via [`StoreFloor::from_steps`]
/// so a version bump cannot exist without its migration steps (contracts §11, 2.1-M157).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StoreFloor {
    /// Store identifier from `canopi_types::health::StoreId`.
    pub store: StoreId,
    /// Lowest stored version this build can read or migrate from.
    pub min_readable: u32,
    /// Current schema/record version written by this build (`min_readable + step_count`).
    pub current: u32,
    /// Highest stored version this build may read read-only (`None` = unbounded per 2.1-M480).
    pub max_readable: Option<u32>,
}

impl StoreFloor {
    /// Builds a [`StoreFloor`] deriving `current = floor + step_count` (contracts §11, 2.1-M157).
    #[must_use]
    pub const fn from_steps(
        store: StoreId,
        floor: u32,
        step_count: u32,
        max_readable: Option<u32>,
    ) -> Self {
        let current = floor + step_count;
        if let Some(max) = max_readable {
            assert!(max >= current, "max_readable must be >= current");
        }
        Self {
            store,
            min_readable: floor,
            current,
            max_readable,
        }
    }

    /// Number of frozen migration steps between `min_readable` and `current`.
    #[must_use]
    pub const fn step_count(&self) -> u32 {
        self.current - self.min_readable
    }
}

/// How an existing store's version compares to this build's [`StoreFloor`] (contracts §11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Admission {
    /// No store exists yet; caller initializes at `current`.
    Absent,
    /// Stored version is below `min_readable` (pre-2.0 or unrecognised legacy form).
    BeforeFloor {
        /// Stored version found.
        version: u32,
        /// Minimum version this build migrates from.
        min_readable: u32,
    },
    /// Stored version equals `current`.
    Current,
    /// Stored version is older than `current` and within `[min_readable, current)`.
    Migratable {
        /// Stored version found on disk or in browser storage.
        from: u32,
    },
    /// Stored version is newer than `current` but readable read-only (`<= max_readable`).
    NewerReadable {
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
}

/// Frozen settings record migration steps (contracts §11, 2.1-M157, 2.1-M518, 2.1-M547):
/// step 1 -> 2 introduces record 2 (`unit_system`, `last_open_home`, `launch_check`).
const SETTINGS_STEPS: &[Step<(), ()>] = &[Step { from: 1, run: Ok }];

/// Declarative store chain for settings record 2 (floor 1, current 2, unbounded newer-readable per 2.1-M480).
pub const SETTINGS_CHAIN: Chain<'static, (), ()> = Chain {
    store: StoreId::Settings,
    floor: 1,
    steps: SETTINGS_STEPS,
    reads_newer_up_to: None,
};
const _: () = SETTINGS_CHAIN.assert_valid();

/// Version floor for `user.db` (`PRAGMA user_version`, contracts §11, 2.1-M480).
/// Bumping `current` requires adding a frozen step to the store's [`Chain`] (2.1-M157).
pub const USER_DB_FLOOR: StoreFloor = StoreFloor::from_steps(StoreId::UserDb, 9, 0, None);

/// Version floor for the settings record, derived from [`SETTINGS_CHAIN`] (contracts §11, 2.1-M157, 2.1-M480).
pub const SETTINGS_FLOOR: StoreFloor = SETTINGS_CHAIN.store_floor();

/// Version floor for the Data library catalogue (`catalogue.sqlite`, contracts §11).
/// Bumping `current` requires adding a frozen step to the store's [`Chain`] (2.1-M157).
pub const LIBRARY_CATALOGUE_FLOOR: StoreFloor =
    StoreFloor::from_steps(StoreId::LibraryCatalogue, 25, 0, None);

/// Version floor for Web Drafts IndexedDB store (contracts §11, 2.1-M486).
/// Bumping `current` requires adding a frozen step to the store's [`Chain`] (2.1-M157).
pub const WEB_DRAFTS_FLOOR: StoreFloor = StoreFloor::from_steps(StoreId::WebDrafts, 4, 0, None);

/// Version floor for Web species-list record (contracts §11, 2.1-M486).
/// Bumping `current` requires adding a frozen step to the store's [`Chain`] (2.1-M157).
pub const WEB_SPECIES_LISTS_FLOOR: StoreFloor =
    StoreFloor::from_steps(StoreId::WebSpeciesLists, 1, 0, None);

/// The version floors for every versioned store (contracts §11, ADR 0026, 2.1-M480, 2.1-M486).
pub const STORE_FLOORS: &[StoreFloor] = &[
    USER_DB_FLOOR,
    SETTINGS_FLOOR,
    LIBRARY_CATALOGUE_FLOOR,
    WEB_DRAFTS_FLOOR,
    WEB_SPECIES_LISTS_FLOOR,
];

// Compile-time guard (2.1-M157): stores with a declared `Chain` must equal `CHAIN.store_floor()`,
// and unchained stores cannot drift `current` above `min_readable` without adding steps through a `Chain`.
const _: () = {
    let settings_expected = SETTINGS_CHAIN.store_floor();
    let mut i = 0;
    while i < STORE_FLOORS.len() {
        let row = STORE_FLOORS[i];
        match row.store {
            StoreId::Settings => {
                assert!(
                    row.min_readable == settings_expected.min_readable
                        && row.current == settings_expected.current,
                    "SETTINGS_FLOOR must match SETTINGS_CHAIN.store_floor()"
                );
            }
            _ => {
                assert!(
                    row.current == row.min_readable,
                    "store current version must be bumped by adding frozen steps to its Chain"
                );
            }
        }
        i += 1;
    }
};

/// Every versioned stored form and its floor (contracts §11, ADR 0026, 2.1-M485).
pub const FORM_SPECS: &[FormSpec] = &[
    FormSpec {
        form: StoredForm::CanopiFile,
        store: None,
        floor: 9,
    },
    FormSpec {
        form: StoredForm::UserDb,
        store: Some(StoreId::UserDb),
        floor: USER_DB_FLOOR.min_readable,
    },
    FormSpec {
        form: StoredForm::SavedStampPayload,
        store: None,
        floor: 2,
    },
    FormSpec {
        form: StoredForm::Settings,
        store: Some(StoreId::Settings),
        floor: SETTINGS_FLOOR.min_readable,
    },
    FormSpec {
        form: StoredForm::LibraryCatalogue,
        store: Some(StoreId::LibraryCatalogue),
        floor: LIBRARY_CATALOGUE_FLOOR.min_readable,
    },
    FormSpec {
        form: StoredForm::SourceMeta,
        store: None,
        floor: 1,
    },
    FormSpec {
        form: StoredForm::WebDrafts,
        store: Some(StoreId::WebDrafts),
        floor: WEB_DRAFTS_FLOOR.min_readable,
    },
    FormSpec {
        form: StoredForm::WebSpeciesLists,
        store: Some(StoreId::WebSpeciesLists),
        floor: WEB_SPECIES_LISTS_FLOOR.min_readable,
    },
    FormSpec {
        form: StoredForm::WebLegacyContainer,
        store: None,
        floor: 3,
    },
];

/// Returns the [`FormSpec`] for `form`.
#[must_use]
pub const fn form_spec(form: StoredForm) -> &'static FormSpec {
    let idx = match form {
        StoredForm::CanopiFile => 0,
        StoredForm::UserDb => 1,
        StoredForm::SavedStampPayload => 2,
        StoredForm::Settings => 3,
        StoredForm::LibraryCatalogue => 4,
        StoredForm::SourceMeta => 5,
        StoredForm::WebDrafts => 6,
        StoredForm::WebSpeciesLists => 7,
        StoredForm::WebLegacyContainer => 8,
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
    Absent,
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
    NewerReadable {
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
    BeforeFloor {
        /// Stored version found.
        version: u32,
        /// Minimum version this chain migrates from.
        min_readable: u32,
    },
}

/// Declarative store migration chain where `current() = floor + steps.len()` (contracts §11, 2.1-M157, 2.1-M540).
///
/// Consumed by Rust store migrators (2e-2 settings record 2, N1 `user.db` steps). Call
/// `const _: () = CHAIN.assert_valid();` beside every static chain so non-contiguous steps
/// fail at compile time.
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
    /// Number of migration steps as `u32`.
    #[must_use]
    pub const fn step_count(&self) -> u32 {
        let mut count: u32 = 0;
        let mut idx = 0;
        while idx < self.steps.len() {
            count += 1;
            idx += 1;
        }
        count
    }

    /// Current version written by this chain (`floor + steps.len()`).
    #[must_use]
    pub const fn current(&self) -> u32 {
        self.floor + self.step_count()
    }

    /// Derived [`StoreFloor`] for admission checks (`current = floor + steps.len()`).
    #[must_use]
    pub const fn store_floor(&self) -> StoreFloor {
        StoreFloor::from_steps(
            self.store,
            self.floor,
            self.step_count(),
            self.reads_newer_up_to,
        )
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

    /// Compile-time and runtime invariant check for a [`Chain`].
    ///
    /// Invoke inside `const _: () = CHAIN.assert_valid();` beside every declared chain.
    pub const fn assert_valid(&self) {
        assert!(
            self.is_valid(),
            "store chain steps must be contiguous from floor and reads_newer_up_to >= current"
        );
    }

    /// Classifies an optional stored version against this chain.
    #[must_use]
    pub fn admit(&self, version: Option<u32>) -> Admission {
        admit_version(self.store_floor(), version)
    }

    /// Classifies `version` and, when migratable, runs each step in order up to `current()`.
    pub fn run(&self, version: Option<u32>, mut value: T) -> Result<ChainOutcome<T>, StepError<E>> {
        self.assert_valid();
        match self.admit(version) {
            Admission::Absent => Ok(ChainOutcome::Absent),
            Admission::Current => Ok(ChainOutcome::Current {
                version: self.current(),
                value,
                steps_run: 0,
            }),
            Admission::NewerReadable { version } => {
                Ok(ChainOutcome::NewerReadable { version, value })
            }
            Admission::RefusedNewer {
                version,
                max_supported,
            } => Ok(ChainOutcome::RefusedNewer {
                version,
                max_supported,
            }),
            Admission::BeforeFloor {
                version,
                min_readable,
            } => Ok(ChainOutcome::BeforeFloor {
                version,
                min_readable,
            }),
            Admission::Migratable { from } => {
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

/// Returns true iff `found` is non-negative and [`admit_version`] classifies it as [`Admission::Current`].
pub fn is_current_version(store: StoreId, found: i32) -> bool {
    let (Some(floor), Ok(version)) = (floor_for(store), u32::try_from(found)) else {
        return false;
    };
    admit_version(floor, Some(version)) == Admission::Current
}

/// Classifies an optional stored version against raw form bounds `(min_readable, current,
/// max_readable)` without requiring a [`StoreId`] (reconciles contracts §10 `.canopi` and
/// `SavedStampPayload` admission with [`Admission`]; 2.1-M485, 2.1-Q347).
#[must_use]
pub const fn admit_form_version(
    min_readable: u32,
    current: u32,
    max_readable: Option<u32>,
    version: Option<u32>,
) -> Admission {
    let Some(version) = version else {
        return Admission::Absent;
    };
    if version < min_readable {
        Admission::BeforeFloor {
            version,
            min_readable,
        }
    } else if version < current {
        Admission::Migratable { from: version }
    } else if version == current {
        Admission::Current
    } else {
        match max_readable {
            None => Admission::NewerReadable { version },
            Some(max) if version <= max => Admission::NewerReadable { version },
            Some(max) => Admission::RefusedNewer {
                version,
                max_supported: max,
            },
        }
    }
}

/// Classifies an optional stored version against `floor`.
pub fn admit_version(floor: StoreFloor, version: Option<u32>) -> Admission {
    admit_form_version(
        floor.min_readable,
        floor.current,
        floor.max_readable,
        version,
    )
}

#[cfg(test)]
mod tests;
