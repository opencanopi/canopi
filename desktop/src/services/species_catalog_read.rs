use std::collections::HashMap;

use crate::db::PlantDbConnectionGuard;
use common_types::species::{
    CommonNameEntry, DynamicFilterOptions, FilterOptions, FlowerColorResolution, PaginatedResult,
    SpeciesDetail, SpeciesImage, SpeciesListItem, SpeciesSearchRequest,
};

mod common_names;
mod detail;
mod detail_projection;
mod detail_row_map;
mod filters;
mod flower;
mod habit;
mod list_items;
mod list_projection;
mod media;
mod search;

#[cfg(test)]
pub(crate) mod test_support;

pub(crate) struct SpeciesCatalogRead<'guard, 'connection> {
    conn: &'guard PlantDbConnectionGuard<'connection>,
}

impl<'guard, 'connection> SpeciesCatalogRead<'guard, 'connection> {
    pub(crate) fn new(conn: &'guard PlantDbConnectionGuard<'connection>) -> Self {
        Self { conn }
    }

    pub(crate) fn search(
        &self,
        request: SpeciesSearchRequest,
    ) -> Result<PaginatedResult<SpeciesListItem>, String> {
        search::read_projection(self.conn, request)
    }

    pub(crate) fn list_items_for_canonical_names(
        &self,
        canonical_names: &[String],
        locale: &str,
    ) -> Result<Vec<SpeciesListItem>, String> {
        list_items::read_projection(self.conn, canonical_names, locale)
    }

    pub(crate) fn detail_for_canonical_name(
        &self,
        canonical_name: &str,
        locale: &str,
    ) -> Result<SpeciesDetail, String> {
        detail::read_detail_projection(self.conn, canonical_name, locale)
    }

    pub(crate) fn details_for_canonical_names(
        &self,
        canonical_names: &[String],
        locale: &str,
    ) -> Result<Vec<SpeciesDetail>, String> {
        detail::read_detail_projections(self.conn, canonical_names, locale)
    }

    pub(crate) fn common_names_for_canonical_names(
        &self,
        canonical_names: &[String],
        locale: &str,
    ) -> Result<HashMap<String, String>, String> {
        common_names::localized_names_for_canonical_names(self.conn, canonical_names, locale)
    }

    pub(crate) fn habits_for_canonical_names(
        &self,
        canonical_names: &[String],
    ) -> Result<HashMap<String, String>, String> {
        habit::read_projection(self.conn, canonical_names)
    }

    pub(crate) fn locale_common_names_for_canonical_name(
        &self,
        canonical_name: &str,
        locale: &str,
    ) -> Result<Vec<CommonNameEntry>, String> {
        common_names::locale_common_names_for_canonical_name(self.conn, canonical_name, locale)
    }

    pub(crate) fn flower_colors_for_canonical_names(
        &self,
        canonical_names: &[String],
    ) -> Result<Vec<FlowerColorResolution>, String> {
        flower::read_projection(self.conn, canonical_names)
    }

    pub(crate) fn filter_options(&self) -> Result<FilterOptions, String> {
        filters::read_filter_options(self.conn)
    }

    pub(crate) fn dynamic_filter_options(
        &self,
        fields: &[String],
        locale: &str,
    ) -> Result<Vec<DynamicFilterOptions>, String> {
        filters::read_dynamic_filter_options(self.conn, fields, locale)
    }

