use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct PlantFilterSchema {
    version: u32,
    categories: Vec<PlantFilterCategorySchema>,
    orderings: BTreeMap<String, Vec<String>>,
    fixed_filters: Vec<FixedFilterSchema>,
    fields: Vec<PlantFilterFieldSchema>,
}

#[derive(Debug, Deserialize)]
struct PlantFilterCategorySchema {
    key: String,
    i18n_key: String,
    color_token: String,
}

#[derive(Debug, Deserialize)]
struct PlantFilterFieldSchema {
    key: String,
    kind: PlantFilterFieldKind,
    category: String,
    i18n_key: String,
    ui_placement: PlantFilterUiPlacement,
    sql_column: Option<String>,
    step: Option<f64>,
    ordering: Option<String>,
    strip_choice: Option<FieldStripChoiceSchema>,
    active_array_chip: Option<FieldActiveArrayChipSchema>,
}

#[derive(Debug, Deserialize)]
struct FieldStripChoiceSchema {
    options_key: String,
    value_i18n_prefix: String,
}

#[derive(Debug, Deserialize)]
struct FieldActiveArrayChipSchema {
    key_prefix: String,
    value_i18n_prefix: String,
}

#[derive(Debug, Deserialize)]
struct FixedFilterSchema {
    key: String,
    kind: FixedFilterActivityKind,
    countable: bool,
    strip_choice: Option<FixedStripChoiceSchema>,
    strip_threshold: Option<FixedStripThresholdSchema>,
    strip_boolean: Option<FixedStripBooleanSchema>,
    active_array_chip: Option<FixedActiveArrayChipSchema>,
    active_boolean_chip: Option<FixedActiveBooleanChipSchema>,
    active_numeric_chip: Option<FixedActiveNumericChipSchema>,
    predicate: FixedFilterPredicateSchema,
}

#[derive(Debug, Deserialize)]
struct FixedStripChoiceSchema {
    label_i18n_key: String,
    fallback_label: String,
    options_key: String,
    value_i18n_prefix: String,
    color_token: String,
}

#[derive(Debug, Deserialize)]
struct FixedStripThresholdSchema {
    label_i18n_key: String,
    fallback_label: String,
    min: f64,
    max: f64,
    color_token: String,
}

#[derive(Debug, Deserialize)]
struct FixedStripBooleanSchema {
    label_i18n_key: String,
    fallback_label: String,
    color_token: String,
}

#[derive(Debug, Deserialize)]
struct FixedActiveArrayChipSchema {
    key_prefix: String,
    value_i18n_prefix: String,
    color_token: String,
}

#[derive(Debug, Deserialize)]
struct FixedActiveBooleanChipSchema {
    label_i18n_key: String,
    fallback_label: String,
    color_token: String,
}

#[derive(Debug, Deserialize)]
struct FixedActiveNumericChipSchema {
    label_i18n_key: String,
    fallback_label: String,
    color_token: String,
    suffix: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FixedFilterPredicateSchema {
    MappedBooleanList {
        clauses: Vec<FixedFilterPredicateClauseSchema>,
    },
    TextInColumn {
        column: String,
    },
    TextEqualsColumn {
        column: String,
    },
    BooleanTrueClause {
        clause: String,
    },
    NumericGteColumn {
        column: String,
    },
    ClimateZoneJoin,
    SchemaTextIn {
        field_key: String,
    },
    SchemaBooleanTrue {
        field_key: String,
    },
}

#[derive(Debug, Deserialize)]
struct FixedFilterPredicateClauseSchema {
    value: String,
    clause: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PlantFilterFieldKind {
    Boolean,
    Categorical,
    Numeric,
}

impl PlantFilterFieldKind {
    fn ts_value(self) -> &'static str {
        match self {
            Self::Boolean => "boolean",
            Self::Categorical => "categorical",
            Self::Numeric => "numeric",
        }
    }

