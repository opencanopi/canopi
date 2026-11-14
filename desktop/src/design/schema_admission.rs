//! The v9 schema the Desktop decode admits a `.canopi` value by (canopi-cyqd, 2.1-M430),
//! walked by `canopi-format`'s schema walker (`canopi_format::schema`) before serde. It stays
//! beside the v9 decode in `format.rs` until 2b moves that decode into `canopi-format`.

use canopi_types::design::field_path::Refusal;
use serde_json::Value;

/// The first value of `value` the generated v9 `CanopiFile` schema refuses.
pub(crate) fn admit_v9_schema(value: &Value) -> Result<(), Refusal> {
    canopi_format::schema::admit_schema(value, canopi_file_schema())
}

/// The generated `CanopiFile` schema, built once; in tests a keyword outside
/// `CANOPI_SCHEMA_KEYWORDS` panics here (bindings-gen refuses to emit one).
fn canopi_file_schema() -> &'static Value {
    static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| checked(canopi_types::design::canopi_file_json_schema()))
}

fn checked(schema: Value) -> Value {
    #[cfg(test)]
    assert_eq!(canopi_format::schema::unsupported_keyword(&schema), None);
    schema
}

#[cfg(test)]
mod tests {
    use super::canopi_file_schema;
    use serde_json::json;

    #[test]
    fn the_schema_is_built_once() {
        assert!(std::ptr::eq(canopi_file_schema(), canopi_file_schema()));
    }

    /// A keyword the walker does not handle would admit what the Web refuses: in tests it
    /// stops the schema's build (bindings-gen refuses to emit one).
    #[test]
    #[should_panic(expected = "$schema.properties.plants: keyword maxItems")]
    fn an_unsupported_schema_keyword_panics_in_tests() {
        let mut schema = canopi_types::design::canopi_file_json_schema();
        schema["properties"]["plants"]["maxItems"] = json!(1);
        super::checked(schema);
    }

    /// The v9 decode's refusals come from the walker over this schema: a new Design passes
    /// and a refused field is named by its path (the corpus in `format.rs` holds the rest).
    #[test]
    fn the_v9_schema_admits_a_new_design_and_names_a_refused_field() {
        let file = crate::design::format::create_new_design("Garden", "2026-07-02T00:00:00Z");
        let mut value = serde_json::to_value(file).expect("a new Design serializes");
        assert_eq!(super::admit_v9_schema(&value), Ok(()));
        value["plants"] = json!([{ "id": "p", "canonical_name": "Malus", "position": { "lon": 2.0, "lat": 86.0 } }]);
        let refusal = super::admit_v9_schema(&value).expect_err("lat 86 is off the map");
        assert_eq!(refusal.field_path.to_string(), "$.plants[0].position.lat");
    }
}
