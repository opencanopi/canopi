//! Native Desktop `DesignCore` service backed by `canopi-format` (2b-5; contracts §10,
//! `2.1-M156`, `2.1-M539`, `2.1-Q155`, `2.1-M88`).
//!
//! Every operation runs on [`NativeOperationClass::Local`] through [`NativeOperationExecutor`]
//! and returns a typed reply envelope matching `canopi-format-wasm` (`{"ok": ...}` or
//! `{"err": ...}`), with executor faults surfaced as [`Failure`]. Wired through
//! `commands::design_core`, `ipc/design-core.ts`, and `editions/desktop/boot.ts`
//! (`canopi-f47t.52.49`).

use canopi_format::core::{
    FORMAT_CORE_VERSION, FormatRefusal, NewDesignInput, OpenedDesign,
    decode_design as core_decode_design, draft_summary as core_draft_summary,
    encode_design as core_encode_design, new_design as core_new_design,
};
use canopi_format::stamps::{
    StampPayloadRefusal, canopi_file_to_stamp, decode_stamp_payload as core_decode_stamp,
    encode_stamp_payload as core_encode_stamp, stamp_to_canopi_file,
};
use canopi_types::design::GeoPoint;
use canopi_types::design::v10::DraftSummaryOutcome;
use canopi_types::failure::Failure;
use canopi_types::saved_object_stamps::SavedObjectStampPayload;
use serde::Serialize;
use serde_json::Value;

use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};

/// Answer envelope for [`decode_design`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DecodeDesignReply {
    /// Decoded (and, when older, migrated) v10 Design.
    Ok(Box<OpenedDesign>),
    /// Typed format refusal.
    Err(FormatRefusal),
}

/// Answer envelope for [`encode_design`] and [`stamp_to_canopi`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EncodeDesignReply {
    /// Canonical `.canopi` UTF-8 JSON bytes.
    Ok(Vec<u8>),
    /// Typed format refusal.
    Err(FormatRefusal),
}

/// Answer envelope for [`decode_stamp`] and [`canopi_to_stamp`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DecodeStampReply {
    /// Decoded (and, when v2, migrated) v3 saved-stamp payload.
    Ok(Box<SavedObjectStampPayload>),
    /// Typed stamp payload refusal.
    Err(StampPayloadRefusal),
}

/// Answer envelope for [`encode_stamp`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EncodeStampReply {
    /// Canonical v3 saved-stamp JSON string.
    Ok(String),
    /// Typed stamp payload refusal.
    Err(StampPayloadRefusal),
}

/// Reports the native `canopi-format` crate version (contracts §10 parity check).
pub async fn version(executor: &NativeOperationExecutor) -> Result<String, Failure> {
    executor
        .run_typed(NativeOperationClass::Local, "design_core.version", || {
            Ok(FORMAT_CORE_VERSION.to_owned())
        })
        .await
}

/// Decodes raw `.canopi` bytes (v9 or v10) through `canopi-format` (2.1-M539).
pub async fn decode_design(
    executor: &NativeOperationExecutor,
    bytes: Vec<u8>,
) -> Result<DecodeDesignReply, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            "design_core.decode",
            move || {
                Ok(match core_decode_design(&bytes) {
                    Ok(opened) => DecodeDesignReply::Ok(Box::new(opened)),
                    Err(refusal) => DecodeDesignReply::Err(refusal),
                })
            },
        )
        .await
}

/// Validates and canonically encodes a v10 `.canopi` Design (2.1-M156, 2.1-M539).
pub async fn encode_design(
    executor: &NativeOperationExecutor,
    design: Value,
) -> Result<EncodeDesignReply, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            "design_core.encode",
            move || {
                Ok(match core_encode_design(&design) {
                    Ok(bytes) => EncodeDesignReply::Ok(bytes),
                    Err(refusal) => EncodeDesignReply::Err(refusal),
                })
            },
        )
        .await
}

/// Constructs a canonical v10 `.canopi` Design from [`NewDesignInput`].
pub async fn new_design(
    executor: &NativeOperationExecutor,
    input: NewDesignInput,
) -> Result<Value, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            "design_core.new_design",
            move || Ok(core_new_design(&input)),
        )
        .await
}

