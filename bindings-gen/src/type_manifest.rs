//! The type manifest (2.1-M165, ADR 0028 Diagrams): for each struct the frontend contracts export, its
//! named fields with serde `flatten` and skip, so the docs gate holds classDiagram fields to the bindings
//! as plain JSON (2.1-M192, no node or cargo there). Types are sorted by name and fields keep declaration
//! order, so the output is byte-identical on rerun. Enums and tuple or unit structs have no named fields
//! and are not listed, which leaves their classes to the docs class-name check. The pinned specta
//! (2.1-M212) keeps a skipped field with no type and carries `flatten` as a serde runtime attribute.

use serde::Serialize;
use specta::TypeCollection;
use specta::datatype::{DataType, Field, Fields, RuntimeMeta, RuntimeNestedMeta};

#[derive(Serialize)]
struct ManifestType<'a> {
    name: &'a str,
    fields: Vec<ManifestField<'a>>,
}

#[derive(Serialize)]
struct ManifestField<'a> {
    name: &'a str,
    flatten: bool,
    skip: bool,
}

pub(crate) fn render_type_manifest(
    types: &TypeCollection,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut manifest: Vec<ManifestType> = types
        .into_unsorted_iter()
        .filter_map(|named| {
            let DataType::Struct(strukt) = named.ty() else {
                return None;
            };
            let Fields::Named(fields) = strukt.fields() else {
                return None;
            };
            Some(ManifestType {
                name: named.name(),
                fields: fields
                    .fields()
                    .iter()
                    .map(|(name, field)| ManifestField {
                        name,
                        flatten: is_flattened(field),
                        skip: field.ty().is_none(),
                    })
                    .collect(),
            })
        })
        .collect();
    manifest.sort_by(|a, b| a.name.cmp(b.name));
    let mut rendered = serde_json::to_string_pretty(&manifest)?;
    rendered.push('\n');
    Ok(rendered)
}

fn is_flattened(field: &Field) -> bool {
    field.attributes().iter().any(|attribute| {
        attribute.path == "serde"
            && matches!(&attribute.kind, RuntimeMeta::List(items) if items.iter().any(|item| {
                matches!(item, RuntimeNestedMeta::Meta(RuntimeMeta::Path(path)) if path == "flatten")
            }))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    fn manifest() -> Value {
        let rendered = super::render_type_manifest(&crate::contracts::contract_types())
            .expect("the type manifest renders");
        serde_json::from_str(&rendered).expect("the type manifest is JSON")
    }

    fn fields_of(manifest: &Value, name: &str) -> Vec<Value> {
        manifest
            .as_array()
            .expect("the manifest is a list of types")
            .iter()
            .find(|entry| entry["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed"))["fields"]
            .as_array()
            .expect("fields is a list")
            .clone()
    }

    #[test]
    fn canopi_file_extra_is_flagged_flatten() {
        let fields = fields_of(&manifest(), "CanopiFile");
        let extra = fields
            .iter()
            .find(|field| field["name"] == "extra")
            .expect("extra is listed");
        assert_eq!(extra["flatten"], true);
        let name = fields
            .iter()
            .find(|field| field["name"] == "name")
            .expect("name is listed");
        assert_eq!(name["flatten"], false);
    }

    #[test]
    fn a_field_specta_skips_is_listed_with_skip() {
        let fields = fields_of(&manifest(), "CanopiFile");
        let skipped: Vec<_> = fields
            .iter()
            .filter(|field| field["skip"] == true)
            .map(|field| field["name"].as_str().unwrap())
            .collect();
        assert_eq!(skipped, ["extra"]);
        assert_eq!(
            fields.first().unwrap()["name"],
            "version",
            "declaration order"
        );
    }

    #[test]
    fn types_are_sorted_and_enums_are_not_listed() {
        let manifest = manifest();
        let names: Vec<_> = manifest
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap().to_owned())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        assert!(names.iter().any(|name| name == "TimelineAction"));
        assert!(
            !names.iter().any(|name| name == "Theme"),
            "Theme is an enum"
        );
    }

    #[test]
    fn the_manifest_is_byte_identical_on_rerun() {
        let first = super::render_type_manifest(&crate::contracts::contract_types()).unwrap();
        let second = super::render_type_manifest(&crate::contracts::contract_types()).unwrap();
        assert_eq!(first, second);
        assert!(first.ends_with("]\n"));
    }
}