    pub(crate) fn images_for_canonical_name(
        &self,
        canonical_name: &str,
    ) -> Result<Vec<SpeciesImage>, String> {
        media::read_images_projection(self.conn, canonical_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use common_types::species::{Sort, SpeciesFilter};
    use rusqlite::Connection;

    fn search_request() -> SpeciesSearchRequest {
        SpeciesSearchRequest {
            text: String::new(),
            filters: SpeciesFilter::default(),
            cursor: None,
            limit: 10,
            sort: Sort::Name,
            locale: "fr".to_owned(),
            include_total: true,
        }
    }

    #[test]
    fn search_projection_uses_structured_request_and_locale_names() {
        let plant_db = test_support::test_plant_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);
        let result = catalog.search(search_request()).unwrap();

        assert_eq!(result.total_estimate, 6);
        assert_eq!(result.items[0].canonical_name, "Apple");
        assert_eq!(result.items[0].common_name.as_deref(), Some("Pommier"));
        assert!(!result.items[0].is_favorite);
    }

    #[test]
    fn list_item_projection_hydrates_locale_names_without_user_favorite_state() {
        let plant_db = test_support::test_plant_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);
        let rows = catalog
            .list_items_for_canonical_names(
                &["Apple".to_owned(), "Missing".to_owned(), "Plum".to_owned()],
                "fr",
            )
            .unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].canonical_name, "Apple");
        assert_eq!(rows[0].common_name.as_deref(), Some("Pommier"));
        assert_eq!(rows[0].common_name_2.as_deref(), Some("Pomme"));
        assert!(!rows[0].is_name_fallback);
        assert!(!rows[0].is_favorite);
        assert_eq!(rows[1].canonical_name, "Plum");
        assert_eq!(rows[1].common_name, None);
        assert!(rows[1].common_name_2.is_none());
        assert!(!rows[1].is_name_fallback);
    }

    #[test]
    fn list_item_projection_uses_english_common_names_for_english_locale_only() {
        let plant_db = test_support::test_plant_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        conn.execute(
            "INSERT INTO species (
                id, slug, canonical_name, common_name, family, genus, growth_rate, width_max_m,
                hardiness_zone_min, hardiness_zone_max, edibility_rating, medicinal_rating,
                stratum, height_max_m, tolerates_full_sun, tolerates_semi_shade,
                tolerates_full_shade, flower_color
             )
             VALUES ('s7', 'fig', 'Fig', 'Storage fig', 'Moraceae', 'Ficus', 'Medium', 3.0,
                7, 10, 5, 1, 'canopy', 5.0, 1, 0, 0, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO species_common_names (
	                id, species_id, language, common_name, is_primary, display_order
	             )
	             VALUES ('cn-10', 's7', 'en', 'Common fig', 1, 0)",
            [],
        )
        .unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);

        let french_rows = catalog
            .list_items_for_canonical_names(&["Fig".to_owned()], "fr")
            .unwrap();
        let english_rows = catalog
            .list_items_for_canonical_names(&["Fig".to_owned()], "en")
            .unwrap();

        assert_eq!(french_rows[0].common_name, None);
        assert!(!french_rows[0].is_name_fallback);
        assert_eq!(english_rows[0].common_name.as_deref(), Some("Common fig"));
        assert!(!english_rows[0].is_name_fallback);
    }

    #[test]
    fn filter_projection_reads_fixed_and_dynamic_options() {
        let plant_db = test_support::test_plant_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);

        let fixed = catalog.filter_options().unwrap();
        assert!(fixed.families.contains(&"Rosaceae".to_owned()));
        assert!(fixed.sun_tolerances.contains(&"full_sun".to_owned()));

        let dynamic = catalog
            .dynamic_filter_options(&["height_max_m".to_owned()], "en")
            .unwrap();
        assert_eq!(dynamic.len(), 1);
        assert_eq!(dynamic[0].field, "height_max_m");
        assert_eq!(dynamic[0].range, Some((1.5, 20.0)));
    }

    #[test]
    fn media_and_common_name_projections_read_species_side_data() {
        let plant_db = test_support::test_plant_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);

        let images = catalog.images_for_canonical_name("Apple").unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].url, "https://example.test/apple.jpg");

        let names = catalog
            .locale_common_names_for_canonical_name("Apple", "fr")
            .unwrap();
        assert_eq!(names[0].name, "Pommier");
    }

    #[test]
    fn detail_projection_hydrates_side_tables_and_translated_text() {
        let plant_db = detail_projection_test_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);

        let detail = catalog.detail_for_canonical_name("Apple", "fr").unwrap();

        assert_eq!(detail.common_name.as_deref(), Some("Pommier"));
        assert_eq!(detail.family.as_deref(), Some("Rosaceae"));
        assert_eq!(detail.growth_rate.as_deref(), Some("Lent"));
        assert_eq!(detail.flower_color.as_deref(), Some("Bleu/Violet"));
        assert_eq!(detail.is_perennial, Some(true));
        assert_eq!(detail.native_distribution.as_deref(), Some("Asia, Europe"));
        assert_eq!(detail.introduced_distribution.as_deref(), Some("Europe"));
        assert_eq!(detail.climate_zones.as_deref(), Some("Tempéré"));
        assert_eq!(detail.uses.len(), 1);
        assert_eq!(detail.uses[0].use_category, "Medicinal");
    }

    #[test]
    fn detail_projection_uses_english_common_names_for_english_locale_only() {
        let plant_db = detail_projection_test_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);

        let french_detail = catalog.detail_for_canonical_name("Plum", "fr").unwrap();
        let english_detail = catalog.detail_for_canonical_name("Plum", "en").unwrap();

        assert_eq!(french_detail.common_name, None);
        assert_eq!(english_detail.common_name.as_deref(), Some("Plum"));
    }

    #[test]
    fn habit_projection_reads_catalog_habits_through_the_reader_seam() {
        let plant_db = detail_projection_test_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        conn.execute("UPDATE species SET habit = 'Tree' WHERE id = 'sp-1'", [])
            .unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);

        let habits = catalog
            .habits_for_canonical_names(&["Apple".to_owned(), "Pear".to_owned()])
            .unwrap();

        assert_eq!(habits.len(), 1);
        assert_eq!(habits["Apple"], "Tree");
    }

    #[test]
    fn flower_color_projection_reads_direct_species_colors() {
        let plant_db = test_support::test_plant_db();
        let conn = crate::db::require_plant_db(&plant_db).unwrap();
        let catalog = SpeciesCatalogRead::new(&conn);
        let rows = catalog
            .flower_colors_for_canonical_names(&["Apple".to_owned(), "Pear".to_owned()])
            .unwrap();

        let apple = rows
            .iter()
            .find(|row| row.canonical_name == "Apple")
            .unwrap();
        assert_eq!(apple.flower_color.as_deref(), Some("White"));
        assert_eq!(apple.source, "species");
    }

    #[test]
    fn production_catalog_reader_requires_an_admitted_connection_guard() {
        let catalog_source = include_str!("species_catalog_read.rs");
        let search_source = include_str!("species_catalog_read/search.rs");
        let raw_constructor = ["pub(crate) fn new(conn: &'conn ", "Connection"].concat();

        assert!(catalog_source.contains("PlantDbConnectionGuard"));
        assert!(!catalog_source.contains(&raw_constructor));
        assert!(!search_source.contains("pub fn search("));
        assert!(search_source.contains("fn search_connection("));
    }

    fn detail_projection_test_db() -> crate::db::PlantDb {
        let conn = Connection::open_in_memory().unwrap();
        let mut species_columns = detail_projection::detail_projection_columns()
            .iter()
            .map(|column| (*column).to_owned())
            .collect::<Vec<_>>();
        species_columns.push("slug".to_owned());
        species_columns.sort();
        species_columns.dedup();
        conn.execute_batch(&format!(
            "CREATE TABLE species ({});
             CREATE TABLE best_common_names (
                 species_id TEXT NOT NULL,
                 language TEXT NOT NULL,
                 common_name TEXT NOT NULL,
                 PRIMARY KEY (species_id, language)
             );
             CREATE TABLE species_common_names (
                 id TEXT PRIMARY KEY,
	                 species_id TEXT NOT NULL,
	                 language TEXT NOT NULL,
	                 common_name TEXT NOT NULL,
	                 is_primary INTEGER DEFAULT 1,
	                 display_order INTEGER NOT NULL DEFAULT 0
	             );
             CREATE TABLE species_uses (
                 id TEXT PRIMARY KEY,
                 species_id TEXT NOT NULL,
                 use_category TEXT NOT NULL,
                 use_description TEXT
             );
	             CREATE TABLE translated_values (
                 id TEXT PRIMARY KEY,
                 field_name TEXT NOT NULL,
                 value_en TEXT NOT NULL,
                 value_fr TEXT
             );",
            species_columns.join(", ")
        ))
        .unwrap();

        conn.execute(
            "INSERT INTO species (
                 id, slug, canonical_name, common_name, family, growth_rate, flower_color,
                 is_perennial, native_distribution, introduced_distribution, climate_zones
             )
             VALUES (
                 'sp-1', 'apple', 'Apple', 'Apple fallback', 'Rosaceae', 'Slow', 'Blue/Purple',
                 1, '[\"Asia\", \"Europe\"]', 'Europe', '[\"Temperate\"]'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO species (id, slug, canonical_name)
             VALUES ('sp-2', 'pear', 'Pear')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO species (id, slug, canonical_name, common_name)
             VALUES ('sp-3', 'plum', 'Plum', 'Plum')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO best_common_names (species_id, language, common_name)
             VALUES ('sp-1', 'fr', 'Pommier')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO species_uses (id, species_id, use_category, use_description)
             VALUES ('use-1', 'sp-1', 'Medicinal', 'Tea')",
            [],
        )
        .unwrap();
        for (id, field, value_en, value_fr) in [
            ("t1", "growth_rate", "Slow", "Lent"),
            ("t2", "flower_color", "Blue", "Bleu"),
            ("t3", "flower_color", "Purple", "Violet"),
            ("t4", "climate_zone", "Temperate", "Tempéré"),
        ] {
            conn.execute(
                "INSERT INTO translated_values (id, field_name, value_en, value_fr)
                 VALUES (?1, ?2, ?3, ?4)",
                (id, field, value_en, value_fr),
            )
            .unwrap();
        }

        crate::db::plant_catalog_connection::stamp_expected_prepared_identity(&conn);
        crate::db::PlantDb::available(conn)
    }
}
