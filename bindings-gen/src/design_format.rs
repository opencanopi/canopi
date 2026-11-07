use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::Path;

pub(crate) fn validate_canopi_design_conformance(
    path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let corpus: serde_json::Value = serde_json::from_str(&content)?;
    validate_canopi_design_conformance_value(&corpus)
}

fn validate_canopi_design_conformance_value(
    corpus: &serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    if corpus.get("contract_version") != Some(&serde_json::json!(1)) {
        return Err("Canopi Design conformance contract_version must be 1".into());
    }
    let expected_facts = serde_json::json!({
        "current_version": canopi_types::design::CURRENT_CANOPI_FILE_VERSION,
        "missing_version": canopi_types::design::MISSING_CANOPI_FILE_VERSION,
        "future_version_policy": canopi_types::design::FUTURE_CANOPI_FILE_VERSION_POLICY,
        "error_kinds": canopi_types::design::CanopiDesignIngestionErrorKind::ALL
            .iter()
            .map(|kind| kind.as_str())
            .collect::<Vec<_>>(),
    });
    if corpus.get("facts") != Some(&expected_facts) {
        return Err(format!(
            "Canopi Design conformance facts differ from generated facts (including current_version): expected {expected_facts}, got {}",
            corpus.get("facts").unwrap_or(&serde_json::Value::Null),
        )
        .into());
    }

    let accepted_documents = corpus
        .get("accepted_documents")
        .and_then(serde_json::Value::as_object)
        .ok_or("Canopi Design conformance accepted_documents must be an object")?;
    if accepted_documents
        .values()
        .any(|document| !document.is_object())
    {
        return Err("Canopi Design conformance accepted documents must be objects".into());
    }
    let cases = corpus
        .get("cases")
        .and_then(serde_json::Value::as_array)
        .ok_or("Canopi Design conformance cases must be an array")?;
    if cases.is_empty() {
        return Err("Canopi Design conformance must declare at least one case".into());
    }

    let valid_error_kinds = canopi_types::design::CanopiDesignIngestionErrorKind::ALL
        .iter()
        .map(|kind| kind.as_str())
        .collect::<BTreeSet<_>>();
    let mut ids = BTreeSet::new();
    for case in cases {
        let case = case
            .as_object()
            .ok_or("Canopi Design conformance case must be an object")?;
        let id = case
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("Canopi Design conformance case must have a non-empty id")?;
        if !ids.insert(id) {
            return Err(format!("duplicate Canopi Design conformance case id: {id}").into());
        }
        if !case.contains_key("input") {
            return Err(format!("Canopi Design conformance case {id} has no input").into());
        }
        let accepted = case.get("accepted").and_then(serde_json::Value::as_str);
        let error_kind = case.get("error_kind").and_then(serde_json::Value::as_str);
        if let Some(site) = case.get("site") {
            // A pre-geolocation Design placed at this site before comparison.
            let placed = site
                .get("lon")
                .and_then(serde_json::Value::as_f64)
                .is_some()
                && site
                    .get("lat")
                    .and_then(serde_json::Value::as_f64)
                    .is_some();
            if !placed || accepted.is_none() {
                return Err(format!(
                    "Canopi Design conformance case {id} with a site must name lon, lat and an accepted document",
                )
                .into());
            }
        }
        match (accepted, error_kind) {
            (Some(document), None) if accepted_documents.contains_key(document) => {}
            (Some(document), None) => {
                return Err(format!(
                    "Canopi Design conformance case {id} references missing accepted document {document}",
                )
                .into());
            }
            (None, Some(kind)) if valid_error_kinds.contains(kind) => {
                validate_refusal_path(id, case)?;
            }
            (None, Some(kind)) => {
                return Err(format!(
                    "Canopi Design conformance case {id} has unknown error kind {kind}",
                )
                .into());
            }
            _ => {
                return Err(format!(
                    "Canopi Design conformance case {id} must declare exactly one outcome",
                )
                .into());
            }
        }
    }
    Ok(())
}

