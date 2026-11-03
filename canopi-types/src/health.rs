//! Startup health of the app's subsystems (local data, plant database, LiDAR
//! library), as the frontend shows and problem reports carry it.

use serde::{Deserialize, Serialize};
use specta::Type;

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
