//! Renders `common-types/analysis-registry.json` into the desktop crate's
//! static registry table and the frontend's typed const array.
//!
//! The JSON says what an analysis is; validation here refuses a registry the
//! runtime could misread (unknown quantities, defaults outside their range,
//! `visible_when` naming nothing, unit maps that miss an option). i18n keys are
//! derived by convention, so the frontend can check every locale defines them.

use common_types::library::RasterQuantity;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrySchema {
    version: u32,
    analyses: Vec<AnalysisSchema>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnalysisSchema {
    id: String,
    version: u32,
    group: String,
    lane: LaneSchema,
    inputs: Vec<InputSchema>,
    params: Vec<ParamSchema>,
    outputs: Vec<OutputSchema>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LaneSchema {
    GeolibreWindowed { halo: u32 },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InputSchema {
    key: String,
    accepts: Vec<ItemTypeSchema>,
    requires: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ItemTypeSchema {
    Raster { quantity: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ParamSchema {
    key: String,
    kind: ParamKindSchema,
    default: serde_json::Value,
    advanced: bool,
    visible_when: Option<VisibleWhenSchema>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ParamKindSchema {
    Choice {
        options: Vec<String>,
    },
    Number {
        min: f64,
        max: f64,
        step: f64,
        unit: String,
    },
    Integer {
        min: i32,
        max: i32,
    },
    Boolean,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VisibleWhenSchema {
    param: String,
    equals: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputSchema {
    key: String,
    item: ItemTypeSchema,
    units: UnitsSchema,
    optional: bool,
    default_selected: bool,
    presentable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum UnitsSchema {
    Fixed {
        value: String,
    },
    ByParam {
        param: String,
        map: BTreeMap<String, String>,
    },
}

const GROUPS: [(&str, &str); 1] = [("terrain", "Terrain")];
const REQUIREMENTS: [(&str, &str); 2] = [
    ("projected-metre-grid", "ProjectedMetreGrid"),
    ("metre-values", "MetreValues"),
];
const PARAM_UNITS: [(&str, &str); 3] = [
    ("metre", "Metre"),
    ("square-metre", "SquareMetre"),
    ("degree", "Degree"),
];
/// First id segments reserved for frontend-owned keys under `analyses.*`.
const RESERVED_NAMESPACES: [&str; 3] = ["groups", "unavailable", "stale"];

pub(crate) fn render_analysis_registry(
    path: &Path,
) -> Result<(String, String), Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let schema = parse_registry(&content)?;
    Ok((render_typescript(&schema)?, render_rust(&schema)?))
}

fn parse_registry(content: &str) -> Result<RegistrySchema, Box<dyn std::error::Error>> {
    let schema: RegistrySchema = serde_json::from_str(content)?;
    validate(&schema)?;
    Ok(schema)
}

fn validate(schema: &RegistrySchema) -> Result<(), Box<dyn std::error::Error>> {
    if schema.version != 1 {
        return Err(format!("unsupported analysis registry version {}", schema.version).into());
    }
    let mut ids = HashSet::new();
    for analysis in &schema.analyses {
        let id = analysis.id.as_str();
        if !is_analysis_id(id) {
            return Err(format!("analysis id '{id}' must be dotted lowercase segments").into());
        }
        if RESERVED_NAMESPACES.contains(&id.split('.').next().unwrap_or_default()) {
            return Err(format!("analysis id '{id}' uses a reserved namespace").into());
        }
        if !ids.insert(id) {
            return Err(format!("duplicate analysis '{id}'").into());
        }
        if analysis.version == 0 {
            return Err(format!("{id}: recipe versions start at 1").into());
        }
        lookup(&GROUPS, &analysis.group)
            .ok_or_else(|| format!("{id}: unknown group '{}'", analysis.group))?;
        let LaneSchema::GeolibreWindowed { halo } = analysis.lane;
        if halo == 0 || halo > 8 {
            return Err(format!("{id}: a windowed halo must be 1 to 8 cells").into());
        }
        validate_inputs(id, &analysis.inputs)?;
        validate_params(id, &analysis.params)?;
        validate_outputs(id, analysis)?;
    }
    Ok(())
}

fn validate_inputs(id: &str, inputs: &[InputSchema]) -> Result<(), Box<dyn std::error::Error>> {
    if inputs.is_empty() {
        return Err(format!("{id}: an analysis needs at least one input").into());
    }
    let mut keys = HashSet::new();
    for input in inputs {
        if !is_key(&input.key) || !keys.insert(input.key.as_str()) {
            return Err(format!("{id}: invalid or duplicate input '{}'", input.key).into());
        }
        if input.accepts.is_empty() {
            return Err(format!("{id}: input '{}' accepts nothing", input.key).into());
        }
        for accepted in &input.accepts {
            quantity(id, accepted)?;
        }
        let mut requires = HashSet::new();
        for requirement in &input.requires {
            lookup(&REQUIREMENTS, requirement)
                .ok_or_else(|| format!("{id}: unknown requirement '{requirement}'"))?;
            if !requires.insert(requirement.as_str()) {
                return Err(format!("{id}: duplicate requirement '{requirement}'").into());
            }
        }
    }
    Ok(())
}

fn validate_params(id: &str, params: &[ParamSchema]) -> Result<(), Box<dyn std::error::Error>> {
    let mut keys = HashSet::new();
    for param in params {
        let key = param.key.as_str();
        if !is_key(key) || !keys.insert(key) {
            return Err(format!("{id}: invalid or duplicate parameter '{key}'").into());
        }
        match &param.kind {
            ParamKindSchema::Choice { options } => {
                let mut seen = HashSet::new();
                if options.is_empty()
                    || options
                        .iter()
                        .any(|option| !is_option(option) || !seen.insert(option.as_str()))
                {
                    return Err(format!("{id}: '{key}' needs distinct lowercase options").into());
                }
            }
            ParamKindSchema::Number {
                min,
                max,
                step,
                unit,
            } => {
                if !(min.is_finite() && max.is_finite() && step.is_finite())
                    || min >= max
                    || *step <= 0.0
                {
                    return Err(format!("{id}: '{key}' needs finite min < max and step > 0").into());
                }
                lookup(&PARAM_UNITS, unit)
                    .ok_or_else(|| format!("{id}: '{key}' has unknown unit '{unit}'"))?;
            }
            ParamKindSchema::Integer { min, max } => {
                if min >= max {
                    return Err(format!("{id}: '{key}' needs min < max").into());
                }
            }
            ParamKindSchema::Boolean => {}
        }
        default_literal(id, param)?;
    }
    for param in params {
        if let Some(when) = &param.visible_when {
            let target = params
                .iter()
                .find(|candidate| candidate.key == when.param && candidate.key != param.key)
                .ok_or_else(|| {
                    format!(
                        "{id}: '{}' is visible when '{}', which is not another parameter",
                        param.key, when.param
                    )
                })?;
            match &target.kind {
                ParamKindSchema::Choice { options } if options.contains(&when.equals) => {}
                _ => {
                    return Err(format!(
                        "{id}: '{}' is visible when '{}' is '{}', which is not one of its choices",
                        param.key, when.param, when.equals
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}

fn validate_outputs(id: &str, analysis: &AnalysisSchema) -> Result<(), Box<dyn std::error::Error>> {
    if analysis.outputs.is_empty() {
        return Err(format!("{id}: an analysis needs at least one output").into());
    }
    let mut keys = HashSet::new();
    for output in &analysis.outputs {
        let key = output.key.as_str();
        if !is_key(key) || !keys.insert(key) {
            return Err(format!("{id}: invalid or duplicate output '{key}'").into());
        }
        if quantity(id, &output.item)?.is_importable() {
            return Err(format!("{id}: output '{key}' must be a derived quantity").into());
        }
        if !output.optional && !output.default_selected {
            return Err(format!("{id}: required output '{key}' must be selected").into());
        }
        match &output.units {
            UnitsSchema::Fixed { .. } => {}
            UnitsSchema::ByParam { param, map } => {
                let options = analysis
                    .params
                    .iter()
                    .find(|candidate| &candidate.key == param)
                    .and_then(|candidate| match &candidate.kind {
                        ParamKindSchema::Choice { options } => Some(options),
                        _ => None,
                    })
                    .ok_or_else(|| {
                        format!("{id}: output '{key}' takes units from '{param}', not a choice")
                    })?;
                let mapped: Vec<&String> = map.keys().collect();
                let mut expected: Vec<&String> = options.iter().collect();
                expected.sort();
                if mapped != expected {
                    return Err(format!(
                        "{id}: output '{key}' must name a unit for every option of '{param}'"
                    )
                    .into());
                }
            }
        }
    }
    Ok(())
}

fn quantity(id: &str, item: &ItemTypeSchema) -> Result<RasterQuantity, String> {
    let ItemTypeSchema::Raster { quantity } = item;
    RasterQuantity::from_key(quantity).ok_or_else(|| format!("{id}: unknown quantity '{quantity}'"))
}

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, name)| *name)
}

fn is_analysis_id(id: &str) -> bool {
    let segments: Vec<&str> = id.split('.').collect();
    segments.len() >= 2 && segments.iter().all(|segment| is_option(segment))
}

/// A lowercase kebab-case word, used by ids and choice options.
fn is_option(value: &str) -> bool {
    value.starts_with(|c: char| c.is_ascii_lowercase())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.ends_with('-')
}

/// A lowercase snake_case key, used by inputs, parameters and outputs.
fn is_key(value: &str) -> bool {
    value.starts_with(|c: char| c.is_ascii_lowercase())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The default as `(rust, typescript)` literals; `null` means required.
fn default_literal(id: &str, param: &ParamSchema) -> Result<(String, String), String> {
    let key = &param.key;
    let invalid = || format!("{id}: the default of '{key}' does not fit its type");
    if param.default.is_null() {
        return Ok(("r::ParamDefault::Required".to_string(), "null".to_string()));
    }
    match &param.kind {
        ParamKindSchema::Choice { options } => {
            let value = param.default.as_str().ok_or_else(invalid)?;
            if !options.iter().any(|option| option == value) {
                return Err(invalid());
            }
            Ok((
                format!("r::ParamDefault::Choice({value:?})"),
                ts_string(value),
            ))
        }
        ParamKindSchema::Number { min, max, step, .. } => {
            let value = param.default.as_f64().ok_or_else(invalid)?;
            let steps = (value - min) / step;
            if value < *min || value > *max || (steps - steps.round()).abs() > 1e-9 {
                return Err(invalid());
            }
            Ok((format!("r::ParamDefault::Number({value:?})"), number(value)))
        }
        ParamKindSchema::Integer { min, max } => {
            let value = param
                .default
                .as_i64()
                .and_then(|value| i32::try_from(value).ok())
                .ok_or_else(invalid)?;
            if value < *min || value > *max {
                return Err(invalid());
            }
            Ok((
                format!("r::ParamDefault::Integer({value})"),
                value.to_string(),
            ))
        }
        ParamKindSchema::Boolean => {
            let value = param.default.as_bool().ok_or_else(invalid)?;
            Ok((
                format!("r::ParamDefault::Boolean({value})"),
                value.to_string(),
            ))
        }
    }
}

fn i18n_prefix(id: &str) -> String {
    format!("analyses.{id}")
}

/// Every i18n key the registry names, in a stable order.
fn i18n_keys(schema: &RegistrySchema) -> Vec<String> {
    let mut keys = Vec::new();
    let mut groups: Vec<&str> = schema
        .analyses
        .iter()
        .map(|analysis| analysis.group.as_str())
        .collect();
    groups.sort_unstable();
    groups.dedup();
    for group in groups {
        keys.push(format!("analyses.groups.{group}"));
    }
    for analysis in &schema.analyses {
        let prefix = i18n_prefix(&analysis.id);
        keys.push(format!("{prefix}.title"));
        keys.push(format!("{prefix}.summary"));
        for param in &analysis.params {
            keys.push(format!("{prefix}.params.{}.label", param.key));
            keys.push(format!("{prefix}.params.{}.help", param.key));
            if let ParamKindSchema::Choice { options } = &param.kind {
                for option in options {
                    keys.push(format!("{prefix}.params.{}.options.{option}", param.key));
                }
            }
        }
        for output in &analysis.outputs {
            keys.push(format!("{prefix}.outputs.{}", output.key));
        }
    }
    keys
}

#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn render_typescript(schema: &RegistrySchema) -> Result<String, Box<dyn std::error::Error>> {
    let mut file = String::new();
    file.push_str("// Generated by `cargo run -p bindings-gen`. Do not edit by hand.\n");
    file.push_str("// Source: common-types/analysis-registry.json\n\n");
    file.push_str("import type { LibraryItemType } from './contracts'\n\n");
    let groups: Vec<String> = GROUPS.iter().map(|(key, _)| ts_string(key)).collect();
    writeln!(file, "export type AnalysisGroup = {}", groups.join(" | "))?;
    file.push_str(
        "export type AnalysisLane = { readonly kind: 'geolibre-windowed'; readonly halo: number }\n",
    );
    let requirements: Vec<String> = REQUIREMENTS.iter().map(|(key, _)| ts_string(key)).collect();
    writeln!(
        file,
        "export type GridRequirement = {}",
        requirements.join(" | ")
    )?;
    let units: Vec<String> = PARAM_UNITS.iter().map(|(key, _)| ts_string(key)).collect();
    writeln!(file, "export type ParamUnit = {}", units.join(" | "))?;
    file.push_str(
        "export type AnalysisParamKind =
  | { readonly type: 'choice'; readonly options: readonly string[] }
  | { readonly type: 'number'; readonly min: number; readonly max: number; readonly step: number; readonly unit: ParamUnit }
  | { readonly type: 'integer'; readonly min: number; readonly max: number }
  | { readonly type: 'boolean' }

export interface AnalysisParamSpec {
  readonly key: string
  readonly labelKey: string
  readonly helpKey: string
  readonly kind: AnalysisParamKind
  /** `null` when the user must choose. */
  readonly default: string | number | boolean | null
  /** Shown in a disclosure. */
  readonly advanced: boolean
  readonly visibleWhen: { readonly param: string; readonly equals: string } | null
  /** One label key per choice option; empty for other kinds. */
  readonly optionLabelKeys: Readonly<Record<string, string>>
}

export interface AnalysisInputSpec {
  readonly key: string
  readonly accepts: readonly LibraryItemType[]
  readonly requires: readonly GridRequirement[]
}

export type AnalysisOutputUnits =
  | { readonly kind: 'fixed'; readonly value: string }
  | { readonly kind: 'by-param'; readonly param: string; readonly map: Readonly<Record<string, string>> }

export interface AnalysisOutputSpec {
  readonly key: string
  readonly labelKey: string
  readonly item: LibraryItemType
  readonly units: AnalysisOutputUnits
  readonly optional: boolean
  readonly defaultSelected: boolean
  /** `false` for outputs kept only for provenance or other analyses. */
  readonly presentable: boolean
}

export interface AnalysisEntry {
  readonly id: string
  /** Recipe version; bumped when the method changes. */
  readonly version: number
  readonly group: AnalysisGroup
  readonly titleKey: string
  readonly summaryKey: string
  readonly lane: AnalysisLane
  readonly inputs: readonly AnalysisInputSpec[]
  readonly params: readonly AnalysisParamSpec[]
  readonly outputs: readonly AnalysisOutputSpec[]
}

",
    );
    file.push_str(
        "export const ANALYSIS_GROUPS: readonly { readonly key: AnalysisGroup; readonly labelKey: string }[] = [\n",
    );
    for (key, _) in GROUPS {
        writeln!(
            file,
            "  {{ key: {}, labelKey: {} }},",
            ts_string(key),
            ts_string(&format!("analyses.groups.{key}"))
        )?;
    }
    file.push_str("]\n\n");
    file.push_str("export const ANALYSIS_REGISTRY: readonly AnalysisEntry[] = [\n");
    for analysis in &schema.analyses {
        let prefix = i18n_prefix(&analysis.id);
        file.push_str("  {\n");
        writeln!(file, "    id: {},", ts_string(&analysis.id))?;
        writeln!(file, "    version: {},", analysis.version)?;
        writeln!(file, "    group: {},", ts_string(&analysis.group))?;
        writeln!(
            file,
            "    titleKey: {},",
            ts_string(&format!("{prefix}.title"))
        )?;
        writeln!(
            file,
            "    summaryKey: {},",
            ts_string(&format!("{prefix}.summary"))
        )?;
        let LaneSchema::GeolibreWindowed { halo } = analysis.lane;
        writeln!(
            file,
            "    lane: {{ kind: 'geolibre-windowed', halo: {halo} }},"
        )?;
        file.push_str("    inputs: [\n");
        for input in &analysis.inputs {
            let accepts: Vec<String> = input
                .accepts
                .iter()
                .map(|item| ts_item(&analysis.id, item))
                .collect::<Result<_, _>>()?;
            let requires: Vec<String> = input.requires.iter().map(|r| ts_string(r)).collect();
            writeln!(
                file,
                "      {{ key: {}, accepts: [{}], requires: [{}] }},",
                ts_string(&input.key),
                accepts.join(", "),
                requires.join(", ")
            )?;
        }
        file.push_str("    ],\n    params: [\n");
        for param in &analysis.params {
            let (_, default) = default_literal(&analysis.id, param)?;
            let param_prefix = format!("{prefix}.params.{}", param.key);
            let (kind, option_keys) = match &param.kind {
                ParamKindSchema::Choice { options } => (
                    format!(
                        "{{ type: 'choice', options: [{}] }}",
                        options
                            .iter()
                            .map(|option| ts_string(option))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                    options
                        .iter()
                        .map(|option| {
                            format!(
                                "{}: {}",
                                ts_string(option),
                                ts_string(&format!("{param_prefix}.options.{option}"))
                            )
                        })
                        .collect::<Vec<_>>(),
                ),
                ParamKindSchema::Number {
                    min,
                    max,
                    step,
                    unit,
                } => (
                    format!(
                        "{{ type: 'number', min: {}, max: {}, step: {}, unit: {} }}",
                        number(*min),
                        number(*max),
                        number(*step),
                        ts_string(unit)
                    ),
                    Vec::new(),
                ),
                ParamKindSchema::Integer { min, max } => (
                    format!("{{ type: 'integer', min: {min}, max: {max} }}"),
                    Vec::new(),
                ),
                ParamKindSchema::Boolean => ("{ type: 'boolean' }".to_string(), Vec::new()),
            };
            let visible_when = match &param.visible_when {
                Some(when) => format!(
                    "{{ param: {}, equals: {} }}",
                    ts_string(&when.param),
                    ts_string(&when.equals)
                ),
                None => "null".to_string(),
            };
            file.push_str("      {\n");
            writeln!(file, "        key: {},", ts_string(&param.key))?;
            writeln!(
                file,
                "        labelKey: {},",
                ts_string(&format!("{param_prefix}.label"))
            )?;
            writeln!(
                file,
                "        helpKey: {},",
                ts_string(&format!("{param_prefix}.help"))
            )?;
            writeln!(file, "        kind: {kind},")?;
            writeln!(file, "        default: {default},")?;
            writeln!(file, "        advanced: {},", param.advanced)?;
            writeln!(file, "        visibleWhen: {visible_when},")?;
            writeln!(
                file,
                "        optionLabelKeys: {{ {} }},",
                option_keys.join(", ")
            )?;
            file.push_str("      },\n");
        }
        file.push_str("    ],\n    outputs: [\n");
        for output in &analysis.outputs {
            let units = match &output.units {
                UnitsSchema::Fixed { value } => {
                    format!("{{ kind: 'fixed', value: {} }}", ts_string(value))
                }
                UnitsSchema::ByParam { param, map } => format!(
                    "{{ kind: 'by-param', param: {}, map: {{ {} }} }}",
                    ts_string(param),
                    map.iter()
                        .map(|(option, unit)| format!("{}: {}", ts_string(option), ts_string(unit)))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            };
            file.push_str("      {\n");
            writeln!(file, "        key: {},", ts_string(&output.key))?;
            writeln!(
                file,
                "        labelKey: {},",
                ts_string(&format!("{prefix}.outputs.{}", output.key))
            )?;
            writeln!(
                file,
                "        item: {},",
                ts_item(&analysis.id, &output.item)?
            )?;
            writeln!(file, "        units: {units},")?;
            writeln!(file, "        optional: {},", output.optional)?;
            writeln!(
                file,
                "        defaultSelected: {},",
                output.default_selected
            )?;
            writeln!(file, "        presentable: {},", output.presentable)?;
            file.push_str("      },\n");
        }
        file.push_str("    ],\n  },\n");
    }
    file.push_str("]\n\n");
    file.push_str(
        "/** Every i18n key the registry names; each locale must define all of them. */\n",
    );
    file.push_str("export const ANALYSIS_I18N_KEYS: readonly string[] = [\n");
    for key in i18n_keys(schema) {
        writeln!(file, "  {},", ts_string(&key))?;
    }
    file.push_str("]\n");
    Ok(file)
}

#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
fn render_rust(schema: &RegistrySchema) -> Result<String, Box<dyn std::error::Error>> {
    let mut file = String::new();
    file.push_str("// Generated by `cargo run -p bindings-gen`. Do not edit by hand.\n");
    file.push_str("// Source: common-types/analysis-registry.json\n\n");
    file.push_str("use common_types::analysis_registry as r;\n");
    file.push_str("use common_types::library::{LibraryItemType, RasterQuantity};\n\n");
    file.push_str("/// Every registered analysis, in registry order.\n");
    file.push_str("pub(crate) static ANALYSIS_REGISTRY: &[r::AnalysisDefinition] = &[\n");
    for analysis in &schema.analyses {
        let group = lookup(&GROUPS, &analysis.group).ok_or("unknown group")?;
        let LaneSchema::GeolibreWindowed { halo } = analysis.lane;
        file.push_str("r::AnalysisDefinition {\n");
        writeln!(file, "id: {:?},", analysis.id)?;
        writeln!(file, "version: {},", analysis.version)?;
        writeln!(file, "group: r::AnalysisGroup::{group},")?;
        writeln!(
            file,
            "lane: r::AnalysisLane::GeolibreWindowed {{ halo: {halo} }},"
        )?;
        file.push_str("inputs: &[\n");
        for input in &analysis.inputs {
            let accepts: Vec<String> = input
                .accepts
                .iter()
                .map(|item| rust_item(&analysis.id, item))
                .collect::<Result<_, _>>()?;
            let requires: Vec<String> = input
                .requires
                .iter()
                .map(|requirement| {
                    lookup(&REQUIREMENTS, requirement)
                        .map(|name| format!("r::GridRequirement::{name}"))
                        .ok_or("unknown requirement")
                })
                .collect::<Result<_, _>>()?;
            writeln!(
                file,
                "r::AnalysisInputSpec {{ key: {:?}, accepts: &[{}], requires: &[{}] }},",
                input.key,
                accepts.join(", "),
                requires.join(", ")
            )?;
        }
        file.push_str("],\nparams: &[\n");
        for param in &analysis.params {
            let (default, _) = default_literal(&analysis.id, param)?;
            let kind = match &param.kind {
                ParamKindSchema::Choice { options } => format!(
                    "r::AnalysisParamKind::Choice {{ options: &[{}] }}",
                    options
                        .iter()
                        .map(|option| format!("{option:?}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                ParamKindSchema::Number {
                    min,
                    max,
                    step,
                    unit,
                } => format!(
                    "r::AnalysisParamKind::Number {{ min: {min:?}, max: {max:?}, step: {step:?}, unit: r::ParamUnit::{} }}",
                    lookup(&PARAM_UNITS, unit).ok_or("unknown unit")?
                ),
                ParamKindSchema::Integer { min, max } => {
                    format!("r::AnalysisParamKind::Integer {{ min: {min}, max: {max} }}")
                }
                ParamKindSchema::Boolean => "r::AnalysisParamKind::Boolean".to_string(),
            };
            let visible_when = match &param.visible_when {
                Some(when) => format!("Some(({:?}, {:?}))", when.param, when.equals),
                None => "None".to_string(),
            };
            writeln!(
                file,
                "r::AnalysisParamSpec {{ key: {:?}, kind: {kind}, default: {default}, advanced: {}, visible_when: {visible_when} }},",
                param.key, param.advanced
            )?;
        }
        file.push_str("],\noutputs: &[\n");
        for output in &analysis.outputs {
            let units = match &output.units {
                UnitsSchema::Fixed { value } => format!("r::OutputUnits::Fixed({value:?})"),
                UnitsSchema::ByParam { param, map } => format!(
                    "r::OutputUnits::ByParam {{ param: {param:?}, map: &[{}] }}",
                    map.iter()
                        .map(|(option, unit)| format!("({option:?}, {unit:?})"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            };
            writeln!(
                file,
                "r::AnalysisOutputSpec {{ key: {:?}, item: {}, units: {units}, optional: {}, default_selected: {}, presentable: {} }},",
                output.key,
                rust_item(&analysis.id, &output.item)?,
                output.optional,
                output.default_selected,
                output.presentable
            )?;
        }
        file.push_str("],\n},\n");
    }
    file.push_str("];\n");
    Ok(file)
}

fn rust_item(id: &str, item: &ItemTypeSchema) -> Result<String, String> {
    let quantity = quantity(id, item)?;
    Ok(format!(
        "LibraryItemType::Raster {{ quantity: RasterQuantity::{} }}",
        quantity.variant_name()
    ))
}

fn ts_item(id: &str, item: &ItemTypeSchema) -> Result<String, String> {
    let quantity = quantity(id, item)?;
    Ok(format!(
        "{{ kind: 'Raster', quantity: {} }}",
        ts_string(quantity.variant_name())
    ))
}

fn number(value: f64) -> String {
    // JSON number text is valid TypeScript and keeps integers unadorned.
    serde_json::Number::from_f64(value)
        .map(|number| number.to_string())
        .unwrap_or_else(|| "NaN".to_string())
}

fn ts_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("{value:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLOPE: &str = r#"{
      "id": "terrain.slope", "version": 1, "group": "terrain",
      "lane": { "kind": "geolibre_windowed", "halo": 2 },
      "inputs": [{ "key": "dem", "accepts": [{ "kind": "raster", "quantity": "ground-elevation" }], "requires": ["projected-metre-grid"] }],
      "params": [
        { "key": "unit", "kind": { "type": "choice", "options": ["degrees", "percent"] }, "default": null, "advanced": false, "visible_when": null },
        { "key": "reach", "kind": { "type": "number", "min": 1, "max": 50, "step": 1, "unit": "metre" }, "default": 5, "advanced": true, "visible_when": { "param": "unit", "equals": "degrees" } }
      ],
      "outputs": [{ "key": "slope", "item": { "kind": "raster", "quantity": "slope" },
        "units": { "kind": "by_param", "param": "unit", "map": { "degrees": "°", "percent": "%" } },
        "optional": false, "default_selected": true, "presentable": true }]
    }"#;

    fn registry(analysis: &str) -> String {
        format!(r#"{{ "version": 1, "analyses": [{analysis}] }}"#)
    }

    fn refused(analysis: &str, needle: &str) {
        let error = parse_registry(&registry(analysis))
            .map(|_| ())
            .expect_err("the registry must be refused")
            .to_string();
        assert!(error.contains(needle), "{error} should mention {needle}");
    }

    #[test]
    fn a_valid_registry_renders_both_adapters() {
        let schema = parse_registry(&registry(SLOPE)).unwrap();
        let ts = render_typescript(&schema).unwrap();
        assert!(ts.contains("accepts: [{ kind: 'Raster', quantity: \"GroundElevation\" }]"));
        assert!(ts.contains("\"analyses.terrain.slope.params.unit.options.percent\""));
        assert!(ts.contains("visibleWhen: { param: \"unit\", equals: \"degrees\" }"));
        let rust = render_rust(&schema).unwrap();
        assert!(rust.contains("r::ParamDefault::Required"));
        assert!(rust.contains("r::ParamDefault::Number(5.0)"));
        assert!(rust.contains("RasterQuantity::Slope"));
        assert_eq!(
            i18n_keys(&schema),
            [
                "analyses.groups.terrain",
                "analyses.terrain.slope.title",
                "analyses.terrain.slope.summary",
                "analyses.terrain.slope.params.unit.label",
                "analyses.terrain.slope.params.unit.help",
                "analyses.terrain.slope.params.unit.options.degrees",
                "analyses.terrain.slope.params.unit.options.percent",
                "analyses.terrain.slope.params.reach.label",
                "analyses.terrain.slope.params.reach.help",
                "analyses.terrain.slope.outputs.slope",
            ]
        );
    }

    #[test]
    fn the_shipped_registry_is_valid() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("common-types/analysis-registry.json");
        render_analysis_registry(&path).expect("the shipped registry renders");
    }

    #[test]
    fn inconsistent_registries_are_refused_by_name() {
        refused(&SLOPE.replace("terrain.slope", "Slope"), "dotted lowercase");
        refused(
            &SLOPE.replace("terrain.slope", "groups.slope"),
            "reserved namespace",
        );
        refused(&format!("{SLOPE}, {SLOPE}"), "duplicate analysis");
        refused(
            &SLOPE.replace("\"version\": 1", "\"version\": 0"),
            "start at 1",
        );
        refused(
            &SLOPE.replace("\"group\": \"terrain\"", "\"group\": \"moon\""),
            "unknown group",
        );
        refused(
            &SLOPE.replace("ground-elevation", "lava"),
            "unknown quantity",
        );
        refused(
            &SLOPE.replace("\"projected-metre-grid\"", "\"flat\""),
            "unknown requirement",
        );
        refused(
            &SLOPE.replace("\"default\": 5", "\"default\": 99"),
            "default of 'reach'",
        );
        refused(
            &SLOPE.replace("\"default\": 5", "\"default\": 5.5"),
            "default of 'reach'",
        );
        refused(
            &SLOPE.replace("\"equals\": \"degrees\"", "\"equals\": \"radians\""),
            "not one of its choices",
        );
        refused(
            &SLOPE.replace("{ \"param\": \"unit\"", "{ \"param\": \"reach\""),
            "not another parameter",
        );
        refused(&SLOPE.replace(", \"percent\": \"%\"", ""), "every option");
        refused(
            &SLOPE.replace(
                "\"quantity\": \"slope\"",
                "\"quantity\": \"ground-elevation\"",
            ),
            "derived quantity",
        );
        refused(
            &SLOPE.replace("\"default_selected\": true", "\"default_selected\": false"),
            "must be selected",
        );
        refused(&SLOPE.replace("\"halo\": 2", "\"halo\": 0"), "halo");
        refused(
            &SLOPE.replace("\"unit\": \"metre\"", "\"unit\": \"furlong\""),
            "unknown unit",
        );
    }
}