/// Both editions refuse at one path (canopi-cyqd, DR30): a refusal names its `error_path`,
/// and no case carries a native exception.
fn validate_refusal_path(
    id: &str,
    case: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    if case.contains_key("native_error_path") {
        return Err(format!(
            "Canopi Design conformance case {id} has a native_error_path; both editions name error_path",
        )
        .into());
    }
    let named = case
        .get("error_path")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|path| path.starts_with('$'));
    if !named {
        return Err(format!(
            "Canopi Design conformance refusal case {id} must name its error_path"
        )
        .into());
    }
    Ok(())
}

pub(crate) fn render_known_canopi_keys() -> Result<String, Box<dyn std::error::Error>> {
    let mut file =
        String::from("// Generated by `cargo run -p bindings-gen`. Do not edit by hand.\n");
    writeln!(
        file,
        "export const DEFAULT_BUDGET_CURRENCY = {:?}\n",
        canopi_types::design::DEFAULT_BUDGET_CURRENCY,
    )?;
    writeln!(
        file,
        "export const DEFAULT_PLANT_SYMBOL_ID = {:?}\n",
        canopi_types::design::DEFAULT_PLANT_SYMBOL_ID,
    )?;
    file.push_str("export const PLANT_SYMBOL_IDS = [\n");
    for symbol in canopi_types::design::PLANT_SYMBOL_IDS {
        writeln!(file, "  {:?},", symbol)?;
    }
    file.push_str("] as const\n");
    file.push_str("export type PlantSymbolId = (typeof PLANT_SYMBOL_IDS)[number]\n\n");

    file.push_str("export const KNOWN_CANOPI_KEYS = [\n");
    for field in canopi_types::design::DESIGN_FILE_FIELDS {
        writeln!(file, "  {:?},", field.key)?;
    }
    file.push_str("] as const\n");
    file.push_str("\nexport type KnownCanopiKey = (typeof KNOWN_CANOPI_KEYS)[number]\n");
    file.push_str("export type DocumentFileFieldOwner = 'document' | 'scene'\n\n");
    file.push_str("export const DOCUMENT_FILE_FIELD_OWNERS = {\n");
    for field in canopi_types::design::DESIGN_FILE_FIELDS {
        writeln!(file, "  {}: {:?},", field.key, field.owner.as_str())?;
    }
    file.push_str("} as const satisfies Record<KnownCanopiKey, DocumentFileFieldOwner>\n");
    Ok(file)
}

