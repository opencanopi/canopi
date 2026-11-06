use canopi_types::species::{DynamicFilter, FilterOp, SpeciesFilter};

use super::columns::validated_column;
use super::species_catalog_filters;
use super::sql::SqlBuilder;
use super::{PlantFilterFieldKind, filter_field_kind};

pub(super) fn append_structured_filters(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    filters: &SpeciesFilter,
) {
    species_catalog_filters::append_fixed_filters(where_clauses, sql_builder, filters);

    if let Some(ref extras) = filters.extra {
        for extra in extras {
            append_dynamic_filter(where_clauses, sql_builder, extra);
        }
    }
}

fn append_dynamic_filter(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    extra: &DynamicFilter,
) {
    let Some(column) = validated_column(&extra.field) else {
        return;
    };
    let Some(field_kind) = filter_field_kind(&extra.field) else {
        return;
    };

    match (field_kind, &extra.op) {
        (PlantFilterFieldKind::Boolean, FilterOp::IsTrue) => {
            where_clauses.push(format!("{column} = 1"));
        }
        (PlantFilterFieldKind::Categorical, FilterOp::Equals) => {
            append_text_equals_clause(where_clauses, sql_builder, column, extra.values.first());
        }
        (PlantFilterFieldKind::Categorical, FilterOp::In) => {
            append_text_in_clause(where_clauses, sql_builder, column, &extra.values);
        }
        (PlantFilterFieldKind::Numeric, FilterOp::Equals) => {
            append_scalar_comparison(
                where_clauses,
                sql_builder,
                column,
                "=",
                extra.values.first(),
            );
        }
        (PlantFilterFieldKind::Numeric, FilterOp::Gte) => {
            append_scalar_comparison(
                where_clauses,
                sql_builder,
                column,
                ">=",
                extra.values.first(),
            );
        }
        (PlantFilterFieldKind::Numeric, FilterOp::Lte) => {
            append_scalar_comparison(
                where_clauses,
                sql_builder,
                column,
                "<=",
                extra.values.first(),
            );
        }
        (PlantFilterFieldKind::Numeric, FilterOp::Between) => {
            append_scalar_between_clause(where_clauses, sql_builder, column, &extra.values);
        }
        _ => {}
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

fn append_text_equals_clause(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    column: &str,
    value: Option<&String>,
) {
    if let Some(value) = value {
        let placeholder = sql_builder.bind_text(value.clone());
        where_clauses.push(format!("{column} = {placeholder}"));
    }
}

fn append_scalar_comparison(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    column: &str,
    operator: &str,
    value: Option<&String>,
) {
    if let Some(value) = value {
        let placeholder = sql_builder.bind_best_effort(value);
        where_clauses.push(format!("{column} {operator} {placeholder}"));
    }
}

fn append_scalar_between_clause(
    where_clauses: &mut Vec<String>,
    sql_builder: &mut SqlBuilder,
    column: &str,
    values: &[String],
) {
    if values.len() >= 2 {
        let min_placeholder = sql_builder.bind_best_effort(&values[0]);
        let max_placeholder = sql_builder.bind_best_effort(&values[1]);
        where_clauses.push(format!(
            "{column} BETWEEN {min_placeholder} AND {max_placeholder}",
        ));
    }
}
