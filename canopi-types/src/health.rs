//! Startup health of the app's subsystems (local data, plant database, LiDAR
//! library), as the frontend shows and problem reports carry it.

use crate::failure::FailureCode;
use serde::{Deserialize, Serialize};
use specta::Type;

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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SubsystemHealth {
    pub plant_db: PlantDbStatus,
    pub lidar_library: LidarLibraryStatus,
    pub local_data: LocalDataStatus,
}

/// What startup did with the local data of an earlier Canopi (ADR 0021).
/// `MovedAside` is shown to the user once: the next start finds only
/// current data and reports `Current`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalDataStatus {
    /// No user database from before Canopi 2.0 was found. Drafts in an
    /// earlier format and the retired 1.x autosave store stay in place,
    /// unread, and are not reported.
    Current,
    /// The user database from before Canopi 2.0 (favourites, saved stamps,
    /// settings, recent files) was renamed, never deleted, and Canopi started
    /// fresh.
    MovedAside,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum PlantDbStatus {
    Available,
    Missing,
    Corrupt,
}

/// How the LiDAR Data library opened at startup. Everything but `Ready` is
/// shown to the user; `RefusedNewer` and `Unavailable` also make the library
/// empty and read-only for the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum LidarLibraryStatus {
    Ready,
    /// An older or corrupt catalogue was set aside and rebuilt from the
    /// originals: `items` listed again from their metadata, `generated` of
    /// them under a generated name because no metadata described them.
    Recovered {
        items: u32,
        generated: u32,
    },
    /// The catalogue was written by a newer Canopi and is left untouched.
    RefusedNewer,
    /// The catalogue could be neither opened nor rebuilt.
    Unavailable,
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
    fn health_serialises_every_lidar_library_state() {
        let cases = [
            (LidarLibraryStatus::Ready, json!({ "kind": "ready" })),
            (
                LidarLibraryStatus::Recovered {
                    items: 3,
                    generated: 1,
                },
                json!({ "kind": "recovered", "items": 3, "generated": 1 }),
            ),
            (
                LidarLibraryStatus::RefusedNewer,
                json!({ "kind": "refused_newer" }),
            ),
            (
                LidarLibraryStatus::Unavailable,
                json!({ "kind": "unavailable" }),
            ),
        ];
        for (status, expected) in cases {
            let health = SubsystemHealth {
                plant_db: PlantDbStatus::Available,
                lidar_library: status,
                local_data: LocalDataStatus::Current,
            };
            let value = serde_json::to_value(&health).unwrap();
            assert_eq!(value["plant_db"], json!("available"));
            assert_eq!(value["lidar_library"], expected);
            let back: SubsystemHealth = serde_json::from_value(value).unwrap();
            assert_eq!(back.lidar_library, status);
        }
    }

    #[test]
    fn health_serialises_every_local_data_state() {
        for (status, expected) in [
            (LocalDataStatus::Current, json!({ "kind": "current" })),
            (
                LocalDataStatus::MovedAside,
                json!({ "kind": "moved_aside" }),
            ),
        ] {
            let health = SubsystemHealth {
                plant_db: PlantDbStatus::Available,
                lidar_library: LidarLibraryStatus::Ready,
                local_data: status,
            };
            let value = serde_json::to_value(&health).unwrap();
            assert_eq!(value["local_data"], expected);
            let back: SubsystemHealth = serde_json::from_value(value).unwrap();
            assert_eq!(back.local_data, status);
        }
    }
}
