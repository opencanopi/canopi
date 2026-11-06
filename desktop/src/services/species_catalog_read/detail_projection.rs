use std::sync::OnceLock;

use canopi_types::species::SpeciesDetail;
use rusqlite::Connection;
use serde_json::Value;

use super::common_names::translate_composite_value;

const DETAIL_PROJECTION_COLUMNS: &[&str] = &[
    "id",
    "canonical_name",
    "common_name",
    "family",
    "genus",
    "taxonomic_order",
    "taxonomic_class",
    "is_hybrid",
    "match_confidence",
    "tnrs_taxonomic_status",
    "match_score",
    "enriched_at",
    "height_min_m",
    "height_max_m",
    "width_max_m",
    "hardiness_zone_min",
    "hardiness_zone_max",
    "age_of_maturity_years",
    "growth_rate",
    "is_annual",
    "is_biennial",
    "is_perennial",
    "lifespan",
    "deciduous_evergreen",
    "leaf_retention",
    "active_growth_period",
    "habit",
    "growth_form_type",
    "growth_form_shape",
    "growth_habit",
    "woody",
    "canopy_position",
    "resprout_ability",
    "coppice_potential",
    "bloom_period",
    "flower_color",
    "pollinators",
    "tolerates_full_sun",
    "tolerates_semi_shade",
    "tolerates_full_shade",
    "frost_tender",
    "frost_free_days_min",
    "drought_tolerance",
    "precip_min_inches",
    "precip_max_inches",
    "soil_ph_min",
    "soil_ph_max",
    "well_drained",
    "heavy_clay",
    "tolerates_light_soil",
    "tolerates_medium_soil",
    "tolerates_heavy_soil",
    "tolerates_acid",
    "tolerates_alkaline",
    "tolerates_saline",
    "tolerates_wind",
    "tolerates_pollution",
    "tolerates_nutritionally_poor",
    "fertility_requirement",
    "moisture_use",
    "anaerobic_tolerance",
    "root_depth_min_cm",
    "salinity_tolerance",
    "stratum",
    "succession_stage",
    "stratum_confidence",
    "succession_confidence",
    "nitrogen_fixer",
    "ecological_system",
    "mycorrhizal_type",
    "grime_strategy",
    "raunkiaer_life_form",
    "cn_ratio",
    "allelopathic",
    "root_system_type",
    "taproot_persistent",
    "edibility_rating",
    "medicinal_rating",
    "other_uses_rating",
    "attracts_wildlife",
    "scented",
    "propagated_by_seed",
    "propagated_by_cuttings",
    "propagated_by_bare_root",
    "propagated_by_container",
    "propagated_by_sprigs",
    "propagated_by_bulb",
    "propagated_by_sod",
    "propagated_by_tubers",
    "propagated_by_corm",
    "cold_stratification_required",
    "vegetative_spread_rate",
    "seed_spread_rate",
    "propagation_method",
    "sowing_period",
    "harvest_period",
    "dormancy_conditions",
    "management_types",
    "fruit_type",
    "fruit_seed_color",
    "fruit_seed_period_begin",
    "fruit_seed_period_end",
    "fruit_seed_abundance",
    "fruit_seed_persistence",
    "seed_mass_mg",
    "seed_length_mm",
    "seed_germination_rate",
    "seed_dispersal_mechanism",
    "seed_storage_behaviour",
    "seed_dormancy_type",
    "seed_dormancy_depth",
    "serotinous",
    "seedbank_type",
    "leaf_type",
    "leaf_compoundness",
    "leaf_shape",
    "sla_mm2_mg",
    "ldmc_g_g",
    "leaf_nitrogen_mg_g",
    "leaf_carbon_mg_g",
    "leaf_phosphorus_mg_g",
    "leaf_dry_mass_mg",
    "pollination_syndrome",
    "sexual_system",
    "mating_system",
    "self_fertile",
    "reproductive_type",
    "clonal_growth_form",
    "storage_organ",
    "toxicity",
    "invasive_potential",
    "biogeographic_status",
    "noxious_status",
    "invasive_usda",
    "weed_potential",
    "fire_resistant",
    "fire_tolerance",
    "hedge_tolerance",
    "native_distribution",
    "introduced_distribution",
    "climate_zones",
    "conservation_status",
    "image_urls",
    "ellenberg_light",
    "ellenberg_temperature",
    "ellenberg_moisture",
    "ellenberg_reaction",
    "ellenberg_nitrogen",
    "ellenberg_salt",
    "overall_confidence",
    "data_quality_tier",
    "wood_density_g_cm3",
    "photosynthesis_pathway",
];