pub(crate) fn render_canopi_design_format() -> Result<String, Box<dyn std::error::Error>> {
    let schema = canopi_types::design::canopi_file_json_schema();
    validate_canopi_design_schema(&schema)?;
    let schema_json = serde_json::to_string_pretty(&schema)?;
    let mut file =
        String::from("// Generated by `cargo run -p bindings-gen`. Do not edit by hand.\n\n");
    writeln!(
        file,
        "export const CURRENT_CANOPI_FILE_VERSION = {}\n",
        canopi_types::design::CURRENT_CANOPI_FILE_VERSION,
    )?;
    writeln!(
        file,
        "export const MISSING_CANOPI_FILE_VERSION = {}",
        canopi_types::design::MISSING_CANOPI_FILE_VERSION,
    )?;
    writeln!(
        file,
        "export const WEB_MERCATOR_MAX_LATITUDE_DEG = {:?}",
        canopi_types::design::WEB_MERCATOR_MAX_LATITUDE_DEG,
    )?;
    writeln!(
        file,
        "export const FUTURE_CANOPI_FILE_VERSION_POLICY = {:?} as const\n",
        canopi_types::design::FUTURE_CANOPI_FILE_VERSION_POLICY,
    )?;
    writeln!(
        file,
        "export const SAVED_VIEW_MAX_ZOOM = {:?}",
        canopi_types::views::SAVED_VIEW_MAX_ZOOM,
    )?;
    writeln!(
        file,
        "export const SAVED_VIEW_MAX_GROUND_SIZE_M = {:?}",
        canopi_types::views::SAVED_VIEW_MAX_GROUND_SIZE_M,
    )?;
    writeln!(
        file,
        "export const RICH_TEXT_LINK_SCHEMES = {} as const",
        serde_json::to_string(canopi_types::views::RICH_TEXT_LINK_SCHEMES)?,
    )?;
    writeln!(
        file,
        "export const STORY_IMAGE_DATA_TYPES = {} as const",
        serde_json::to_string(canopi_types::views::STORY_IMAGE_DATA_TYPES)?,
    )?;
    writeln!(
        file,
        "export const STORY_IMAGE_MAX_BYTES = {}",
        canopi_types::views::STORY_IMAGE_MAX_BYTES,
    )?;
    writeln!(
        file,
        "export const STORY_IMAGES_MAX_TOTAL_BYTES = {}\n",
        canopi_types::views::STORY_IMAGES_MAX_TOTAL_BYTES,
    )?;
    file.push_str("export const CANOPI_DESIGN_INGESTION_ERROR_KINDS = [\n");
    for kind in canopi_types::design::CanopiDesignIngestionErrorKind::ALL {
        writeln!(file, "  {:?},", kind.as_str())?;
    }
    file.push_str("] as const\n");
    file.push_str(
        "export type CanopiDesignIngestionErrorKind = (typeof CANOPI_DESIGN_INGESTION_ERROR_KINDS)[number]\n\n",
    );
    writeln!(
        file,
        "export const CANOPI_FILE_SCHEMA = {schema_json} as const"
    )?;
    Ok(file)
}

fn validate_canopi_design_schema(
    schema: &serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let properties = schema
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .ok_or("generated CanopiFile schema has no root properties")?;
    let actual = properties
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected = canopi_types::design::DESIGN_FILE_FIELDS
        .iter()
        .map(|field| field.key)
        .filter(|key| *key != "extra")
        .collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(format!(
            "generated CanopiFile schema fields differ from DESIGN_FILE_FIELDS: expected {expected:?}, got {actual:?}",
        )
        .into());
    }
    if schema.get("additionalProperties") != Some(&serde_json::Value::Bool(true)) {
        return Err(
            "generated CanopiFile schema must preserve flattened unknown root fields".into(),
        );
    }
    validate_supported_canopi_schema_node(schema, "$schema")?;
    Ok(())
}

