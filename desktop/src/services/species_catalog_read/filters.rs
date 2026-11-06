use canopi_types::species::{DynamicFilterOptions, FilterOptions, FilterValue};
use rusqlite::Connection;

use super::common_names::translate_composite_value;
use crate::db::query_builder::{PlantFilterFieldKind, filter_field_kind, validated_column};

pub fn get_filter_options(conn: &Connection) -> Result<FilterOptions, String> {
    let families: Vec<String> = distinct_text_values(
        conn,
        "SELECT DISTINCT family FROM species WHERE family IS NOT NULL ORDER BY family",
        "families",
    )?;
    let growth_rates: Vec<String> = distinct_text_values(
        conn,
        "SELECT DISTINCT growth_rate FROM species WHERE growth_rate IS NOT NULL ORDER BY growth_rate",
        "growth rates",
    )?;
    let climate_zones = vec![
        "Tropical".to_owned(),
        "Arid".to_owned(),
        "Mediterranean".to_owned(),
        "Subtropical".to_owned(),
        "Temperate".to_owned(),
        "Continental".to_owned(),
        "Boreal".to_owned(),
    ];

    let habits = vec![
        "Tree".to_owned(),
        "Shrub".to_owned(),
        "Herbaceous".to_owned(),
        "Climber".to_owned(),
    ];

    let life_cycles = vec![
        "Annual".to_owned(),
        "Biennial".to_owned(),
        "Perennial".to_owned(),
    ];
    let soil_tolerances = vec![
        "light".to_owned(),
        "medium".to_owned(),
        "heavy".to_owned(),
        "well_drained".to_owned(),
        "heavy_clay".to_owned(),
    ];

    let mut sun_tolerances = Vec::new();
    if boolean_exists(conn, "tolerates_full_sun")? {
        sun_tolerances.push("full_sun".to_owned());
    }
    if boolean_exists(conn, "tolerates_semi_shade")? {
        sun_tolerances.push("semi_shade".to_owned());
    }
    if boolean_exists(conn, "tolerates_full_shade")? {
        sun_tolerances.push("full_shade".to_owned());
    }

    Ok(FilterOptions {
        families,
        growth_rates,
        climate_zones,
        habits,
        life_cycles,
        sun_tolerances,
        soil_tolerances,
    })
}

pub(super) fn read_filter_options(conn: &Connection) -> Result<FilterOptions, String> {
    get_filter_options(conn)
}

pub fn get_dynamic_filter_options(
    conn: &Connection,
    fields: &[String],
    locale: &str,
) -> Result<Vec<DynamicFilterOptions>, String> {
    let mut results = Vec::with_capacity(fields.len());

    for field in fields {
        let Some(column) = validated_column(field) else {
            tracing::warn!(
                "Dynamic filter field is not allowlisted in this backend build: {field}"
            );
            continue;
        };
        let Some(field_kind) = filter_field_kind(field) else {
            tracing::warn!("Dynamic filter field has no generated kind: {field}");
            continue;
        };
        let column_name = column.strip_prefix("s.").unwrap_or(column);

        match field_kind {
            PlantFilterFieldKind::Boolean => {
                results.push(DynamicFilterOptions {
                    field: field.clone(),
                    field_type: "boolean".to_owned(),
                    values: None,
                    range: None,
                });
            }
            PlantFilterFieldKind::Numeric => {
                // Safety: column_name comes from validated_column() allowlist — not user input.
                // Column identifiers cannot be bound as SQL parameters.
                let range: Option<(f64, f64)> = conn
                    .query_row(
                        &format!(
                            "SELECT MIN(CAST({column_name} AS REAL)), MAX(CAST({column_name} AS REAL)) \
                             FROM species WHERE {column_name} IS NOT NULL AND typeof({column_name}) IN ('integer', 'real')"
                        ),
                        [],
                        |row| {
                            let min: Option<f64> = row.get(0)?;
                            let max: Option<f64> = row.get(1)?;
                            Ok(min.zip(max))
                        },
                    )
                    .map_err(|e| format!("Failed to query range for {field}: {e}"))?;

                results.push(DynamicFilterOptions {
                    field: field.clone(),
                    field_type: "numeric".to_owned(),
                    values: None,
                    range,
                });
            }
            PlantFilterFieldKind::Categorical => {
                // Safety: column_name comes from validated_column() allowlist — not user input.
                let sql = format!(
                    "SELECT DISTINCT {column_name} FROM species \
                     WHERE {column_name} IS NOT NULL AND {column_name} != '' \
                     ORDER BY {column_name} LIMIT 100"
                );
                let mut stmt = conn
                    .prepare(&sql)
                    .map_err(|e| format!("Failed to prepare distinct query for {field}: {e}"))?;
                let values: Vec<FilterValue> = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|e| format!("Failed to fetch values for {field}: {e}"))?
                    .map(|result| {
                        result
                            .map(|value| FilterValue {
                                label: translate_composite_value(conn, field, &value, locale),
                                value,
                            })
                            .map_err(|e| format!("Failed to read a value for {field}: {e}"))
                    })
                    .collect::<Result<_, _>>()?;

                results.push(DynamicFilterOptions {
                    field: field.clone(),
                    field_type: "categorical".to_owned(),
                    values: Some(values),
                    range: None,
                });
            }
        }
    }

    Ok(results)
}

pub(super) fn read_dynamic_filter_options(
    conn: &Connection,
    fields: &[String],
    locale: &str,
) -> Result<Vec<DynamicFilterOptions>, String> {
    get_dynamic_filter_options(conn, fields, locale)
}

fn distinct_text_values(conn: &Connection, sql: &str, label: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to prepare {label} query: {e}"))?;
    Ok(stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| format!("Failed to fetch {label}: {e}"))?
        .filter_map(|result| match result {
            Ok(item) => Some(item),
            Err(error) => {
                tracing::warn!("Skipped {label} row: {error}");
                None
            }
        })
        .collect())
}

/// Safety: column_name is a hardcoded value from get_filter_options — not user input.
fn boolean_exists(conn: &Connection, column_name: &str) -> Result<bool, String> {
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM species WHERE {column_name} = 1)"),
        [],
        |row| row.get(0),
    )
    .map_err(|e| format!("Failed to check {column_name} filter options: {e}"))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn filter_option_queries_report_database_errors() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE species (family TEXT, growth_rate TEXT);")
            .unwrap();

        let error = super::get_filter_options(&conn)
            .expect_err("a missing tolerance column must not read as \"no species\"");
        assert!(error.contains("tolerates_full_sun"), "{error}");
    }
}
