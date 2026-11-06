use canopi_types::species::SpeciesFilter;

use crate::db::plant_filter_fields::{
    FixedFilterBehavior, FixedFilterBooleanMapping, FixedFilterPredicate, FixedFilterValue,
    SPECIES_FILTER_FIXED_BEHAVIORS, fixed_filter_value,
};

use super::columns::validated_column;
use super::sql::SqlBuilder;
use super::{PlantFilterFieldKind, filter_field_kind};

pub(super) fn append_fixed_filters(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    filters: &SpeciesFilter,
) {
    for behavior in SPECIES_FILTER_FIXED_BEHAVIORS {
        let Some(value) = fixed_filter_value(filters, behavior.key) else {
            debug_assert!(
                false,
                "missing SpeciesFilter value adapter for generated fixed filter '{}'",
                behavior.key
            );
            continue;
        };
        append_generated_fixed_filter(where_clauses, sql_builder, behavior, value);
    }
}

fn append_generated_fixed_filter(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    behavior: &FixedFilterBehavior,
    value: FixedFilterValue<'_>,
) {
    match (behavior.predicate, value) {
        (
            FixedFilterPredicate::MappedBooleanList(mapping),
            FixedFilterValue::StringList(values),
        ) => {
            append_mapped_boolean_list_filter(where_clauses, values, mapping);
        }
        (
            FixedFilterPredicate::TextInColumn(column),
            FixedFilterValue::StringList(Some(values)),
        ) => {
            append_text_in_clause(where_clauses, sql_builder, column, values);
        }
        (FixedFilterPredicate::TextEqualsColumn(column), FixedFilterValue::Text(Some(value))) => {
            let placeholder = sql_builder.bind_text(value.clone());
            where_clauses.push(format!("{column} = {placeholder}"));
        }
        (
            FixedFilterPredicate::BooleanTrueClause(clause),
            FixedFilterValue::Boolean(Some(true)),
        ) => {
            where_clauses.push(clause.to_owned());
        }
        (
            FixedFilterPredicate::NumericGteColumn(column),
            FixedFilterValue::Integer(Some(value)),
        ) => {
            let placeholder = sql_builder.bind_integer(value as i64);
            where_clauses.push(format!("{column} >= {placeholder}"));
        }
        (FixedFilterPredicate::ClimateZoneJoin, FixedFilterValue::StringList(Some(values))) => {
            append_climate_zone_filter(where_clauses, sql_builder, values);
        }
        (
            FixedFilterPredicate::SchemaTextIn { field_key },
            FixedFilterValue::StringList(Some(values)),
        ) => {
            append_schema_text_in_clause(where_clauses, sql_builder, field_key, values);
        }
        (
            FixedFilterPredicate::SchemaBooleanTrue { field_key },
            FixedFilterValue::Boolean(Some(value)),
        ) => {
            append_schema_boolean_true_clause(where_clauses, field_key, value);
        }
        _ => {}
    }
}

fn append_mapped_boolean_list_filter(
    where_clauses: &mut Vec<String>,
    values: Option<&[String]>,
    mapping: &[FixedFilterBooleanMapping],
) {
    let Some(values) = values else {
        return;
    };
    if values.is_empty() {
        return;
    }

    let clauses: Vec<&str> = values
        .iter()
        .filter_map(|value| {
            mapping
                .iter()
                .find_map(|entry| (entry.value == value).then_some(entry.clause))
        })
        .collect();

    if !clauses.is_empty() {
        where_clauses.push(format!("({})", clauses.join(" OR ")));
    }
}

fn append_climate_zone_filter(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    zones: &[String],
) {
    if zones.is_empty() {
        return;
    }

    let placeholders = sql_builder.bind_text_list(zones);
    where_clauses.push(format!(
        "EXISTS (SELECT 1 FROM species_climate_zones cz WHERE cz.species_id = s.id AND cz.climate_zone IN ({}))",
        placeholders.join(", ")
    ));
}

fn append_schema_text_in_clause(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    field_key: &str,
    values: &[String],
) {
    if values.is_empty() {
        return;
    }

    if let (Some(column), Some(PlantFilterFieldKind::Categorical)) =
        (validated_column(field_key), filter_field_kind(field_key))
    {
        append_text_in_clause(where_clauses, sql_builder, column, values);
    }
}