    fn rust_variant(self) -> &'static str {
        match self {
            Self::Boolean => "PlantFilterFieldKind::Boolean",
            Self::Categorical => "PlantFilterFieldKind::Categorical",
            Self::Numeric => "PlantFilterFieldKind::Numeric",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FixedFilterActivityKind {
    Array,
    Boolean,
    Numeric,
    String,
}

impl FixedFilterActivityKind {
    fn ts_value(self) -> &'static str {
        match self {
            Self::Array => "array",
            Self::Boolean => "boolean",
            Self::Numeric => "numeric",
            Self::String => "string",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PlantFilterUiPlacement {
    Dynamic,
    Hidden,
    Strip,
}

impl PlantFilterUiPlacement {
    fn ts_value(self) -> &'static str {
        match self {
            Self::Dynamic => "dynamic",
            Self::Hidden => "hidden",
            Self::Strip => "strip",
        }
    }
}

pub(crate) fn render_plant_filter_adapters(
    schema_path: &Path,
) -> Result<(String, String), Box<dyn std::error::Error>> {
    let schema = load_plant_filter_schema(schema_path)?;
    Ok((
        render_plant_filter_ts(&schema)?,
        render_plant_filter_rust(&schema)?,
    ))
}

fn load_plant_filter_schema(path: &Path) -> Result<PlantFilterSchema, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let schema: PlantFilterSchema = serde_json::from_str(&content)?;
    validate_plant_filter_schema(&schema)?;
    Ok(schema)
}

fn validate_plant_filter_schema(
    schema: &PlantFilterSchema,
) -> Result<(), Box<dyn std::error::Error>> {
    if schema.version != 2 {
        return Err(format!("unsupported plant filter schema version {}", schema.version).into());
    }

    let mut category_keys = HashSet::new();
    for category in &schema.categories {
        if !category_keys.insert(category.key.as_str()) {
            return Err(format!("duplicate plant filter category '{}'", category.key).into());
        }
        if !category.color_token.starts_with("--") {
            return Err(format!(
                "plant filter category '{}' has invalid color token '{}'",
                category.key, category.color_token
            )
            .into());
        }
    }

    let mut field_keys = HashSet::new();
    let mut field_kinds = HashMap::new();
    let mut sql_columns = HashSet::new();
    for field in &schema.fields {
        if !field_keys.insert(field.key.as_str()) {
            return Err(format!("duplicate plant filter field '{}'", field.key).into());
        }
        field_kinds.insert(field.key.as_str(), field.kind);
        if !category_keys.contains(field.category.as_str()) {
            return Err(format!(
                "plant filter field '{}' references unknown category '{}'",
                field.key, field.category
            )
            .into());
        }
        if let Some(ordering) = &field.ordering
            && !schema.orderings.contains_key(ordering)
        {
            return Err(format!(
                "plant filter field '{}' references unknown ordering '{}'",
                field.key, ordering
            )
            .into());
        }
        if let PlantFilterUiPlacement::Dynamic = field.ui_placement
            && field.sql_column.is_none()
        {
            return Err(format!(
                "dynamic plant filter field '{}' must declare a SQL column",
                field.key
            )
            .into());
        }
        if let Some(column) = &field.sql_column {
            validate_species_column(&format!("plant filter field '{}'", field.key), column)?;
            if !sql_columns.insert(column.as_str()) {
                return Err(format!("duplicate plant filter SQL column '{}'", column).into());
            }
        }
        validate_field_ui_behavior(field)?;
    }

    let mut fixed_filter_keys = HashSet::new();
    for filter in &schema.fixed_filters {
        if !fixed_filter_keys.insert(filter.key.as_str()) {
            return Err(format!("duplicate fixed species filter '{}'", filter.key).into());
        }
        if !is_sql_identifier(&filter.key) {
            return Err(format!(
                "fixed species filter '{}' is not a valid generated request field",
                filter.key
            )
            .into());
        }
        validate_fixed_filter_color(
            filter,
            filter.strip_choice.as_ref().map(|value| &value.color_token),
        )?;
        validate_fixed_filter_color(
            filter,
            filter
                .strip_threshold
                .as_ref()
                .map(|value| &value.color_token),
        )?;
        validate_fixed_filter_color(
            filter,
            filter
                .strip_boolean
                .as_ref()
                .map(|value| &value.color_token),
        )?;
        validate_fixed_filter_color(
            filter,
            filter
                .active_array_chip
                .as_ref()
                .map(|value| &value.color_token),
        )?;
        validate_fixed_filter_color(
            filter,
            filter
                .active_boolean_chip
                .as_ref()
                .map(|value| &value.color_token),
        )?;
        validate_fixed_filter_color(
            filter,
            filter
                .active_numeric_chip
                .as_ref()
                .map(|value| &value.color_token),
        )?;
        validate_fixed_filter_ui_behavior(filter)?;

        match &filter.predicate {
            FixedFilterPredicateSchema::MappedBooleanList { clauses } => {
                validate_fixed_filter_kind(
                    filter,
                    FixedFilterActivityKind::Array,
                    "mapped_boolean_list",
                )?;
                if clauses.is_empty() {
                    return Err(format!(
                        "fixed species filter '{}' has an empty mapped boolean predicate",
                        filter.key
                    )
                    .into());
                }
                for clause in clauses {
                    validate_sql_clause(
                        &format!("fixed species filter '{}'", filter.key),
                        &clause.clause,
                    )?;
                }
            }
            FixedFilterPredicateSchema::TextInColumn { column } => {
                validate_fixed_filter_kind(
                    filter,
                    FixedFilterActivityKind::Array,
                    "text_in_column",
                )?;
                validate_species_column(&format!("fixed species filter '{}'", filter.key), column)?;
            }
            FixedFilterPredicateSchema::TextEqualsColumn { column } => {
                validate_fixed_filter_kind(
                    filter,
                    FixedFilterActivityKind::String,
                    "text_equals_column",
                )?;
                validate_species_column(&format!("fixed species filter '{}'", filter.key), column)?;
            }
            FixedFilterPredicateSchema::NumericGteColumn { column } => {
                validate_fixed_filter_kind(
                    filter,
                    FixedFilterActivityKind::Numeric,
                    "numeric_gte_column",
                )?;
                validate_species_column(&format!("fixed species filter '{}'", filter.key), column)?;
            }
            FixedFilterPredicateSchema::BooleanTrueClause { clause } => {
                validate_fixed_filter_kind(
                    filter,
                    FixedFilterActivityKind::Boolean,
                    "boolean_true_clause",
                )?;
                validate_sql_clause(&format!("fixed species filter '{}'", filter.key), clause)?;
            }
            FixedFilterPredicateSchema::SchemaTextIn { field_key } => {
                validate_fixed_filter_kind(
                    filter,
                    FixedFilterActivityKind::Array,
                    "schema_text_in",
                )?;
                let Some(field_kind) = field_kinds.get(field_key.as_str()) else {
                    return Err(format!(
                        "fixed species filter '{}' references unknown schema field '{}'",
                        filter.key, field_key
                    )
                    .into());
                };
                if *field_kind != PlantFilterFieldKind::Categorical {
                    return Err(format!(
                        "fixed species filter '{}' schema_text_in predicate references non-categorical field '{}'",
                        filter.key, field_key
                    )
                    .into());
                }
            }
            FixedFilterPredicateSchema::SchemaBooleanTrue { field_key } => {
                validate_fixed_filter_kind(
                    filter,
                    FixedFilterActivityKind::Boolean,
                    "schema_boolean_true",
                )?;
                let Some(field_kind) = field_kinds.get(field_key.as_str()) else {
                    return Err(format!(
                        "fixed species filter '{}' references unknown schema field '{}'",
                        filter.key, field_key
                    )
                    .into());
                };
                if *field_kind != PlantFilterFieldKind::Boolean {
                    return Err(format!(
                        "fixed species filter '{}' schema_boolean_true predicate references non-boolean field '{}'",
                        filter.key, field_key
                    )
                    .into());
                }
            }
            FixedFilterPredicateSchema::ClimateZoneJoin => {
                validate_fixed_filter_kind(
                    filter,
                    FixedFilterActivityKind::Array,
                    "climate_zone_join",
                )?;
            }
        }
    }

    Ok(())
}

fn validate_field_ui_behavior(
    field: &PlantFilterFieldSchema,
) -> Result<(), Box<dyn std::error::Error>> {
    if field.strip_choice.is_some() {
        if field.kind != PlantFilterFieldKind::Categorical {
            return Err(format!(
                "plant filter field '{}' declares strip_choice but is not categorical",
                field.key
            )
            .into());
        }
        if field.ui_placement != PlantFilterUiPlacement::Strip {
            return Err(format!(
                "plant filter field '{}' declares strip_choice outside strip placement",
                field.key
            )
            .into());
        }
    }

    if field.active_array_chip.is_some() {
        if field.kind != PlantFilterFieldKind::Categorical {
            return Err(format!(
                "plant filter field '{}' declares active_array_chip but is not categorical",
                field.key
            )
            .into());
        }
        if field.ui_placement != PlantFilterUiPlacement::Strip {
            return Err(format!(
                "plant filter field '{}' declares active_array_chip outside strip placement",
                field.key
            )
            .into());
        }
    }

    Ok(())
}

fn validate_fixed_filter_kind(
    filter: &FixedFilterSchema,
    expected: FixedFilterActivityKind,
    predicate: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if filter.kind == expected {
        return Ok(());
    }

    Err(format!(
        "fixed species filter '{}' uses a {predicate} predicate but declares kind '{}', expected '{}'",
        filter.key,
        filter.kind.ts_value(),
        expected.ts_value(),
    )
    .into())
}

fn validate_fixed_filter_ui_behavior(
    filter: &FixedFilterSchema,
) -> Result<(), Box<dyn std::error::Error>> {
    if filter.strip_choice.is_some() {
        validate_fixed_filter_kind(filter, FixedFilterActivityKind::Array, "strip_choice")?;
    }
    if let Some(threshold) = &filter.strip_threshold {
        validate_fixed_filter_kind(filter, FixedFilterActivityKind::Numeric, "strip_threshold")?;
        if threshold.min > threshold.max {
            return Err(format!(
                "fixed species filter '{}' strip_threshold min exceeds max",
                filter.key
            )
            .into());
        }
    }
    if filter.strip_boolean.is_some() {
        validate_fixed_filter_kind(filter, FixedFilterActivityKind::Boolean, "strip_boolean")?;
    }
    if filter.active_array_chip.is_some() {
        validate_fixed_filter_kind(filter, FixedFilterActivityKind::Array, "active_array_chip")?;
    }
    if filter.active_boolean_chip.is_some() {
        validate_fixed_filter_kind(
            filter,
            FixedFilterActivityKind::Boolean,
            "active_boolean_chip",
        )?;
    }
    if filter.active_numeric_chip.is_some() {
        validate_fixed_filter_kind(
            filter,
            FixedFilterActivityKind::Numeric,
            "active_numeric_chip",
        )?;
    }

    Ok(())
}

fn validate_fixed_filter_color(
    filter: &FixedFilterSchema,
    color: Option<&String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(color) = color else {
        return Ok(());
    };
    if color.starts_with("--") {
        Ok(())
    } else {
        Err(format!(
            "fixed species filter '{}' has invalid color token '{}'",
            filter.key, color
        )
        .into())
    }
}

fn validate_species_column(owner: &str, column: &str) -> Result<(), Box<dyn std::error::Error>> {
    if is_species_column_ref(column) {
        Ok(())
    } else {
        Err(format!("{owner} uses invalid species SQL column '{column}'").into())
    }
}

fn validate_sql_clause(owner: &str, clause: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut parts = clause.split_whitespace();
    let Some(column) = parts.next() else {
        return Err(format!("{owner} has empty SQL clause").into());
    };
    let Some(operator) = parts.next() else {
        return Err(format!("{owner} has incomplete SQL clause '{clause}'").into());
    };
    let Some(literal) = parts.next() else {
        return Err(format!("{owner} has incomplete SQL clause '{clause}'").into());
    };
    if parts.next().is_some() {
        return Err(format!("{owner} uses unsupported SQL clause '{clause}'").into());
    }

    if !is_species_column_ref(column) {
        return Err(format!("{owner} uses invalid species SQL column '{column}'").into());
    }
    if !matches!(operator, "=" | ">" | ">=" | "<" | "<=") {
        return Err(format!("{owner} uses unsupported SQL operator '{operator}'").into());
    }
    if literal.parse::<i64>().is_err() {
        return Err(format!("{owner} uses non-integer SQL literal '{literal}'").into());
    }

    Ok(())
}

fn is_species_column_ref(column: &str) -> bool {
    column.strip_prefix("s.").is_some_and(is_sql_identifier)
}

fn is_sql_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn render_plant_filter_ts(
    schema: &PlantFilterSchema,
) -> Result<String, Box<dyn std::error::Error>> {
    let categories_by_key: HashMap<&str, &PlantFilterCategorySchema> = schema
        .categories
        .iter()
        .map(|category| (category.key.as_str(), category))
        .collect();
    let mut file =
        String::from("// Generated by `cargo run -p bindings-gen`. Do not edit by hand.\n\n");

    file.push_str("export type FilterCategory =\n");
    write_string_union_members(
        &mut file,
        schema.categories.iter().map(|category| &category.key),
    )?;
    file.push('\n');

    file.push_str("export type PlantFilterFieldKind =\n");
    write_string_union_members(&mut file, ["boolean", "categorical", "numeric"].iter())?;
    file.push('\n');

    file.push_str("export type PlantFilterUiPlacement =\n");
    write_string_union_members(&mut file, ["strip", "dynamic", "hidden"].iter())?;
    file.push('\n');

    file.push_str(
        "export interface PlantFilterCategory {\n  key: FilterCategory\n  i18nKey: string\n  colorToken: string\n}\n\n",
    );
    file.push_str(
        "export interface PlantFilterFieldStripChoiceBehavior {\n  optionsKey: string\n  valueI18nPrefix: string\n}\n\n",
    );
    file.push_str(
        "export interface PlantFilterFieldActiveArrayChipBehavior {\n  keyPrefix: string\n  valueI18nPrefix: string\n}\n\n",
    );
    file.push_str(
        "export interface PlantFilterFieldDef {\n  key: string\n  kind: PlantFilterFieldKind\n  category: FilterCategory\n  i18nKey: string\n  uiPlacement: PlantFilterUiPlacement\n  colorToken: string\n  step?: number\n  ordering?: string | null\n  stripChoice?: PlantFilterFieldStripChoiceBehavior\n  activeArrayChip?: PlantFilterFieldActiveArrayChipBehavior\n}\n\n",
    );

    file.push_str("export const FILTER_CATEGORIES = [\n");
    for category in &schema.categories {
        writeln!(
            file,
            "  {{ key: {}, i18nKey: {}, colorToken: {} }},",
            ts_string(&category.key),
            ts_string(&category.i18n_key),
            ts_string(&category.color_token),
        )?;
    }
    file.push_str("] as const satisfies readonly PlantFilterCategory[]\n\n");

    file.push_str("export const PLANT_FILTER_FIELDS = [\n");
    for field in &schema.fields {
        let color_token = &categories_by_key
            .get(field.category.as_str())
            .ok_or("schema validation guarantees category exists")?
            .color_token;
        write!(
            file,
            "  {{ key: {}, kind: {}, category: {}, i18nKey: {}, uiPlacement: {}, colorToken: {}",
            ts_string(&field.key),
            ts_string(field.kind.ts_value()),
            ts_string(&field.category),
            ts_string(&field.i18n_key),
            ts_string(field.ui_placement.ts_value()),
            ts_string(color_token),
        )?;
        if let Some(step) = field.step {
            write!(file, ", step: {}", format_number(step))?;
        }
        if let Some(ordering) = &field.ordering {
            write!(file, ", ordering: {}", ts_string(ordering))?;
        }
        if let Some(choice) = &field.strip_choice {
            write!(
                file,
                ", stripChoice: {{ optionsKey: {}, valueI18nPrefix: {} }}",
                ts_string(&choice.options_key),
                ts_string(&choice.value_i18n_prefix),
            )?;
        }
        if let Some(chip) = &field.active_array_chip {
            write!(
                file,
                ", activeArrayChip: {{ keyPrefix: {}, valueI18nPrefix: {} }}",
                ts_string(&chip.key_prefix),
                ts_string(&chip.value_i18n_prefix),
            )?;
        }
        file.push_str(" },\n");
    }
    file.push_str("] as const satisfies readonly PlantFilterFieldDef[]\n\n");

    write_fixed_filter_ts(&mut file, schema)?;

    file.push_str("export const PLANT_FILTER_SQL_FIELD_KEYS = [\n");
    for field in schema
        .fields
        .iter()
        .filter(|field| field.sql_column.is_some())
    {
        writeln!(file, "  {},", ts_string(&field.key))?;
    }
    file.push_str("] as const\n\n");

    file.push_str("export const FILTER_VALUE_ORDERINGS: Record<string, readonly string[]> = {\n");
    for (key, values) in &schema.orderings {
        writeln!(file, "  {}: [", ts_string(key))?;
        for value in values {
            writeln!(file, "    {},", ts_string(value))?;
        }
        file.push_str("  ],\n");
    }
    file.push_str("}\n\n");

    file.push_str(
        "const _fieldByKey: ReadonlyMap<string, PlantFilterFieldDef> = new Map(\n  PLANT_FILTER_FIELDS.map((field) => [field.key, field] as const),\n)\n\n",
    );
    file.push_str(
        "const _categoryByKey: ReadonlyMap<FilterCategory, PlantFilterCategory> = new Map(\n  FILTER_CATEGORIES.map((category) => [category.key, category] as const),\n)\n\n",
    );
    file.push_str(
        "const _dynamicFieldsByCategory: ReadonlyMap<FilterCategory, readonly PlantFilterFieldDef[]> = new Map(\n  FILTER_CATEGORIES.map((category) => [\n    category.key,\n    PLANT_FILTER_FIELDS.filter((field) => field.category === category.key && field.uiPlacement === 'dynamic'),\n  ] as const),\n)\n\n",
    );
    file.push_str(
        "export function fieldDefForKey(fieldKey: string): PlantFilterFieldDef | undefined {\n  return _fieldByKey.get(fieldKey)\n}\n\n",
    );
    file.push_str(
        "export function dynamicFilterFieldsForCategory(category: FilterCategory): readonly PlantFilterFieldDef[] {\n  return _dynamicFieldsByCategory.get(category) ?? []\n}\n\n",
    );
    file.push_str(
        "export function categoryForField(fieldKey: string): PlantFilterCategory | undefined {\n  const field = fieldDefForKey(fieldKey)\n  return field ? _categoryByKey.get(field.category) : undefined\n}\n\n",
    );
    file.push_str(
        "export function isStripField(fieldKey: string): boolean {\n  return fieldDefForKey(fieldKey)?.uiPlacement === 'strip'\n}\n\n",
    );
    file.push_str(
        "export function orderingForField(fieldKey: string): readonly string[] | undefined {\n  const ordering = fieldDefForKey(fieldKey)?.ordering\n  return ordering ? FILTER_VALUE_ORDERINGS[ordering] : undefined\n}\n",
    );

    Ok(file)
}

fn write_fixed_filter_ts(
    file: &mut String,
    schema: &PlantFilterSchema,
) -> Result<(), Box<dyn std::error::Error>> {
    file.push_str("export type FixedFilterActivityKind =\n");
    write_string_union_members(file, ["array", "boolean", "numeric", "string"].iter())?;
    file.push('\n');

    file.push_str(
        "export interface FixedStripChoiceBehavior {\n  labelI18nKey: string\n  fallbackLabel: string\n  optionsKey: string\n  valueI18nPrefix: string\n  colorToken: string\n}\n\n",
    );
    file.push_str(
        "export interface FixedStripThresholdBehavior {\n  labelI18nKey: string\n  fallbackLabel: string\n  min: number\n  max: number\n  colorToken: string\n}\n\n",
    );
    file.push_str(
        "export interface FixedStripBooleanBehavior {\n  labelI18nKey: string\n  fallbackLabel: string\n  colorToken: string\n}\n\n",
    );
    file.push_str(
        "export interface FixedActiveArrayChipBehavior {\n  keyPrefix: string\n  valueI18nPrefix: string\n  colorToken: string\n}\n\n",
    );
    file.push_str(
        "export interface FixedActiveBooleanChipBehavior {\n  labelI18nKey: string\n  fallbackLabel: string\n  colorToken: string\n}\n\n",
    );
    file.push_str(
        "export interface FixedActiveNumericChipBehavior {\n  labelI18nKey: string\n  fallbackLabel: string\n  colorToken: string\n  suffix: string\n}\n\n",
    );
    file.push_str(
        "export interface SpeciesFilterFixedBehavior {\n  key: string\n  kind: FixedFilterActivityKind\n  countable: boolean\n  stripChoice?: FixedStripChoiceBehavior\n  stripThreshold?: FixedStripThresholdBehavior\n  stripBoolean?: FixedStripBooleanBehavior\n  activeArrayChip?: FixedActiveArrayChipBehavior\n  activeBooleanChip?: FixedActiveBooleanChipBehavior\n  activeNumericChip?: FixedActiveNumericChipBehavior\n}\n\n",
    );

    file.push_str("export const SPECIES_FILTER_FIXED_BEHAVIORS = [\n");
    for filter in &schema.fixed_filters {
        write!(
            file,
            "  {{ key: {}, kind: {}, countable: {}",
            ts_string(&filter.key),
            ts_string(filter.kind.ts_value()),
            filter.countable,
        )?;
        if let Some(choice) = &filter.strip_choice {
            write!(
                file,
                ", stripChoice: {{ labelI18nKey: {}, fallbackLabel: {}, optionsKey: {}, valueI18nPrefix: {}, colorToken: {} }}",
                ts_string(&choice.label_i18n_key),
                ts_string(&choice.fallback_label),
                ts_string(&choice.options_key),
                ts_string(&choice.value_i18n_prefix),
                ts_string(&choice.color_token),
            )?;
        }
        if let Some(threshold) = &filter.strip_threshold {
            write!(
                file,
                ", stripThreshold: {{ labelI18nKey: {}, fallbackLabel: {}, min: {}, max: {}, colorToken: {} }}",
                ts_string(&threshold.label_i18n_key),
                ts_string(&threshold.fallback_label),
                format_number(threshold.min),
                format_number(threshold.max),
                ts_string(&threshold.color_token),
            )?;
        }
        if let Some(boolean) = &filter.strip_boolean {
            write!(
                file,
                ", stripBoolean: {{ labelI18nKey: {}, fallbackLabel: {}, colorToken: {} }}",
                ts_string(&boolean.label_i18n_key),
                ts_string(&boolean.fallback_label),
                ts_string(&boolean.color_token),
            )?;
        }
        if let Some(chip) = &filter.active_array_chip {
            write!(
                file,
                ", activeArrayChip: {{ keyPrefix: {}, valueI18nPrefix: {}, colorToken: {} }}",
                ts_string(&chip.key_prefix),
                ts_string(&chip.value_i18n_prefix),
                ts_string(&chip.color_token),
            )?;
        }
        if let Some(chip) = &filter.active_boolean_chip {
            write!(
                file,
                ", activeBooleanChip: {{ labelI18nKey: {}, fallbackLabel: {}, colorToken: {} }}",
                ts_string(&chip.label_i18n_key),
                ts_string(&chip.fallback_label),
                ts_string(&chip.color_token),
            )?;
        }
        if let Some(chip) = &filter.active_numeric_chip {
            write!(
                file,
                ", activeNumericChip: {{ labelI18nKey: {}, fallbackLabel: {}, colorToken: {}, suffix: {} }}",
                ts_string(&chip.label_i18n_key),
                ts_string(&chip.fallback_label),
                ts_string(&chip.color_token),
                ts_string(&chip.suffix),
            )?;
        }
        file.push_str(" },\n");
    }
    file.push_str("] as const satisfies readonly SpeciesFilterFixedBehavior[]\n\n");
    Ok(())
}

fn render_plant_filter_rust(
    schema: &PlantFilterSchema,
) -> Result<String, Box<dyn std::error::Error>> {
    let sql_fields: Vec<&PlantFilterFieldSchema> = schema
        .fields
        .iter()
        .filter(|field| field.sql_column.is_some())
        .collect();
    let mut file =
        String::from("// Generated by `cargo run -p bindings-gen`. Do not edit by hand.\n\n");
    file.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq)]\n");
    file.push_str("pub(crate) enum PlantFilterFieldKind {\n");
    file.push_str("    Boolean,\n    Categorical,\n    Numeric,\n}\n\n");
    file.push_str("#[derive(Debug)]\n");
    file.push_str("pub(crate) struct PlantFilterField {\n");
    file.push_str("    pub key: &'static str,\n");
    file.push_str("    pub column: &'static str,\n");
    file.push_str("    pub kind: PlantFilterFieldKind,\n");
    file.push_str("}\n\n");
    file.push_str("#[derive(Debug, Clone, Copy)]\n");
    file.push_str("pub(crate) struct FixedFilterBooleanMapping {\n");
    file.push_str("    pub value: &'static str,\n");
    file.push_str("    pub clause: &'static str,\n");
    file.push_str("}\n\n");
    file.push_str("#[derive(Debug, Clone, Copy)]\n");
    file.push_str("pub(crate) enum FixedFilterPredicate {\n");
    file.push_str("    MappedBooleanList(&'static [FixedFilterBooleanMapping]),\n");
    file.push_str("    TextInColumn(&'static str),\n");
    file.push_str("    TextEqualsColumn(&'static str),\n");
    file.push_str("    BooleanTrueClause(&'static str),\n");
    file.push_str("    NumericGteColumn(&'static str),\n");
    file.push_str("    ClimateZoneJoin,\n");
    file.push_str("    SchemaTextIn { field_key: &'static str },\n");
    file.push_str("    SchemaBooleanTrue { field_key: &'static str },\n");
    file.push_str("}\n\n");
    file.push_str("#[derive(Debug)]\n");
    file.push_str("pub(crate) struct FixedFilterBehavior {\n");
    file.push_str("    pub key: &'static str,\n");
    file.push_str("    pub predicate: FixedFilterPredicate,\n");
    file.push_str("}\n\n");
    file.push_str("#[derive(Debug, Clone, Copy)]\n");
    file.push_str("pub(crate) enum FixedFilterValue<'a> {\n");
    file.push_str("    StringList(Option<&'a [String]>),\n");
    file.push_str("    Boolean(Option<bool>),\n");
    file.push_str("    Integer(Option<i32>),\n");
    file.push_str("    Text(Option<&'a String>),\n");
    file.push_str("}\n\n");
    file.push_str("pub(crate) const PLANT_FILTER_FIELDS: &[PlantFilterField] = &[\n");
    for field in &sql_fields {
        writeln!(
            file,
            "    PlantFilterField {{\n        key: {},\n        column: {},\n        kind: {},\n    }},",
            rust_string(&field.key),
            rust_string(
                field
                    .sql_column
                    .as_deref()
                    .ok_or("sql_fields contain SQL columns")?
            ),
            field.kind.rust_variant(),
        )?;
    }
    file.push_str("];\n\n");
    write_fixed_filter_rust_constants(&mut file, schema)?;
    write_fixed_filter_value_adapter(&mut file, schema)?;
    file.push_str(
        "pub(crate) fn filter_field(key: &str) -> Option<&'static PlantFilterField> {\n    match key {\n",
    );
    for (index, field) in sql_fields.iter().enumerate() {
        writeln!(
            file,
            "        {} => Some(&PLANT_FILTER_FIELDS[{index}]),",
            rust_string(&field.key),
        )?;
    }
    file.push_str("        _ => None,\n    }\n}\n\n");
    file.push_str(
        "pub(crate) fn validated_column(key: &str) -> Option<&'static str> {\n    filter_field(key).map(|field| {\n        debug_assert_eq!(field.key, key);\n        field.column\n    })\n}\n\n",
    );
    file.push_str(
        "pub(crate) fn filter_field_kind(key: &str) -> Option<PlantFilterFieldKind> {\n    filter_field(key).map(|field| field.kind)\n}\n\n",
    );
    file.push_str(
        "#[cfg(test)]\npub(crate) fn fixed_filter_behavior(key: &str) -> Option<&'static FixedFilterBehavior> {\n    match key {\n",
    );
    for (index, filter) in schema.fixed_filters.iter().enumerate() {
        writeln!(
            file,
            "        {} => Some(&SPECIES_FILTER_FIXED_BEHAVIORS[{index}]),",
            rust_string(&filter.key),
        )?;
    }
    file.push_str("        _ => None,\n    }\n}\n\n");
    write_generated_rust_tests(&mut file, schema, &sql_fields)?;

