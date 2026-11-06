use canopi_types::species::SpeciesListItem;
use rusqlite::{Row, types::FromSql};

#[cfg(test)]
const SPECIES_LIST_ITEM_COLUMNS: &[&str] = &[
    "canonical_name",
    "slug",
    "common_name",
    "common_name_2",
    "matched_common_name",
    "is_name_fallback",
    "family",
    "genus",
    "height_max_m",
    "hardiness_zone_min",
    "hardiness_zone_max",
    "growth_rate",
    "stratum",
    "habit",
    "climate_zones",
    "is_annual",
    "is_biennial",
    "is_perennial",
    "edibility_rating",
    "medicinal_rating",
    "width_max_m",
];

struct SpeciesListCursor<'row, 'stmt> {
    row: &'row Row<'stmt>,
}

impl<'row, 'stmt> SpeciesListCursor<'row, 'stmt> {
    fn new(row: &'row Row<'stmt>) -> Self {
        Self { row }
    }

    fn read<T: FromSql>(&self, column: &'static str) -> rusqlite::Result<T> {
        self.row.get(column)
    }

    fn read_flag(&self, column: &'static str) -> rusqlite::Result<bool> {
        self.read::<i32>(column).map(|value| value != 0)
    }

    fn read_optional_flag(&self, column: &'static str) -> rusqlite::Result<bool> {
        self.read::<Option<i32>>(column)
            .map(|value| value.unwrap_or(0) != 0)
    }
}

pub(super) fn map_species_list_row(row: &Row<'_>) -> rusqlite::Result<SpeciesListItem> {
    map_species_list_row_with_favorite(row, false)
}

pub(super) fn map_species_list_row_with_favorite(
    row: &Row<'_>,
    is_favorite: bool,
) -> rusqlite::Result<SpeciesListItem> {
    let cursor = SpeciesListCursor::new(row);

    Ok(SpeciesListItem {
        canonical_name: cursor.read("canonical_name")?,
        slug: cursor.read("slug")?,
        common_name: cursor.read("common_name")?,
        common_name_2: cursor.read("common_name_2")?,
        matched_common_name: cursor.read("matched_common_name")?,
        is_name_fallback: cursor.read_flag("is_name_fallback")?,
        family: cursor.read("family")?,
        genus: cursor.read("genus")?,
        height_max_m: cursor.read("height_max_m")?,
        hardiness_zone_min: cursor.read("hardiness_zone_min")?,
        hardiness_zone_max: cursor.read("hardiness_zone_max")?,
        growth_rate: cursor.read("growth_rate")?,
        stratum: cursor.read("stratum")?,
        habit: cursor.read("habit")?,
        climate_zones: parse_json_array_field(cursor.read("climate_zones")?),
        life_cycles: life_cycles_from_flags(
            cursor.read_optional_flag("is_annual")?,
            cursor.read_optional_flag("is_biennial")?,
            cursor.read_optional_flag("is_perennial")?,
        ),
        edibility_rating: cursor.read("edibility_rating")?,
        medicinal_rating: cursor.read("medicinal_rating")?,
        width_max_m: cursor.read("width_max_m")?,
        is_favorite,
    })
}

fn parse_json_array_field(value: Option<String>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<String>>(&value) {
        Ok(items) => items,
        Err(_) if value.trim().is_empty() => Vec::new(),
        Err(_) => vec![value],
    }
}

fn life_cycles_from_flags(is_annual: bool, is_biennial: bool, is_perennial: bool) -> Vec<String> {
    let mut values = Vec::new();
    if is_annual {
        values.push("Annual".to_owned());
    }
    if is_biennial {
        values.push("Biennial".to_owned());
    }
    if is_perennial {
        values.push("Perennial".to_owned());
    }
    values
}

#[cfg(test)]
mod tests {
    use super::{SPECIES_LIST_ITEM_COLUMNS, map_species_list_row_with_favorite};
    use rusqlite::Connection;

    #[test]
    fn maps_list_rows_by_column_name_not_select_order() {
        let select = SPECIES_LIST_ITEM_COLUMNS
            .iter()
            .rev()
            .map(|column| match *column {
                "canonical_name" => "'Malus domestica' AS canonical_name".to_owned(),
                "slug" => "'malus-domestica' AS slug".to_owned(),
                "common_name" => "'Apple' AS common_name".to_owned(),
                "common_name_2" => "'Pomme' AS common_name_2".to_owned(),
                "matched_common_name" => "'Malus' AS matched_common_name".to_owned(),
                "is_name_fallback" => "1 AS is_name_fallback".to_owned(),
                "height_max_m" => "4.0 AS height_max_m".to_owned(),
                "hardiness_zone_min" => "4 AS hardiness_zone_min".to_owned(),
                "hardiness_zone_max" => "8 AS hardiness_zone_max".to_owned(),
                "climate_zones" => "'[\"Temperate\",\"Continental\"]' AS climate_zones".to_owned(),
                "is_perennial" => "1 AS is_perennial".to_owned(),
                "width_max_m" => "3.0 AS width_max_m".to_owned(),
                "edibility_rating" => "5 AS edibility_rating".to_owned(),
                "medicinal_rating" => "1 AS medicinal_rating".to_owned(),
                "habit" => "'Tree' AS habit".to_owned(),
                _ => format!("NULL AS {column}"),
            })
            .collect::<Vec<_>>()
            .join(", ");
        let conn = Connection::open_in_memory().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT {select}")).unwrap();

        let item = stmt
            .query_row([], |row| map_species_list_row_with_favorite(row, true))
            .unwrap();

        assert_eq!(item.canonical_name, "Malus domestica");
        assert_eq!(item.slug, "malus-domestica");
        assert_eq!(item.common_name.as_deref(), Some("Apple"));
        assert_eq!(item.common_name_2.as_deref(), Some("Pomme"));
        assert_eq!(item.matched_common_name.as_deref(), Some("Malus"));
        assert!(item.is_name_fallback);
        assert_eq!(item.height_max_m, Some(4.0));
        assert_eq!(item.hardiness_zone_min, Some(4));
        assert_eq!(item.hardiness_zone_max, Some(8));
        assert_eq!(item.climate_zones, vec!["Temperate", "Continental"]);
        assert_eq!(item.life_cycles, vec!["Perennial"]);
        assert_eq!(item.width_max_m, Some(3.0));
        assert_eq!(item.edibility_rating, Some(5));
        assert_eq!(item.medicinal_rating, Some(1));
        assert_eq!(item.habit.as_deref(), Some("Tree"));
        assert!(item.is_favorite);
    }
}
