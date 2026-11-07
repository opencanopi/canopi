//! Startup health of the app's subsystems (local data, plant database, LiDAR
//! library), as the frontend shows and problem reports carry it.

use crate::failure::{FailureCode, LibraryReadOnlyReason, PlantCatalogCause};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// The stores whose open status the app reports (contracts §11, 2.1-M429):
/// a closed set, each later id landing with its producer (`web_user_data`
/// with 2e and N2, `web_library` with N5).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "snake_case")]
pub enum StoreId {
    /// The plant catalog.
    PlantCatalog,
    /// The Desktop user database.
    UserDb,
    /// The settings record, on both editions.
    Settings,
    /// The Data library catalogue.
    LibraryCatalogue,
    /// Web Drafts.
    WebDrafts,
    /// Web species lists (favourites, recently viewed).
    WebSpeciesLists,
}

/// How a store opened (contracts §11 open lifecycle). Phase 1's 1a adds the
/// producers; `newer_read_only` is the reader release's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoreOpenStatus {
    /// Not opened yet.
    Opening,
    /// A migration is running.
    Migrating,
    /// Open and current.
    Ready,
    /// An older or damaged store was rebuilt: `items` listed again, `generated`
    /// of them under a generated name.
    Recovered {
        /// Entries listed again.
        items: u32,
        /// Entries given a generated name.
        generated: u32,
    },
    /// Written by a newer Canopi whose form this one reads: shown, never written.
    NewerReadOnly,
    /// Written by a newer Canopi and left untouched.
    RefusedNewer,
    /// A damaged store was renamed aside and a fresh one started; `file` is the
    /// new file name only, never a path.
    SetAsideDamaged {
        /// The set-aside file's name.
        file: String,
    },
    /// The store could not be opened; `code` says why.
    Unavailable {
        /// Why, as a catalogue code.
        code: FailureCode,
    },
}

impl StoreOpenStatus {
    /// The Data library could be neither opened nor rebuilt: read-only for the
    /// session.
    pub const LIBRARY_UNAVAILABLE: Self = Self::Unavailable {
        code: FailureCode::LibraryReadOnly {
            reason: LibraryReadOnlyReason::Unavailable,
        },
    };
}

/// A one-time notice about a store, cleared on dismiss (contracts §11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum StoreNotice {
    /// The user database from before Canopi 2.0 was renamed and Canopi started
    /// fresh (ADR 0021).
    #[serde(rename = "moved_aside_pre_2_0")]
    MovedAsidePre20,
    /// Settings fields with bad values were reset.
    #[serde(rename = "fields_reset")]
    FieldsReset,
    /// A write to the store failed.
    #[serde(rename = "write_failed")]
    WriteFailed,
}

/// One store's entry in `SubsystemHealth`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StoreHealth {
    /// How the store opened.
    pub status: StoreOpenStatus,
    /// A one-time notice to show, if any.
    pub notice: Option<StoreNotice>,
}

/// Each store's open status, keyed by its id (contracts §11, 2.1-M417): the
/// one health vocabulary the frontend shows and problem reports carry. A store
/// the host does not open has no entry.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct SubsystemHealth(pub BTreeMap<StoreId, StoreHealth>);

/// The plant catalog's state as the native plant DB handle reports it. It is
/// not on the health wire: `SubsystemHealth[plant_catalog]` carries it as
/// `ready` or `unavailable{plant_db_unavailable{cause}}`. It stays for the
/// plant DB's own refusal text and the frontend's plant-DB message until
/// those move onto the catalogue (2.1-M41).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PlantDbStatus {
    /// The catalog is open.
    Available,
    /// No catalog file was found.
    Missing,
    /// The file was found but could not be opened or admitted.
    Corrupt,
}

impl PlantDbStatus {
    /// The catalog's entry in `SubsystemHealth`.
    pub fn store_status(self) -> StoreOpenStatus {
        let cause = match self {
            Self::Available => return StoreOpenStatus::Ready,
            Self::Missing => PlantCatalogCause::Missing,
            Self::Corrupt => PlantCatalogCause::OpenFailed,
        };
        StoreOpenStatus::Unavailable {
            code: FailureCode::PlantDbUnavailable { cause },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_store_status_tags_its_kind_and_carries_its_catalogue_code() {
        let entry = StoreHealth {
            status: StoreOpenStatus::Unavailable {
                code: FailureCode::PlantDbUnavailable {
                    cause: crate::failure::PlantCatalogCause::Missing,
                },
            },
            notice: None,
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            json!({
                "status": {
                    "kind": "unavailable",
                    "code": { "kind": "plant_db_unavailable", "cause": "missing" }
                },
                "notice": null
            })
        );
        let set_aside = StoreHealth {
            status: StoreOpenStatus::SetAsideDamaged {
                file: "user.db.corrupt-1".to_owned(),
            },
            notice: Some(StoreNotice::MovedAsidePre20),
        };
        let value = serde_json::to_value(&set_aside).unwrap();
        assert_eq!(
            value["status"],
            json!({ "kind": "set_aside_damaged", "file": "user.db.corrupt-1" })
        );
        assert_eq!(value["notice"], json!("moved_aside_pre_2_0"));
        assert_eq!(
            serde_json::from_value::<StoreHealth>(value).unwrap(),
            set_aside
        );
        assert_eq!(
            serde_json::to_value(StoreId::LibraryCatalogue).unwrap(),
            json!("library_catalogue")
        );
    }

    #[test]
    fn health_serialises_as_a_map_from_store_id_to_its_entry() {
        let health = SubsystemHealth(BTreeMap::from([
            (
                StoreId::PlantCatalog,
                StoreHealth {
                    status: PlantDbStatus::Corrupt.store_status(),
                    notice: None,
                },
            ),
            (
                StoreId::UserDb,
                StoreHealth {
                    status: StoreOpenStatus::Ready,
                    notice: Some(StoreNotice::MovedAsidePre20),
                },
            ),
            (
                StoreId::LibraryCatalogue,
                StoreHealth {
                    status: StoreOpenStatus::Recovered {
                        items: 3,
                        generated: 1,
                    },
                    notice: None,
                },
            ),
        ]));
        let value = serde_json::to_value(&health).unwrap();
        assert_eq!(
            value,
            json!({
                "plant_catalog": {
                    "status": {
                        "kind": "unavailable",
                        "code": { "kind": "plant_db_unavailable", "cause": "open_failed" }
                    },
                    "notice": null
                },
                "user_db": { "status": { "kind": "ready" }, "notice": "moved_aside_pre_2_0" },
                "library_catalogue": {
                    "status": { "kind": "recovered", "items": 3, "generated": 1 },
                    "notice": null
                }
            })
        );
        assert_eq!(
            serde_json::from_value::<SubsystemHealth>(value).unwrap(),
            health
        );
    }

    #[test]
    fn the_plant_db_status_maps_onto_the_catalog_entry() {
        assert_eq!(
            PlantDbStatus::Available.store_status(),
            StoreOpenStatus::Ready
        );
        for (status, cause) in [
            (PlantDbStatus::Missing, PlantCatalogCause::Missing),
            (PlantDbStatus::Corrupt, PlantCatalogCause::OpenFailed),
        ] {
            assert_eq!(
                status.store_status(),
                StoreOpenStatus::Unavailable {
                    code: FailureCode::PlantDbUnavailable { cause }
                }
            );
        }
    }
}