    Ok(file)
}

fn write_generated_rust_tests(
    file: &mut String,
    schema: &PlantFilterSchema,
    sql_fields: &[&PlantFilterFieldSchema],
) -> Result<(), Box<dyn std::error::Error>> {
    file.push_str("#[cfg(test)]\nmod tests {\n    use super::*;\n\n");
    file.push_str("    #[test]\n    fn validates_known_columns_and_rejects_unknown_fields() {\n");
    if let Some(field) = sql_fields.first() {
        writeln!(
            file,
            "        assert_eq!(validated_column({}), Some({}));",
            rust_string(&field.key),
            rust_string(
                field
                    .sql_column
                    .as_deref()
                    .ok_or("SQL representative has a column")?
            ),
        )?;
    }
    if let Some(field) = schema
        .fields
        .iter()
        .find(|field| field.sql_column.is_none())
    {
        writeln!(
            file,
            "        assert_eq!(validated_column({}), None);",
            rust_string(&field.key),
        )?;
    }
    file.push_str(
        "        assert_eq!(validated_column(\"__unknown; DROP TABLE species\"), None);\n    }\n\n",
    );

    file.push_str("    #[test]\n    fn exposes_field_kinds_from_schema() {\n");
    for (kind, variant) in [
        (PlantFilterFieldKind::Boolean, "Boolean"),
        (PlantFilterFieldKind::Categorical, "Categorical"),
        (PlantFilterFieldKind::Numeric, "Numeric"),
    ] {
        if let Some(field) = sql_fields.iter().find(|field| field.kind == kind) {
            writeln!(
                file,
                "        assert_eq!(filter_field_kind({}), Some(PlantFilterFieldKind::{variant}));",
                rust_string(&field.key),
            )?;
        }
    }
    file.push_str("        assert_eq!(filter_field_kind(\"__unknown\"), None);\n    }\n\n");

    writeln!(
        file,
        "    #[test]\n    fn generated_fields_keep_static_sql_allowlist_entries() {{\n        assert!(PLANT_FILTER_FIELDS.iter().all(|field| field.column.starts_with(\"s.\")));\n        assert_eq!(PLANT_FILTER_FIELDS.len(), {});\n    }}\n",
        sql_fields.len(),
    )?;

    if let Some(filter) = schema.fixed_filters.iter().find(|filter| {
        matches!(
            &filter.predicate,
            FixedFilterPredicateSchema::MappedBooleanList { .. }
        )
    }) {
        let FixedFilterPredicateSchema::MappedBooleanList { clauses } = &filter.predicate else {
            unreachable!("the representative was selected by predicate kind")
        };
        let clause = clauses
            .first()
            .ok_or("schema validation rejects empty mapped predicates")?;
        writeln!(
            file,
            "    #[test]\n    fn exposes_fixed_species_filter_behavior_from_schema() {{\n        let behavior = fixed_filter_behavior({}).unwrap();\n        assert_eq!(behavior.key, {});\n        match behavior.predicate {{\n            FixedFilterPredicate::MappedBooleanList(clauses) => {{\n                assert!(clauses.iter().any(|clause| clause.value == {} && clause.clause == {}));\n            }}\n            _ => panic!(\"expected the schema-derived mapped predicate\"),\n        }}\n        assert!(fixed_filter_behavior(\"__unknown\").is_none());\n    }}\n",
            rust_string(&filter.key),
            rust_string(&filter.key),
            rust_string(&clause.value),
            rust_string(&clause.clause),
        )?;
    }

    let representatives = [
        FixedFilterActivityKind::Array,
        FixedFilterActivityKind::Boolean,
        FixedFilterActivityKind::Numeric,
        FixedFilterActivityKind::String,
    ]
    .into_iter()
    .filter_map(|kind| {
        schema
            .fixed_filters
            .iter()
            .find(|filter| filter.kind == kind)
    })
    .collect::<Vec<_>>();
    if !representatives.is_empty() {
        file.push_str(
            "    #[test]\n    fn generated_fixed_filters_read_species_filter_values() {\n        let filters = common_types::species::SpeciesFilter {\n",
        );
        for filter in &representatives {
            let value = match filter.kind {
                FixedFilterActivityKind::Array => "Some(vec![\"generated-value\".to_owned()])",
                FixedFilterActivityKind::Boolean => "Some(true)",
                FixedFilterActivityKind::Numeric => "Some(3)",
                FixedFilterActivityKind::String => "Some(\"generated-value\".to_owned())",
            };
            writeln!(file, "            {}: {value},", filter.key)?;
        }
        file.push_str(
            "            ..common_types::species::SpeciesFilter::default()\n        };\n\n",
        );
        for filter in representatives {
            let key = rust_string(&filter.key);
            match filter.kind {
                FixedFilterActivityKind::Array => {
                    writeln!(
                        file,
                        "        match fixed_filter_value(&filters, {key}).unwrap() {{\n            FixedFilterValue::StringList(Some(values)) => assert_eq!(values, [\"generated-value\".to_owned()].as_slice()),\n            other => panic!(\"expected generated list, got {{other:?}}\"),\n        }}"
                    )?;
                }
                FixedFilterActivityKind::Boolean => {
                    writeln!(
                        file,
                        "        assert!(matches!(fixed_filter_value(&filters, {key}), Some(FixedFilterValue::Boolean(Some(true)))));"
                    )?;
                }
                FixedFilterActivityKind::Numeric => {
                    writeln!(
                        file,
                        "        assert!(matches!(fixed_filter_value(&filters, {key}), Some(FixedFilterValue::Integer(Some(3)))));"
                    )?;
                }
                FixedFilterActivityKind::String => {
                    writeln!(
                        file,
                        "        match fixed_filter_value(&filters, {key}).unwrap() {{\n            FixedFilterValue::Text(Some(value)) => assert_eq!(value, \"generated-value\"),\n            other => panic!(\"expected generated text, got {{other:?}}\"),\n        }}"
                    )?;
                }
            }
        }
        file.push_str("    }\n");
    }
    file.push_str("}\n");
    Ok(())
}

fn write_fixed_filter_rust_constants(
    file: &mut String,
    schema: &PlantFilterSchema,
) -> Result<(), Box<dyn std::error::Error>> {
    for filter in &schema.fixed_filters {
        if let FixedFilterPredicateSchema::MappedBooleanList { clauses } = &filter.predicate {
            writeln!(
                file,
                "const {}: &[FixedFilterBooleanMapping] = &[",
                fixed_filter_mapping_const_name(&filter.key),
            )?;
            for clause in clauses {
                file.push_str("    FixedFilterBooleanMapping {\n");
                writeln!(file, "        value: {},", rust_string(&clause.value))?;
                writeln!(file, "        clause: {},", rust_string(&clause.clause))?;
                file.push_str("    },\n");
            }
            file.push_str("];\n\n");
        }
    }

    file.push_str("pub(crate) const SPECIES_FILTER_FIXED_BEHAVIORS: &[FixedFilterBehavior] = &[\n");
    for filter in &schema.fixed_filters {
        writeln!(file, "    FixedFilterBehavior {{")?;
        writeln!(file, "        key: {},", rust_string(&filter.key))?;
        write!(file, "        predicate: ")?;
        write_fixed_filter_rust_predicate(file, filter)?;
        file.push_str(",\n    },\n");
    }
    file.push_str("];\n\n");
    Ok(())
}

fn write_fixed_filter_value_adapter(
    file: &mut String,
    schema: &PlantFilterSchema,
) -> Result<(), Box<dyn std::error::Error>> {
    file.push_str(
        "pub(crate) fn fixed_filter_value<'a>(\n    filters: &'a common_types::species::SpeciesFilter,\n    key: &str,\n) -> Option<FixedFilterValue<'a>> {\n    match key {\n",
    );
    for filter in &schema.fixed_filters {
        match filter.kind {
            FixedFilterActivityKind::Array => {
                let key = rust_string(&filter.key);
                writeln!(file, "        {key} => {{")?;
                writeln!(
                    file,
                    "            Some(FixedFilterValue::StringList(filters.{}.as_deref()))",
                    filter.key,
                )?;
                writeln!(file, "        }}")?;
            }
            FixedFilterActivityKind::Boolean => {
                writeln!(
                    file,
                    "        {} => Some(FixedFilterValue::Boolean(filters.{})),",
                    rust_string(&filter.key),
                    filter.key,
                )?;
            }
            FixedFilterActivityKind::Numeric => {
                writeln!(
                    file,
                    "        {} => Some(FixedFilterValue::Integer(filters.{})),",
                    rust_string(&filter.key),
                    filter.key,
                )?;
            }
            FixedFilterActivityKind::String => {
                writeln!(
                    file,
                    "        {} => Some(FixedFilterValue::Text(filters.{}.as_ref())),",
                    rust_string(&filter.key),
                    filter.key,
                )?;
            }
        }
    }
    file.push_str("        _ => None,\n    }\n}\n\n");
    Ok(())
}

fn write_fixed_filter_rust_predicate(
    file: &mut String,
    filter: &FixedFilterSchema,
) -> Result<(), std::fmt::Error> {
    match &filter.predicate {
        FixedFilterPredicateSchema::MappedBooleanList { .. } => {
            write!(
                file,
                "FixedFilterPredicate::MappedBooleanList({})",
                fixed_filter_mapping_const_name(&filter.key),
            )?;
        }
        FixedFilterPredicateSchema::TextInColumn { column } => {
            write!(
                file,
                "FixedFilterPredicate::TextInColumn({})",
                rust_string(column),
            )?;
        }
        FixedFilterPredicateSchema::TextEqualsColumn { column } => {
            write!(
                file,
                "FixedFilterPredicate::TextEqualsColumn({})",
                rust_string(column),
            )?;
        }
        FixedFilterPredicateSchema::BooleanTrueClause { clause } => {
            write!(
                file,
                "FixedFilterPredicate::BooleanTrueClause({})",
                rust_string(clause),
            )?;
        }
        FixedFilterPredicateSchema::NumericGteColumn { column } => {
            write!(
                file,
                "FixedFilterPredicate::NumericGteColumn({})",
                rust_string(column),
            )?;
        }
        FixedFilterPredicateSchema::ClimateZoneJoin => {
            file.push_str("FixedFilterPredicate::ClimateZoneJoin");
        }
        FixedFilterPredicateSchema::SchemaTextIn { field_key } => {
            write!(
                file,
                "FixedFilterPredicate::SchemaTextIn {{ field_key: {} }}",
                rust_string(field_key),
            )?;
        }
        FixedFilterPredicateSchema::SchemaBooleanTrue { field_key } => {
            write!(
                file,
                "FixedFilterPredicate::SchemaBooleanTrue {{ field_key: {} }}",
                rust_string(field_key),
            )?;
        }
    }
    Ok(())
}

fn write_string_union_members<I, S>(file: &mut String, values: I) -> Result<(), std::fmt::Error>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for value in values {
        writeln!(file, "  | {}", ts_string(value.as_ref()))?;
    }
    Ok(())
}

