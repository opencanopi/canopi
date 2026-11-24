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
mod tests {
    use super::*;

    #[test]
    fn admit_version_classifies_every_boundary() {
        let bounded = StoreFloor {
            store: StoreId::UserDb,
            min_readable: 2,
            current: 9,
            max_readable: Some(10),
        };
        assert_eq!(admit_version(bounded, None), StoredForm::Missing);
        assert_eq!(
            admit_version(bounded, Some(1)),
            StoredForm::PreFloor {
                version: 1,
                min_readable: 2
            }
        );
        assert_eq!(
            admit_version(bounded, Some(2)),
            StoredForm::Upgradable { from: 2 }
        );
        assert_eq!(admit_version(bounded, Some(9)), StoredForm::Current);
        assert_eq!(
            admit_version(bounded, Some(10)),
            StoredForm::NewerReadOnly { version: 10 }
        );
        assert_eq!(
            admit_version(bounded, Some(11)),
            StoredForm::RefusedNewer {
                version: 11,
                max_supported: 10
            }
        );

        let unbounded = floor_for(StoreId::UserDb).expect("user_db floor");
        assert_eq!(unbounded.min_readable, 9);
        assert_eq!(unbounded.current, 9);
        assert_eq!(unbounded.max_readable, None);
        assert_eq!(admit_version(unbounded, None), StoredForm::Missing);
        assert_eq!(
            admit_version(unbounded, Some(8)),
            StoredForm::PreFloor {
                version: 8,
                min_readable: 9
            }
        );
        assert_eq!(admit_version(unbounded, Some(9)), StoredForm::Current);
        assert_eq!(
            admit_version(unbounded, Some(10)),
            StoredForm::NewerReadOnly { version: 10 }
        );
        assert_eq!(
            admit_version(unbounded, Some(999)),
            StoredForm::NewerReadOnly { version: 999 }
        );
    }

    #[test]
    fn admit_version_matches_shared_parity_fixture() {
        #[derive(Deserialize)]
        struct ParityCase {
            found: Option<u32>,
            expected: StoredForm,
        }
        #[derive(Deserialize)]
        struct BoundedFixture {
            store: StoreId,
            min_readable: u32,
            current: u32,
            max_readable: Option<u32>,
            cases: Vec<ParityCase>,
        }
        #[derive(Deserialize)]
        struct StoreCase {
            store: StoreId,
            found: Option<u32>,
            expected: StoredForm,
        }
        #[derive(Deserialize)]
        struct ParityFixture {
            bounded: BoundedFixture,
            stores: Vec<StoreCase>,
        }

        let fixture: ParityFixture =
            serde_json::from_str(include_str!("../fixtures/store-chain-parity.json"))
                .expect("store-chain-parity.json must deserialize");
        let bounded = StoreFloor {
            store: fixture.bounded.store,
            min_readable: fixture.bounded.min_readable,
            current: fixture.bounded.current,
            max_readable: fixture.bounded.max_readable,
        };
        for case in &fixture.bounded.cases {
            assert_eq!(admit_version(bounded, case.found), case.expected);
        }
        for case in &fixture.stores {
            let floor = floor_for(case.store).expect("declared floor");
            assert_eq!(admit_version(floor, case.found), case.expected);
        }
    }

    #[test]
    fn store_floors_are_ordered_and_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for row in STORE_FLOORS {
            assert!(
                seen.insert(row.store),
                "duplicate floor for {:?}",
                row.store
            );
            assert!(row.min_readable <= row.current);
            if let Some(max) = row.max_readable {
                assert!(row.current <= max);
            }
            assert_eq!(floor_for(row.store), Some(*row));
        }
        assert_eq!(floor_for(StoreId::PlantCatalog), None);
    }
}