const TRANSLATED_DETAIL_TEXT_FIELDS: &[&str] = &[
    "growth_rate",
    "deciduous_evergreen",
    "drought_tolerance",
    "stratum",
    "succession_stage",
    "habit",
    "bloom_period",
    "flower_color",
    "active_growth_period",
    "lifespan",
    "toxicity",
    "anaerobic_tolerance",
    "canopy_position",
    "cn_ratio",
    "ecological_system",
    "fertility_requirement",
    "fire_tolerance",
    "fruit_seed_abundance",
    "grime_strategy",
    "growth_form_type",
    "growth_habit",
    "hedge_tolerance",
    "invasive_potential",
    "biogeographic_status",
    "leaf_compoundness",
    "leaf_shape",
    "leaf_type",
    "moisture_use",
    "mycorrhizal_type",
    "pollination_syndrome",
    "raunkiaer_life_form",
    "reproductive_type",
    "root_system_type",
    "salinity_tolerance",
    "seed_dispersal_mechanism",
    "seed_dormancy_type",
    "seed_dormancy_depth",
    "seed_spread_rate",
    "seed_storage_behaviour",
    "seedbank_type",
    "sexual_system",
    "storage_organ",
    "vegetative_spread_rate",
    "data_quality_tier",
    "photosynthesis_pathway",
    "clonal_growth_form",
    "mating_system",
    "conservation_status",
    "fruit_type",
    "fruit_seed_color",
    "fruit_seed_period_begin",
    "fruit_seed_period_end",
    "growth_form_shape",
    "propagation_method",
    "sowing_period",
    "harvest_period",
    "dormancy_conditions",
    "management_types",
    "pollinators",
];

static DETAIL_QUERY_SQL: OnceLock<String> = OnceLock::new();

pub(super) fn detail_projection_columns() -> &'static [&'static str] {
    DETAIL_PROJECTION_COLUMNS
}

pub(super) fn translated_detail_text_fields() -> &'static [&'static str] {
    TRANSLATED_DETAIL_TEXT_FIELDS
}

pub(super) fn translate_projected_text_fields(
    conn: &Connection,
    detail: &mut SpeciesDetail,
    locale: &str,
) -> Result<(), String> {
    let mut value = serde_json::to_value(&*detail)
        .map_err(|e| format!("Failed to prepare species detail translations: {e}"))?;
    let Some(object) = value.as_object_mut() else {
        return Err(
            "Failed to prepare species detail translations: detail was not an object".into(),
        );
    };

    for field in translated_detail_text_fields() {
        let Some(current) = object.get_mut(*field) else {
            debug_assert!(
                false,
                "translated field '{field}' is missing from SpeciesDetail"
            );
            continue;
        };
        let Some(text) = current.as_str() else {
            continue;
        };
        let translated = translate_composite_value(conn, field, text, locale);
        *current = Value::String(translated);
    }

    *detail = serde_json::from_value(value)
        .map_err(|e| format!("Failed to apply species detail translations: {e}"))?;
    Ok(())
}

pub(super) fn detail_query_sql() -> &'static str {
    DETAIL_QUERY_SQL
        .get_or_init(|| {
            let select = detail_projection_columns()
                .iter()
                .map(|column| format!("s.{column} AS {column}"))
                .collect::<Vec<_>>()
                .join(",\n                    ");
            format!(
                "SELECT {select}
             FROM species s
             WHERE s.canonical_name = ?1
             LIMIT 1"
            )
        })
        .as_str()
}

#[cfg(test)]
mod tests {
    use super::{detail_projection_columns, translated_detail_text_fields};
    use crate::db::test_support::load_schema_contract_fixture;
    use std::collections::HashSet;

    #[test]
    fn test_detail_projection_columns_exist_in_contract() {
        let contract = load_schema_contract_fixture();
        let contract_columns: HashSet<String> = contract
            .columns
            .into_iter()
            .map(|column| column.name)
            .collect();

        for column in detail_projection_columns() {
            assert!(
                contract_columns.contains(*column),
                "detail projection column '{column}' missing from schema contract"
            );
        }
    }

    #[test]
    fn translated_detail_fields_are_projected_columns() {
        let columns: HashSet<&str> = detail_projection_columns().iter().copied().collect();

        for field in translated_detail_text_fields() {
            assert!(
                columns.contains(field),
                "translated detail field '{field}' is not selected by the projection"
            );
        }
    }
}