fn append_schema_boolean_true_clause(
    where_clauses: &mut Vec<String>,
    field_key: &str,
    value: bool,
) {
    if !value {
        return;
    }

    if let (Some(column), Some(PlantFilterFieldKind::Boolean)) =
        (validated_column(field_key), filter_field_kind(field_key))
    {
        where_clauses.push(format!("{column} = 1"));
    }
}

fn append_text_in_clause(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    column: &str,
    values: &[String],
) {
    if values.is_empty() {
        return;
    }

    let placeholders = sql_builder.bind_text_list(values);
    where_clauses.push(format!("{column} IN ({})", placeholders.join(", ")));
}

#[cfg(test)]
mod tests {
    use crate::db::plant_filter_fields::fixed_filter_behavior;

    use super::*;

    #[test]
    fn every_generated_fixed_filter_has_a_request_value_adapter() {
        let filters = SpeciesFilter::default();

        for behavior in SPECIES_FILTER_FIXED_BEHAVIORS {
            assert!(
                fixed_filter_value(&filters, behavior.key).is_some(),
                "missing request value adapter for {}",
                behavior.key
            );
        }
    }

    #[test]
    fn life_cycle_filter_maps_known_values_to_boolean_columns() {
        let mut clauses = Vec::new();
        let cycles = vec!["Annual".to_owned(), "Perennial".to_owned()];
        let mapping = match fixed_filter_behavior("life_cycle").unwrap().predicate {
            FixedFilterPredicate::MappedBooleanList(mapping) => mapping,
            _ => panic!("life_cycle should use mapped boolean predicate"),
        };

        append_mapped_boolean_list_filter(&mut clauses, Some(cycles.as_slice()), mapping);

        assert_eq!(clauses, ["(s.is_annual = 1 OR s.is_perennial = 1)"]);
    }

    #[test]
    fn life_cycle_filter_ignores_unknown_values() {
        let mut clauses = Vec::new();
        let cycles = vec!["Unknown".to_owned()];
        let mapping = match fixed_filter_behavior("life_cycle").unwrap().predicate {
            FixedFilterPredicate::MappedBooleanList(mapping) => mapping,
            _ => panic!("life_cycle should use mapped boolean predicate"),
        };

        append_mapped_boolean_list_filter(&mut clauses, Some(cycles.as_slice()), mapping);

        assert!(clauses.is_empty());
    }

    #[test]
    fn fixed_filters_route_schema_and_bespoke_predicates_through_one_adapter() {
        let mut clauses = Vec::new();
        let mut sql_builder = SqlBuilder::default();
        let filters = SpeciesFilter {
            sun_tolerances: Some(vec!["full_sun".to_owned(), "full_shade".to_owned()]),
            soil_tolerances: Some(vec!["heavy_clay".to_owned()]),
            growth_rate: Some(vec!["Fast".to_owned()]),
            life_cycle: Some(vec!["Perennial".to_owned()]),
            edible: Some(true),
            edibility_min: Some(3),
            nitrogen_fixer: Some(true),
            climate_zones: Some(vec!["Temperate".to_owned()]),
            habit: Some(vec!["Tree".to_owned()]),
            woody: Some(true),
            ..SpeciesFilter::default()
        };

        append_fixed_filters(&mut clauses, &mut sql_builder, &filters);

        let sql = clauses.join(" AND ");
        assert!(sql.contains("tolerates_full_sun = 1"));
        assert!(sql.contains("heavy_clay = 1"));
        assert!(sql.contains("s.growth_rate IN"));
        assert!(sql.contains("is_perennial = 1"));
        assert!(sql.contains("s.edibility_rating > 0"));
        assert!(sql.contains("s.edibility_rating >="));
        assert!(sql.contains("s.nitrogen_fixer = 1"));
        assert!(sql.contains("species_climate_zones cz"));
        assert!(sql.contains("s.habit IN"));
        assert!(sql.contains("s.woody = 1"));
        assert_eq!(sql_builder.params().len(), 4);
    }
}