/// Derives a Draft summary from raw `.canopi` bytes through the one decode choke point.
pub async fn draft_summary(
    executor: &NativeOperationExecutor,
    bytes: Vec<u8>,
    updated_at: String,
) -> Result<DraftSummaryOutcome, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            "design_core.draft_summary",
            move || Ok(core_draft_summary(&bytes, &updated_at)),
        )
        .await
}

/// Decodes and migrates (v2 → v3) a saved-stamp JSON payload (2.1-Q155, 2.1-M88).
pub async fn decode_stamp(
    executor: &NativeOperationExecutor,
    payload_json: String,
) -> Result<DecodeStampReply, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            "design_core.decode_stamp",
            move || {
                Ok(match core_decode_stamp(payload_json.as_bytes()) {
                    Ok(payload) => DecodeStampReply::Ok(Box::new(payload)),
                    Err(refusal) => DecodeStampReply::Err(refusal),
                })
            },
        )
        .await
}

/// Validates and canonically encodes a v3 saved-stamp payload (2.1-Q155, 2.1-M88).
pub async fn encode_stamp(
    executor: &NativeOperationExecutor,
    payload: SavedObjectStampPayload,
) -> Result<EncodeStampReply, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            "design_core.encode_stamp",
            move || {
                Ok(match core_encode_stamp(&payload) {
                    Ok(bytes) => EncodeStampReply::Ok(String::from_utf8(bytes).unwrap_or_default()),
                    Err(refusal) => EncodeStampReply::Err(refusal),
                })
            },
        )
        .await
}

/// Maps a v3 stamp payload to canonical v10 `.canopi` stamp file bytes centred at `origin`.
pub async fn stamp_to_canopi(
    executor: &NativeOperationExecutor,
    payload: SavedObjectStampPayload,
    name: String,
    origin: GeoPoint,
) -> Result<EncodeDesignReply, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            "design_core.stamp_to_canopi",
            move || {
                let doc = stamp_to_canopi_file(&payload, &name, origin);
                Ok(match core_encode_design(&doc) {
                    Ok(bytes) => EncodeDesignReply::Ok(bytes),
                    Err(refusal) => EncodeDesignReply::Err(refusal),
                })
            },
        )
        .await
}

