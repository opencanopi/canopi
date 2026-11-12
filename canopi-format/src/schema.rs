//! Schema admission for `.canopi` values, run before serde (canopi-cyqd, 2.1-M430): a port
//! of the Web decoder's interpreter (`app/contracts/canopi-design-schema-decoder.ts`) for the
//! generated Schemars subset (`CANOPI_SCHEMA_KEYWORDS`), so a refused file names the field
//! the Web names, as a typed [`FieldPath`] rather than serde's root or parent object. The
//! Desktop v9 decode walks the generated `CanopiFile` schema with it until 2b moves that
//! decode here; the v10 read admission walks the v10 read schema ([`crate::read`]).
//!
//! It validates only; serde builds the Design after it. Like the Web it walks a schema
//! object's properties in sorted key order (sorted here explicitly; serde_json is built
//! without `preserve_order`, so the emitted schema the Web walks is sorted too) and reports
//! the first fault. A map's entries are walked in sorted key order where the Web walks them
//! in file order, so with two faults in one map the two may name different entries; the
//! path names a map value as `[*]`, never its key, and is diagnostic only (2.1-Q286).
//! Unknown keys are not refused: the root keeps them and nested objects drop them, as serde.

use canopi_types::design::field_path::{FieldPath, Refusal};
use canopi_types::design::{CANOPI_SCHEMA_FORMATS, CANOPI_SCHEMA_KEYWORDS};
use serde_json::{Map, Number, Value};

/// The first value of `value` the generated `schema` refuses.
///
/// # Errors
///
/// The refusal naming the first refused value's [`FieldPath`] and what was expected there,
/// never the value.
pub fn admit_schema(value: &Value, schema: &'static Value) -> Result<(), Refusal> {
    Walker { root: schema }.walk(value, schema, &FieldPath::root())
}

/// The first keyword or number format of `schema` the walker does not handle, with where it
/// is (`$schema.properties.plants: keyword maxItems`): a schema with one would admit what the
/// Web refuses, so each schema's builder checks it in tests and bindings-gen refuses to emit it.
pub fn unsupported_keyword(schema: &Value) -> Option<String> {
    unsupported_keyword_at(schema, "$schema")
}

fn unsupported_keyword_at(schema: &Value, at: &str) -> Option<String> {
    let object = schema.as_object()?;
    if let Some(keyword) = object
        .keys()
        .find(|keyword| !CANOPI_SCHEMA_KEYWORDS.contains(&keyword.as_str()))
    {
        return Some(format!("{at}: keyword {keyword}"));
    }
    if let Some(format) = object.get("format").and_then(Value::as_str)
        && !CANOPI_SCHEMA_FORMATS.contains(&format)
    {
        return Some(format!("{at}: format {format}"));
    }
    let named = ["$defs", "properties"].into_iter().flat_map(|container| {
        object
            .get(container)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .map(move |(key, child)| (format!("{at}.{container}.{key}"), child))
    });
    let single = ["items", "additionalProperties"]
        .into_iter()
        .filter_map(|keyword| Some((format!("{at}.{keyword}"), object.get(keyword)?)));
    let listed = ["anyOf", "oneOf"].into_iter().flat_map(|keyword| {
        object
            .get(keyword)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .map(move |(index, child)| (format!("{at}.{keyword}[{index}]"), child))
    });
    named
        .chain(single)
        .chain(listed)
        .find_map(|(path, child)| unsupported_keyword_at(child, &path))
}

struct Walker {
    root: &'static Value,
}