fn validate_supported_canopi_schema_node(
    schema: &serde_json::Value,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use canopi_types::design::{
        CANOPI_SCHEMA_FORMATS as SUPPORTED_FORMATS, CANOPI_SCHEMA_KEYWORDS as SUPPORTED_KEYWORDS,
    };

    let object = schema
        .as_object()
        .ok_or_else(|| format!("{path}: generated schema node is not an object"))?;
    for keyword in object.keys() {
        if !SUPPORTED_KEYWORDS.contains(&keyword.as_str()) {
            return Err(format!(
                "{path}: generated Canopi schema keyword {keyword} is not supported by the Web decoder",
            )
            .into());
        }
    }
    if let Some(format) = object.get("format") {
        let format = format
            .as_str()
            .ok_or_else(|| format!("{path}: generated schema format is not a string"))?;
        if !SUPPORTED_FORMATS.contains(&format) {
            return Err(format!(
                "{path}: generated Canopi schema format {format} is not supported by the Web decoder",
            )
            .into());
        }
    }

    for (container_key, container) in [
        ("$defs", object.get("$defs")),
        ("properties", object.get("properties")),
    ] {
        let Some(entries) = container.and_then(serde_json::Value::as_object) else {
            continue;
        };
        for (key, child) in entries {
            validate_supported_canopi_schema_node(child, &format!("{path}.{container_key}.{key}"))?;
        }
    }
    for keyword in ["items", "additionalProperties"] {
        if let Some(child) = object.get(keyword).filter(|child| child.is_object()) {
            validate_supported_canopi_schema_node(child, &format!("{path}.{keyword}"))?;
        }
    }
    for keyword in ["anyOf", "oneOf"] {
        let Some(children) = object.get(keyword).and_then(serde_json::Value::as_array) else {
            continue;
        };
        for (index, child) in children.iter().enumerate() {
            validate_supported_canopi_schema_node(child, &format!("{path}.{keyword}[{index}]"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_canopi_design_conformance_value, validate_canopi_design_schema};

    #[test]
    fn generated_canopi_schema_matches_the_file_authority() {
        let schema = canopi_types::design::canopi_file_json_schema();
        validate_canopi_design_schema(&schema).expect("Canopi schema should be consumable by Web");
    }

    /// The Web decoder walks a schema object's properties in the order this emitter writes
    /// them, and the native admission walker sorts them; both report the first fault, so the
    /// emitted order must be sorted (serde_json without `preserve_order`, canopi-cyqd).
    #[test]
    fn generated_canopi_schema_emits_properties_in_sorted_key_order() {
        let schema = canopi_types::design::canopi_file_json_schema();
        let emitted = serde_json::to_string_pretty(&schema).expect("schema serializes");
        let mut keys = schema["properties"]
            .as_object()
            .expect("root properties")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        let positions = keys
            .iter()
            .map(|key| {
                emitted
                    .find(&format!("\n    \"{key}\": "))
                    .unwrap_or_else(|| panic!("root property {key} is emitted"))
            })
            .collect::<Vec<_>>();
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "root properties are emitted in sorted key order: {keys:?}"
        );
    }

    #[test]
    fn generated_canopi_schema_rejects_decoder_keywords_before_emitting() {
        let mut schema = canopi_types::design::canopi_file_json_schema();
        schema
            .as_object_mut()
            .expect("root schema object")
            .insert("maxItems".to_owned(), serde_json::json!(1));

        let error = validate_canopi_design_schema(&schema)
            .expect_err("unknown decoder keyword should stop generation");
        assert!(error.to_string().contains("maxItems"));
    }

    #[test]
    fn generated_canopi_schema_rejects_unsupported_numeric_formats() {
        let mut schema = canopi_types::design::canopi_file_json_schema();
        schema["properties"]["version"]["format"] = serde_json::json!("uint64");

        let error = validate_canopi_design_schema(&schema)
            .expect_err("unknown numeric format should stop generation");
        assert!(error.to_string().contains("uint64"));
    }

    #[test]
    fn generated_canopi_facts_reject_drift_from_the_authored_corpus() {
        let mut corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../canopi-types/canopi-design-conformance.json"
        ))
        .expect("authored corpus should parse");
        corpus["facts"]["current_version"] = serde_json::json!(4);

        let error = validate_canopi_design_conformance_value(&corpus)
            .expect_err("version fact drift should stop generation");

        assert!(error.to_string().contains("current_version"));
    }

    /// canopi-cyqd: every refusal case names the path both editions refuse at, and no case
    /// carries a native exception (DR30).
    #[test]
    fn canopi_cyqd_a_refusal_case_must_name_its_path_and_no_native_exception() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../canopi-types/canopi-design-conformance.json"
        ))
        .expect("authored corpus should parse");
        validate_canopi_design_conformance_value(&corpus).expect("the authored corpus is valid");
        let refusal = corpus["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .position(|case| case.get("error_kind").is_some())
            .expect("a refusal case");

        let mut pathless = corpus.clone();
        pathless["cases"][refusal]
            .as_object_mut()
            .expect("case object")
            .remove("error_path");
        let error = validate_canopi_design_conformance_value(&pathless)
            .expect_err("a refusal without its path stops generation");
        assert!(error.to_string().contains("error_path"), "{error}");

        let mut native = corpus;
        native["cases"][refusal]["native_error_path"] = serde_json::json!("$");
        let error = validate_canopi_design_conformance_value(&native)
            .expect_err("a native exception stops generation");
        assert!(error.to_string().contains("native_error_path"), "{error}");
    }
}
