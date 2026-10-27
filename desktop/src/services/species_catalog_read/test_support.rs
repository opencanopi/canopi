use rusqlite::Connection;

use crate::db::{PlantDb, plant_catalog_connection};

#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
pub(crate) fn test_plant_db() -> PlantDb {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE species (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL,
            canonical_name TEXT NOT NULL,
            common_name TEXT,
            family TEXT,
            genus TEXT,
            growth_rate TEXT,
            width_max_m REAL,
            hardiness_zone_min INTEGER,
            hardiness_zone_max INTEGER,
            edibility_rating INTEGER,
            medicinal_rating INTEGER,
            stratum TEXT,
            habit TEXT,
            climate_zones TEXT DEFAULT '[]',
            is_annual INTEGER DEFAULT 0,
            is_biennial INTEGER DEFAULT 0,
            is_perennial INTEGER DEFAULT 0,
            height_max_m REAL,
            tolerates_full_sun INTEGER,
            tolerates_semi_shade INTEGER,
            tolerates_full_shade INTEGER,
            flower_color TEXT
        );
        CREATE VIRTUAL TABLE species_search_fts USING fts5(
            canonical_name,
            common_name,
            content='species',
            content_rowid='rowid'
        );
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
	        CREATE TABLE species_images (
	            id TEXT PRIMARY KEY,
	            species_id TEXT NOT NULL,
	            url TEXT NOT NULL,
	            sort_order INTEGER NOT NULL
	        );
	        ",
    )
    .unwrap();

    for (species_id, canonical_name, min, max, stratum, height) in [
        ("s1", "Apple", 4, 8, "canopy", 8.0_f32),
        ("s2", "Pear", 4, 8, "canopy", 7.0_f32),
        ("s3", "Plum", 4, 8, "canopy", 6.0_f32),
        ("s4", "Currant", 4, 8, "shrub", 1.5_f32),
        ("s5", "Quince", 5, 8, "canopy", 20.0_f32),
        ("s6", "Apricot", 6, 8, "canopy", 9.0_f32),
    ] {
        let slug = canonical_name.to_lowercase();
        let common_name = canonical_name;
        let family = if stratum == "shrub" {
            "Grossulariaceae"
        } else {
            "Rosaceae"
        };
        let genus = canonical_name.split(' ').next().unwrap_or(canonical_name);
        let width = height / 2.0;
        let flower_color = if canonical_name == "Apple" {
            Some("White")
        } else {
            None
        };
        conn.execute(
            "INSERT INTO species (
                id, slug, canonical_name, common_name, family, genus, growth_rate, width_max_m,
                hardiness_zone_min, hardiness_zone_max, edibility_rating, medicinal_rating,
                stratum, height_max_m, tolerates_full_sun, tolerates_semi_shade,
                tolerates_full_shade, flower_color
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Medium', ?7, ?8, ?9, 1, 0, ?10, ?11, 1, 0, 0, ?12)",
            (
                species_id,
                slug,
                canonical_name,
                common_name,
                family,
                genus,
                width,
                min,
                max,
                stratum,
                height,
                flower_color,
            ),
        )
        .unwrap();
    }

    for (species_id, language, common_name) in [
        ("s1", "en", "Apple"),
        ("s1", "fr", "Pommier"),
        ("s2", "en", "Pear"),
        ("s2", "fr", "Poirier"),
        ("s3", "en", "Plum"),
        ("s4", "en", "Currant"),
        ("s5", "en", "Quince"),
        ("s6", "en", "Apricot"),
    ] {
        conn.execute(
            "INSERT INTO best_common_names (species_id, language, common_name) VALUES (?1, ?2, ?3)",
            (species_id, language, common_name),
        )
        .unwrap();
    }

    for (id, species_id, language, common_name, is_primary) in [
        ("cn-1", "s1", "en", "Apple", 1),
        ("cn-2", "s1", "fr", "Pommier", 1),
        ("cn-3", "s1", "fr", "Pomme", 0),
        ("cn-4", "s2", "en", "Pear", 1),
        ("cn-5", "s2", "fr", "Poirier", 1),
        ("cn-6", "s3", "en", "Plum", 1),
        ("cn-7", "s4", "en", "Currant", 1),
        ("cn-8", "s5", "en", "Quince", 1),
        ("cn-9", "s6", "en", "Apricot", 1),
    ] {
        conn.execute(
            "INSERT INTO species_common_names (
                id, species_id, language, common_name, is_primary, display_order
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (
                id,
                species_id,
                language,
                common_name,
                is_primary,
                if is_primary == 0 { 1 } else { 0 },
            ),
        )
        .unwrap();
    }

    conn.execute(
        "INSERT INTO species_images (id, species_id, url, sort_order)
         VALUES ('img-1', 's1', 'https://example.test/apple.jpg', 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO species_search_fts(species_search_fts) VALUES('rebuild')",
        [],
    )
    .unwrap();

    plant_catalog_connection::stamp_expected_prepared_identity(&conn);
    PlantDb::available(conn)
}