/// `value` as a TypeScript string literal: JSON's string escaping, which cannot fail for a `&str`.
fn ts_string(value: &str) -> String {
    serde_json::Value::from(value).to_string()
}

fn rust_string(value: &str) -> String {
    format!("{value:?}")
}

fn fixed_filter_mapping_const_name(key: &str) -> String {
    let mut name = String::new();
    for ch in key.chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch.to_ascii_uppercase());
        } else {
            name.push('_');
        }
    }
    format!("{name}_BOOLEAN_MAPPINGS")
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        FixedFilterActivityKind, PlantFilterFieldKind, load_plant_filter_schema,
        render_plant_filter_rust, ts_string,
    };
    use std::path::Path;

    #[test]
    fn a_typescript_string_literal_escapes_quotes_backslashes_and_controls() {
        assert_eq!(
            ts_string("say \"hi\"\\\n\u{1}é"),
            r#""say \"hi\"\\\n\u0001é""#
        );
    }

    #[test]
    fn generated_tests_select_representatives_from_the_authored_schema() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let schema =
            load_plant_filter_schema(&repo_root.join("common-types/plant-filter-fields.json"))
                .unwrap();
        let rendered = render_plant_filter_rust(&schema).unwrap();

        for kind in [
            PlantFilterFieldKind::Boolean,
            PlantFilterFieldKind::Categorical,
            PlantFilterFieldKind::Numeric,
        ] {
            let representative = schema
                .fields
                .iter()
                .find(|field| field.kind == kind && field.sql_column.is_some())
                .unwrap();
            assert!(
                rendered.contains(&format!("filter_field_kind(\"{}\")", representative.key)),
                "missing generated SQL-field representative for {kind:?}",
            );
        }

        for kind in [
            FixedFilterActivityKind::Array,
            FixedFilterActivityKind::Boolean,
            FixedFilterActivityKind::Numeric,
            FixedFilterActivityKind::String,
        ] {
            let representative = schema
                .fixed_filters
                .iter()
                .find(|filter| filter.kind == kind)
                .unwrap();
            assert!(
                rendered.contains(&format!(
                    "fixed_filter_value(&filters, \"{}\")",
                    representative.key
                )),
                "missing generated fixed-filter representative for {kind:?}",
            );
        }
    }
}