/// Decodes a v9/v10 `.canopi` stamp file into a v3 [`SavedObjectStampPayload`] anchored at `origin`.
pub async fn canopi_to_stamp(
    executor: &NativeOperationExecutor,
    bytes: Vec<u8>,
    origin: GeoPoint,
) -> Result<DecodeStampReply, Failure> {
    executor
        .run_typed(
            NativeOperationClass::Local,
            "design_core.canopi_to_stamp",
            move || {
                let opened = match core_decode_design(&bytes) {
                    Ok(opened) => opened,
                    Err(refusal) => {
                        return Ok(DecodeStampReply::Err(StampPayloadRefusal::InvalidPayload {
                            field_path: refusal.field_path.unwrap_or_else(|| "$".to_owned()),
                            message: refusal.message,
                        }));
                    }
                };
                Ok(match canopi_file_to_stamp(&opened.design, origin) {
                    Ok(payload) => DecodeStampReply::Ok(Box::new(payload)),
                    Err(refusal) => DecodeStampReply::Err(refusal),
                })
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use canopi_types::design::v10::FormatLoadRefusalKind;
    use canopi_types::saved_object_stamps::{
        STAMP_PAYLOAD_CURRENT, StampAnnotation, StampBudgetLine, StampCareAction, StampConsortium,
        StampGroup, StampGroupMember, StampGuide, StampPlant, StampPoint, StampZone,
    };

    use super::*;

    #[test]
    fn native_design_core_decode_encode_new_and_draft_summary_round_trip() {
        let executor = NativeOperationExecutor::production();

        let ver = tauri::async_runtime::block_on(version(&executor)).unwrap();
        assert_eq!(ver, FORMAT_CORE_VERSION);

        let created = tauri::async_runtime::block_on(new_design(
            &executor,
            NewDesignInput {
                name: "Meadow".to_owned(),
                plant_display: None,
                created_at: "2026-11-25T12:00:00Z".to_owned(),
            },
        ))
        .unwrap();
        assert_eq!(created["version"], 10);
        assert_eq!(created["name"], "Meadow");

        // Canonical encode is deterministic (2.1-M156).
        let EncodeDesignReply::Ok(bytes_a) =
            tauri::async_runtime::block_on(encode_design(&executor, created.clone())).unwrap()
        else {
            panic!("expected Ok from encode_design");
        };
        let EncodeDesignReply::Ok(bytes_b) =
            tauri::async_runtime::block_on(encode_design(&executor, created)).unwrap()
        else {
            panic!("expected Ok from second encode_design");
        };
        assert_eq!(bytes_a, bytes_b);

        // Decode migrates v9 -> v10 with frozen release label "2.0".
        let v9_bytes = include_bytes!("../../../canopi-format/spec/v9/fixture.canopi").to_vec();
        let DecodeDesignReply::Ok(opened) =
            tauri::async_runtime::block_on(decode_design(&executor, v9_bytes.clone())).unwrap()
        else {
            panic!("expected Ok decoding v9 design");
        };
        assert_eq!(opened.migrated_from, Some(9));
        assert_eq!(opened.migrated_from_release.as_deref(), Some("2.0"));
        assert_eq!(opened.design["version"], 10);

        // Newer version (v11) is refused as NewerVersion (2.1-Q347).
        let DecodeDesignReply::Err(newer) = tauri::async_runtime::block_on(decode_design(
            &executor,
            br#"{"version":11,"name":"Future"}"#.to_vec(),
        ))
        .unwrap() else {
            panic!("expected NewerVersion refusal");
        };
        assert_eq!(newer.kind, FormatLoadRefusalKind::NewerVersion);

        // Draft summary handles valid and unreadable drafts.
        let summary = tauri::async_runtime::block_on(draft_summary(
            &executor,
            v9_bytes,
            "2026-11-25T12:00:00Z".to_owned(),
        ))
        .unwrap();
        assert!(summary.readable);
        assert_eq!(summary.name, "Frozen v9 Orchard");
        assert_eq!(summary.migrated_from, Some(9));

        let bad_summary = tauri::async_runtime::block_on(draft_summary(
            &executor,
            b"{ not json".to_vec(),
            "2026-11-25T12:00:00Z".to_owned(),
        ))
        .unwrap();
        assert!(!bad_summary.readable);
        assert_eq!(
            bad_summary.refusal_kind,
            Some(FormatLoadRefusalKind::InvalidJson)
        );
    }

    fn sample_v3_stamp_payload() -> SavedObjectStampPayload {
        SavedObjectStampPayload {
            version: STAMP_PAYLOAD_CURRENT,
            anchor: StampPoint { x: 0.0, y: 0.0 },
            plants: vec![StampPlant {
                id: "p-1".to_owned(),
                canonical_name: "Malus domestica".to_owned(),
                common_name: Some("Apple".to_owned()),
                color: Some("#C44230".to_owned()),
                symbol: Some("broadleaf".to_owned()),
                pinned_name: true,
                locked: false,
                position: StampPoint { x: 2.0, y: 3.0 },
                rotation_deg: Some(15.0),
                canopy_spread_m: Some(4.5),
                notes: Some("Prune in winter".to_owned()),
                extra: BTreeMap::new(),
            }],
            zones: vec![StampZone {
                id: "z-1".to_owned(),
                name: Some("Guild bed".to_owned()),
                locked: false,
                zone_type: "polygon".to_owned(),
                points: vec![
                    StampPoint { x: 0.0, y: 0.0 },
                    StampPoint { x: 5.0, y: 0.0 },
                    StampPoint { x: 5.0, y: 4.0 },
                ],
                rotation_deg: 0.0,
                fill_color: Some("#88AA44".to_owned()),
                stroke_color: Some("#446622".to_owned()),
                opacity: Some(0.6),
                notes: None,
                extra: BTreeMap::new(),
            }],
            annotations: vec![StampAnnotation {
                id: "a-1".to_owned(),
                locked: false,
                annotation_type: "text".to_owned(),
                position: StampPoint { x: 1.0, y: 1.0 },
                text: "Mulch ring".to_owned(),
                font_size: 14.0,
                rotation_deg: None,
                extra: BTreeMap::new(),
            }],
            measurement_guides: vec![StampGuide {
                id: "g-1".to_owned(),
                locked: false,
                start: StampPoint { x: 0.0, y: 0.0 },
                end: StampPoint { x: 4.0, y: 0.0 },
                extra: BTreeMap::new(),
            }],
            groups: vec![StampGroup {
                id: "grp-1".to_owned(),
                locked: false,
                name: Some("Apple guild".to_owned()),
                members: vec![
                    StampGroupMember::Plant {
                        id: "p-1".to_owned(),
                    },
                    StampGroupMember::MeasurementGuide {
                        id: "g-1".to_owned(),
                    },
                ],
                extra: BTreeMap::new(),
            }],
            plant_species_colors: BTreeMap::from([(
                "Malus domestica".to_owned(),
                "#C44230".to_owned(),
            )]),
            plant_species_symbols: BTreeMap::from([(
                "Malus domestica".to_owned(),
                "broadleaf".to_owned(),
            )]),
            plant_species_codes: BTreeMap::from([("Malus domestica".to_owned(), "AP".to_owned())]),
            consortiums: vec![StampConsortium {
                canonical_name: "Malus domestica".to_owned(),
                stratum: "canopy".to_owned(),
                start_phase: 0,
                end_phase: 2,
                extra: BTreeMap::new(),
            }],
            budget: vec![StampBudgetLine {
                canonical_name: "Malus domestica".to_owned(),
                unit_cost: 35.0,
                extra: BTreeMap::new(),
            }],
            timeline: vec![StampCareAction {
                id: "t-1".to_owned(),
                action_type: "pruning".to_owned(),
                description: "Winter prune".to_owned(),
                offset_days: Some(90),
                recurrence: Some("yearly".to_owned()),
                targets: Vec::new(),
                extra: BTreeMap::new(),
            }],
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn native_design_core_stamp_v3_and_canopi_file_round_trip() {
        let executor = NativeOperationExecutor::production();
        let origin = GeoPoint {
            lon: 2.35,
            lat: 48.86,
        };
        let payload = sample_v3_stamp_payload();

        // Stamp payload encode -> decode round-trip.
        let EncodeStampReply::Ok(encoded_stamp) =
            tauri::async_runtime::block_on(encode_stamp(&executor, payload.clone())).unwrap()
        else {
            panic!("expected Ok encoding v3 stamp");
        };
        let DecodeStampReply::Ok(decoded_stamp) =
            tauri::async_runtime::block_on(decode_stamp(&executor, encoded_stamp)).unwrap()
        else {
            panic!("expected Ok decoding v3 stamp");
        };
        assert_eq!(*decoded_stamp, payload);

        // Stamp -> .canopi v10 bytes -> Stamp round-trip through real codec.
        let EncodeDesignReply::Ok(canopi_bytes) = tauri::async_runtime::block_on(stamp_to_canopi(
            &executor,
            payload.clone(),
            "Apple guild".into(),
            origin,
        ))
        .unwrap() else {
            panic!("expected Ok exporting stamp to .canopi");
        };
        let DecodeStampReply::Ok(round_tripped) =
            tauri::async_runtime::block_on(canopi_to_stamp(&executor, canopi_bytes, origin))
                .unwrap()
        else {
            panic!("expected Ok importing stamp from .canopi");
        };
        assert_eq!(round_tripped.version, STAMP_PAYLOAD_CURRENT);
        assert_eq!(round_tripped.plants.len(), 1);
        assert_eq!(round_tripped.zones.len(), 1);
        assert_eq!(round_tripped.measurement_guides.len(), 1);
        assert_eq!(round_tripped.groups, payload.groups);
        assert_eq!(
            round_tripped.plant_species_colors,
            payload.plant_species_colors
        );
        assert_eq!(round_tripped.consortiums, payload.consortiums);
        assert_eq!(round_tripped.budget, payload.budget);
        assert_eq!(round_tripped.timeline, payload.timeline);
    }
}