impl Walker {
    fn walk(&self, value: &Value, schema: &'static Value, path: &FieldPath) -> Result<(), Refusal> {
        if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            return self.walk(value, self.resolve(reference, path)?, path);
        }
        if let Some(alternatives) = schema.get("anyOf").and_then(Value::as_array) {
            return self.any_of(value, alternatives, path);
        }
        if let Some(alternatives) = schema.get("oneOf").and_then(Value::as_array) {
            return self.one_of(value, alternatives, path);
        }
        if let Some(expected) = schema.get("const")
            && value != expected
        {
            return Err(Refusal::new(
                path.clone(),
                format!("expected {}", literal(expected)),
            ));
        }
        if let Some(entries) = schema.get("enum").and_then(Value::as_array)
            && !entries.contains(value)
        {
            let listed = entries.iter().map(literal).collect::<Vec<_>>().join(", ");
            return Err(Refusal::new(
                path.clone(),
                format!("expected one of {listed}"),
            ));
        }
        let types = type_list(schema);
        if !types.is_empty() && !types.iter().any(|kind| matches_type(value, kind)) {
            return Err(Refusal::new(path.clone(), expected_types(&types)));
        }
        if types.contains(&"number") || types.contains(&"integer") {
            check_number(value, schema, path, types.contains(&"integer"))?;
        }
        if let (Some(items), Some(entries)) = (schema.get("items"), value.as_array())
            && types.contains(&"array")
        {
            for (index, item) in entries.iter().enumerate() {
                self.walk(item, items, &path.index(index))?;
            }
        }
        if let Some(object) = value.as_object()
            && types.contains(&"object")
        {
            self.object(object, schema, path)?;
        }
        Ok(())
    }

    fn object(
        &self,
        value: &Map<String, Value>,
        schema: &'static Value,
        path: &FieldPath,
    ) -> Result<(), Refusal> {
        let required = schema.get("required").and_then(Value::as_array);
        let is_required = |key: &str| required.is_some_and(|keys| keys.iter().any(|k| k == key));
        let mut properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .map(|properties| properties.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        properties.sort_by_key(|&(key, _)| key);
        for &(key, property) in &properties {
            let key: &'static str = key.as_str();
            let property_path = path.field(key);
            match value.get(key) {
                Some(entry) => self.walk(entry, property, &property_path)?,
                None if property.get("default").is_some() => {}
                None if is_required(key) => {
                    return Err(Refusal::new(property_path, "missing required value"));
                }
                None => {}
            }
        }
        let Some(additional) = schema
            .get("additionalProperties")
            .filter(|additional| additional.is_object())
        else {
            return Ok(());
        };
        let mut extra = value
            .iter()
            .filter(|(key, _)| !properties.iter().any(|(known, _)| *known == *key))
            .collect::<Vec<_>>();
        extra.sort_by_key(|&(key, _)| key);
        for (_, entry) in extra {
            self.walk(entry, additional, &path.map_value())?;
        }
        Ok(())
    }

    /// The first alternative that admits `value`, else the refusal whose path reaches
    /// deepest (the first of equals), as the Web picks it.
    fn any_of(
        &self,
        value: &Value,
        alternatives: &'static [Value],
        path: &FieldPath,
    ) -> Result<(), Refusal> {
        let mut deepest: Option<Refusal> = None;
        for alternative in alternatives {
            let Err(refusal) = self.walk(value, alternative, path) else {
                return Ok(());
            };
            let deeper = deepest.as_ref().is_none_or(|best| {
                refusal.field_path.to_string().len() > best.field_path.to_string().len()
            });
            if deeper {
                deepest = Some(refusal);
            }
        }
        Err(deepest.unwrap_or_else(|| {
            Refusal::new(
                path.clone(),
                "value does not match the Canopi Design contract",
            )
        }))
    }

    /// A tagged enum is chosen by its `kind`, an unknown or missing one refused at `.kind`;
    /// any other `oneOf` is walked as `anyOf`.
    fn one_of(
        &self,
        value: &Value,
        alternatives: &'static [Value],
        path: &FieldPath,
    ) -> Result<(), Refusal> {
        let kinds = alternatives
            .iter()
            .map(|alternative| alternative.pointer("/properties/kind/const"))
            .collect::<Option<Vec<_>>>();
        let (Some(object), Some(kinds)) = (value.as_object(), kinds) else {
            return self.any_of(value, alternatives, path);
        };
        let selected = kinds
            .iter()
            .position(|kind| object.get("kind") == Some(*kind));
        match selected {
            Some(index) => self.walk(value, &alternatives[index], path),
            None => {
                let listed = kinds.iter().map(|kind| literal(kind)).collect::<Vec<_>>();
                let expected = format!("expected one of {}", listed.join(", "));
                Err(Refusal::new(path.field("kind"), expected))
            }
        }
    }

    fn resolve(&self, reference: &str, path: &FieldPath) -> Result<&'static Value, Refusal> {
        let resolved = reference.strip_prefix('#').and_then(|pointer| {
            let pointer = pointer.replace("~1", "/").replace("~0", "~");
            self.root.pointer(&pointer)
        });
        resolved.filter(|schema| schema.is_object()).ok_or_else(|| {
            Refusal::new(path.clone(), "a schema reference this build cannot resolve")
        })
    }
}

