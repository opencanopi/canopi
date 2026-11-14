//! Tests for the v10 read types' own serde rules, which stand behind the read schema: the
//! defaults they document agree with the schema's, and an order is an unsigned 32-bit
//! integer whatever reaches serde. Out of line so `v10.rs` keeps under the file-size limit.

use super::{SiteDataEntryRead, SiteDataRead, read_schema};
use serde_json::{Value, json};

/// The Site data section's documented defaults (on, opaque) are the frozen schema's, so a
/// field serde fills reads as the schema-filled one would.
#[test]
fn the_site_data_serde_defaults_agree_with_the_frozen_schema() {
    let schema = read_schema().expect("the frozen read schema parses");
    let section = serde_json::from_value::<SiteDataRead>(json!({
        "entries": [{ "id": "lyr-1", "name": "Terrain" }]
    }))
    .expect("an entry of only its identity reads");
    let defs = &schema["$defs"];
    assert_eq!(
        json!(section.visible),
        defs["SiteData"]["properties"]["visible"]["default"]
    );
    let entry = &section.entries[0];
    let documented = &defs["SiteDataEntry"]["properties"];
    assert_eq!(json!(entry.visible), documented["visible"]["default"]);
    assert_eq!(
        Value::from(f64::from(entry.opacity)),
        documented["opacity"]["default"]
    );
    assert_eq!(json!(entry.order), documented["order"]["default"]);
}

/// An order serde meets is read only as an integral value within `u32`: a fraction, a
/// negative or a value past `u32` is refused, never truncated or saturated.
#[test]
fn a_site_data_order_reads_only_as_an_unsigned_32_bit_integer() {
    let order = |value: Value| {
        serde_json::from_value::<SiteDataEntryRead>(json!({
            "id": "lyr-1", "name": "Terrain", "order": value
        }))
        .ok()
        .map(|entry| entry.order)
    };
    assert_eq!(order(json!(3)), Some(3));
    assert_eq!(order(json!(4.0)), Some(4));
    assert_eq!(order(json!(4_294_967_295.0)), Some(u32::MAX));
    for refused in [json!(2.5), json!(-1.0), json!(4_294_967_296.0), json!(-0.5)] {
        assert_eq!(order(refused.clone()), None, "{refused}");
    }
}