fn type_list(schema: &Value) -> Vec<&str> {
    match schema.get("type") {
        Some(Value::String(kind)) => vec![kind.as_str()],
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn is_integer(number: &Number) -> bool {
    number.is_i64() || number.is_u64() || number.as_f64().is_some_and(|value| value.fract() == 0.0)
}

fn matches_type(value: &Value, kind: &str) -> bool {
    match (kind, value) {
        ("null", Value::Null)
        | ("array", Value::Array(_))
        | ("object", Value::Object(_))
        | ("number", Value::Number(_))
        | ("string", Value::String(_))
        | ("boolean", Value::Bool(_)) => true,
        ("integer", Value::Number(number)) => is_integer(number),
        _ => false,
    }
}

fn expected_types(types: &[&str]) -> String {
    match types {
        ["number"] => return "expected a finite number".to_owned(),
        ["integer"] => return "expected an integer".to_owned(),
        _ => {}
    }
    let described = types
        .iter()
        .map(|kind| match *kind {
            "array" => "an array",
            "object" => "an object",
            "number" => "a finite number",
            "integer" => "an integer",
            "string" => "a string",
            "boolean" => "a boolean",
            other => other,
        })
        .collect::<Vec<_>>();
    format!("expected {}", described.join(" or "))
}

const UINT32_MAX: f64 = 4_294_967_295.0;
const FLOAT32_MAX: f64 = 3.402_823_466_385_288_6e38;

fn check_number(
    value: &Value,
    schema: &Value,
    path: &FieldPath,
    integer: bool,
) -> Result<(), Refusal> {
    let refuse = |expected: String| Err(Refusal::new(path.clone(), expected));
    let Value::Number(number) = value else {
        if value.is_null() && type_list(schema).contains(&"null") {
            return Ok(());
        }
        let expected = if integer {
            "expected an integer"
        } else {
            "expected a finite number"
        };
        return refuse(expected.to_owned());
    };
    if integer && !is_integer(number) {
        return refuse("expected an integer".to_owned());
    }
    let Some(float) = number.as_f64() else {
        return refuse("expected a finite number".to_owned());
    };
    let bound = |key: &str| schema.get(key).and_then(Value::as_f64);
    if let Some(minimum) = bound("minimum")
        && float < minimum
    {
        return refuse(format!(
            "expected a number greater than or equal to {minimum}"
        ));
    }
    if let Some(maximum) = bound("maximum")
        && float > maximum
    {
        return refuse(format!("expected a number less than or equal to {maximum}"));
    }
    match schema.get("format").and_then(Value::as_str) {
        Some("uint32") if float > UINT32_MAX => {
            refuse("expected an unsigned 32-bit integer".to_owned())
        }
        Some("int32") if !(f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&float) => {
            refuse("expected a signed 32-bit integer".to_owned())
        }
        Some("float") if float.abs() > FLOAT32_MAX => {
            refuse("expected a finite 32-bit number".to_owned())
        }
        _ => Ok(()),
    }
}

/// A schema literal as JSON, as the Web prints it; never a file value.
fn literal(value: &Value) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::{admit_schema, unsupported_keyword};
    use serde_json::{Value, json};

    /// The generated v9 `CanopiFile` schema, the one the Desktop decode walks.
    fn v9_schema() -> &'static Value {
        static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        SCHEMA.get_or_init(canopi_types::design::canopi_file_json_schema)
    }

    /// A new v9 Design as the Desktop writes it.
    fn design() -> Value {
        let layer =
            |name: &str| json!({ "name": name, "visible": true, "locked": false, "opacity": 1.0 });
        json!({
            "version": 9, "name": "Garden", "description": null,
            "plant_species_colors": {}, "plant_species_symbols": {}, "plant_species_codes": {},
            "layers": [layer("base"), layer("plants"), layer("zones"), layer("annotations")],
            "plants": [], "zones": [], "annotations": [], "measurement_guides": [],
            "consortiums": [], "groups": [], "timeline": [], "budget": [], "budget_currency": "EUR",
            "views": [], "stories": [],
            "created_at": "2026-07-02T00:00:00Z", "updated_at": "2026-07-02T00:00:00Z"
        })
    }

    fn view(camera: Value) -> Value {
        json!({
            "id": "view-1", "name": "Hedges", "camera": camera,
            "visible_layers": {
                "background": { "kind": "satellite" },
                "terrain": { "contours": false, "hillshade": false },
                "scene_layers": [], "site_data": []
            },
            "highlighted": { "species": [], "objects": [] },
            "title": "Hedges", "text": []
        })
    }

    fn camera() -> Value {
        json!({
            "lon": 2.29, "lat": 48.85, "zoom": 19.0, "bearing": 0.0,
            "ground_size_m": { "width": 312.5, "height": 187.5 }
        })
    }

    /// The path and text of the refusal, or `None` when `value` is admitted.
    fn refused(value: &Value) -> Option<(String, String)> {
        admit_schema(value, v9_schema())
            .err()
            .map(|refusal| (refusal.field_path.to_string(), refusal.to_string()))
    }

    fn path_of(value: &Value) -> String {
        refused(value).expect("the value is refused").0
    }

    #[test]
    fn a_new_design_is_admitted() {
        assert_eq!(refused(&design()), None);
        let mut value = design();
        value["views"] = json!([view(camera())]);
        value["map_view"] = camera();
        value["future_field"] = json!({ "kept": [1, "two"] });
        assert_eq!(refused(&value), None);
    }

    /// canopi-cyqd: of two faults the first in sorted key order is named, as the Web decoder
    /// names it, whatever order the file lists them in.
    #[test]
    fn canopi_cyqd_of_two_faults_the_first_in_sorted_key_order_is_named() {
        let mut value = design();
        let object = value.as_object_mut().expect("object");
        object.insert(
            "zones".to_owned(),
            json!([{ "zone_type": "rect", "points": [] }]),
        );
        object.insert(
            "plants".to_owned(),
            json!([{ "id": "p", "canonical_name": "Malus", "position": { "lon": 2.0, "lat": 86.0 } }]),
        );
        assert_eq!(path_of(&value), "$.plants[0].position.lat");

        let mut camera = camera();
        camera["zoom"] = json!(28.0);
        camera["lat"] = json!(-90.0);
        value["map_view"] = camera;
        assert_eq!(path_of(&value), "$.map_view.lat");

        let mut missing = design();
        let object = missing.as_object_mut().expect("object");
        object.remove("updated_at");
        object.remove("budget");
        assert_eq!(path_of(&missing), "$.budget");
    }

    /// canopi-cyqd: inside a tagged enum an unknown kind names `.kind`, and a missing field
    /// of a known kind names that field.
    #[test]
    fn canopi_cyqd_a_tagged_enum_names_its_kind_or_its_missing_leaf() {
        let mut value = design();
        let mut highlighted = view(camera());
        highlighted["highlighted"]["objects"] = json!([{ "kind": "pond", "id": "p" }]);
        value["views"] = json!([highlighted]);
        assert_eq!(path_of(&value), "$.views[0].highlighted.objects[0].kind");

        let mut value = design();
        let mut no_kind = view(camera());
        no_kind["highlighted"]["objects"] = json!([{ "id": "p" }]);
        value["views"] = json!([no_kind]);
        assert_eq!(path_of(&value), "$.views[0].highlighted.objects[0].kind");

        let mut value = design();
        value["timeline"] = json!([{
            "id": "task-1", "action_type": "planting", "description": "Plant",
            "start_date": "2026-04-01", "end_date": "2026-04-02", "recurrence": null,
            "targets": [{ "kind": "zone" }], "depends_on": null, "completed": false, "order": 0
        }]);
        assert_eq!(path_of(&value), "$.timeline[0].targets[0].zone_id");
    }

    /// canopi-cyqd: a fault in a map names the map's value, never its key. Of two faults in
    /// one map the first in sorted key order is named, where the Web names the first in file
    /// order: the two may differ, which is diagnostic only (the path never reaches the user).
    #[test]
    fn canopi_cyqd_a_map_fault_names_the_map_value_never_its_key() {
        let mut value = design();
        value["plant_species_colors"] = json!({ "Pyrus": 2, "Malus domestica": 1 });
        let (path, text) = refused(&value).expect("a number is not a colour");
        assert_eq!(path, "$.plant_species_colors[*]");
        assert!(!text.contains("Malus") && !text.contains("Pyrus"), "{text}");
    }

    /// canopi-cyqd: the refusal reads as the path and what was expected, never a file value:
    /// a hostile species key or enum value stays out of it.
    #[test]
    fn canopi_cyqd_a_refusal_never_carries_a_file_value() {
        let hostile = "<img src=x onerror=alert(1)> /home/alice/garden.canopi";
        let mut value = design();
        value["plant_species_colors"] = json!({ hostile: 5 });
        let (_, text) = refused(&value).expect("a number is not a colour");
        assert_eq!(text, "$.plant_species_colors[*]: expected a string");

        let mut value = design();
        let mut labelled = view(camera());
        labelled["labels"] = json!(hostile);
        value["views"] = json!([labelled]);
        let (path, text) = refused(&value).expect("an unknown label mode");
        assert_eq!(path, "$.views[0].labels");
        assert!(
            !text.contains("alice") && !text.contains("onerror"),
            "{text}"
        );

        let mut value = design();
        value["name"] = json!({ hostile: hostile });
        let (path, text) = refused(&value).expect("a name is a string");
        assert_eq!((path.as_str(), text.contains("alice")), ("$.name", false));
    }

    #[test]
    fn numbers_are_held_to_their_schema_bounds_and_formats() {
        for (field, number, expected) in [
            (
                "zoom",
                json!(27.5),
                "$.map_view.zoom: expected a number less than or equal to 27",
            ),
            (
                "bearing",
                json!(-1),
                "$.map_view.bearing: expected a number greater than or equal to 0",
            ),
            (
                "lon",
                json!("2"),
                "$.map_view.lon: expected a finite number",
            ),
        ] {
            let mut value = design();
            let mut view_camera = camera();
            view_camera[field] = number;
            value["map_view"] = view_camera;
            assert_eq!(
                refused(&value).map(|(_, text)| text).as_deref(),
                Some(expected)
            );
        }
        let mut value = design();
        value["version"] = json!(9.5);
        assert_eq!(path_of(&value), "$.version");
    }

    /// A keyword the walker does not handle would admit what the Web refuses: the check
    /// every schema builder runs in tests names it and where it is.
    #[test]
    fn an_unsupported_schema_keyword_is_named_with_its_place() {
        assert_eq!(unsupported_keyword(v9_schema()), None);
        let mut schema = v9_schema().clone();
        schema["properties"]["plants"]["maxItems"] = json!(1);
        assert_eq!(
            unsupported_keyword(&schema).as_deref(),
            Some("$schema.properties.plants: keyword maxItems")
        );
        schema["properties"]["plants"] = json!({ "type": "number", "format": "int64" });
        assert_eq!(
            unsupported_keyword(&schema).as_deref(),
            Some("$schema.properties.plants: format int64")
        );
    }
}
