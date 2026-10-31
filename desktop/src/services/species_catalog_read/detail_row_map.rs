use common_types::species::SpeciesDetail;
use rusqlite::{Row, types::FromSql};

struct DetailCursor<'row, 'stmt> {
    row: &'row Row<'stmt>,
}

impl<'row, 'stmt> DetailCursor<'row, 'stmt> {
    fn new(row: &'row Row<'stmt>) -> Self {
        Self { row }
    }

    fn read<T: FromSql>(&self, column: &'static str) -> rusqlite::Result<T> {
        self.row.get(column)
    }

    fn read_bool(&self, column: &'static str) -> rusqlite::Result<Option<bool>> {
        self.read::<Option<i32>>(column)
            .map(|value| value.map(|v| v != 0))
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "ratcheted before 2.1-M188; split when this function next changes"
)]
pub(super) fn map_detail_row(row: &Row<'_>) -> rusqlite::Result<(String, SpeciesDetail)> {
    let cursor = DetailCursor::new(row);

    let species_id: String = cursor.read("id")?;
    let canonical_name = cursor.read("canonical_name")?;
    let fallback_common = cursor.read("common_name")?;

    let detail = SpeciesDetail {
        canonical_name,
        common_name: fallback_common,
        family: cursor.read("family")?,
        genus: cursor.read("genus")?,
        taxonomic_order: cursor.read("taxonomic_order")?,
        taxonomic_class: cursor.read("taxonomic_class")?,
        is_hybrid: cursor.read_bool("is_hybrid")?,
        match_confidence: cursor.read("match_confidence")?,
        tnrs_taxonomic_status: cursor.read("tnrs_taxonomic_status")?,
        match_score: cursor.read("match_score")?,
        enriched_at: cursor.read("enriched_at")?,
        height_min_m: cursor.read("height_min_m")?,
        height_max_m: cursor.read("height_max_m")?,
        width_max_m: cursor.read("width_max_m")?,
        hardiness_zone_min: cursor.read("hardiness_zone_min")?,
        hardiness_zone_max: cursor.read("hardiness_zone_max")?,
        age_of_maturity_years: cursor.read("age_of_maturity_years")?,
        growth_rate: cursor.read("growth_rate")?,
        is_annual: cursor.read_bool("is_annual")?,
        is_biennial: cursor.read_bool("is_biennial")?,
        is_perennial: cursor.read_bool("is_perennial")?,
        lifespan: cursor.read("lifespan")?,
        deciduous_evergreen: cursor.read("deciduous_evergreen")?,
        leaf_retention: cursor.read_bool("leaf_retention")?,
        active_growth_period: cursor.read("active_growth_period")?,
        habit: cursor.read("habit")?,
        growth_form_type: cursor.read("growth_form_type")?,
        growth_form_shape: cursor.read("growth_form_shape")?,
        growth_habit: cursor.read("growth_habit")?,
        woody: cursor.read_bool("woody")?,
        canopy_position: cursor.read("canopy_position")?,
        resprout_ability: cursor.read_bool("resprout_ability")?,
        coppice_potential: cursor.read_bool("coppice_potential")?,
        bloom_period: cursor.read("bloom_period")?,
        flower_color: cursor.read("flower_color")?,
        pollinators: cursor.read("pollinators")?,
        tolerates_full_sun: cursor.read_bool("tolerates_full_sun")?,
        tolerates_semi_shade: cursor.read_bool("tolerates_semi_shade")?,
        tolerates_full_shade: cursor.read_bool("tolerates_full_shade")?,
        frost_tender: cursor.read_bool("frost_tender")?,
        frost_free_days_min: cursor.read("frost_free_days_min")?,
        drought_tolerance: cursor.read("drought_tolerance")?,
        precip_min_inches: cursor.read("precip_min_inches")?,
        precip_max_inches: cursor.read("precip_max_inches")?,
        soil_ph_min: cursor.read("soil_ph_min")?,
        soil_ph_max: cursor.read("soil_ph_max")?,
        well_drained: cursor.read_bool("well_drained")?,
        heavy_clay: cursor.read_bool("heavy_clay")?,
        tolerates_light_soil: cursor.read_bool("tolerates_light_soil")?,
        tolerates_medium_soil: cursor.read_bool("tolerates_medium_soil")?,
        tolerates_heavy_soil: cursor.read_bool("tolerates_heavy_soil")?,
        tolerates_acid: cursor.read_bool("tolerates_acid")?,
        tolerates_alkaline: cursor.read_bool("tolerates_alkaline")?,
        tolerates_saline: cursor.read_bool("tolerates_saline")?,
        tolerates_wind: cursor.read_bool("tolerates_wind")?,
        tolerates_pollution: cursor.read_bool("tolerates_pollution")?,
        tolerates_nutritionally_poor: cursor.read_bool("tolerates_nutritionally_poor")?,
        fertility_requirement: cursor.read("fertility_requirement")?,
        moisture_use: cursor.read("moisture_use")?,
        anaerobic_tolerance: cursor.read("anaerobic_tolerance")?,
        root_depth_min_cm: cursor.read("root_depth_min_cm")?,
        salinity_tolerance: cursor.read("salinity_tolerance")?,
        stratum: cursor.read("stratum")?,
        succession_stage: cursor.read("succession_stage")?,
        stratum_confidence: cursor.read("stratum_confidence")?,
        succession_confidence: cursor.read("succession_confidence")?,
        nitrogen_fixer: cursor.read_bool("nitrogen_fixer")?,
        ecological_system: cursor.read("ecological_system")?,
        mycorrhizal_type: cursor.read("mycorrhizal_type")?,
        grime_strategy: cursor.read("grime_strategy")?,
        raunkiaer_life_form: cursor.read("raunkiaer_life_form")?,
        cn_ratio: cursor.read("cn_ratio")?,
        allelopathic: cursor.read_bool("allelopathic")?,
        root_system_type: cursor.read("root_system_type")?,
        taproot_persistent: cursor.read_bool("taproot_persistent")?,
        edibility_rating: cursor.read("edibility_rating")?,
        medicinal_rating: cursor.read("medicinal_rating")?,
        other_uses_rating: cursor.read("other_uses_rating")?,
        attracts_wildlife: cursor.read_bool("attracts_wildlife")?,
        scented: cursor.read_bool("scented")?,
        uses: vec![],
        propagated_by_seed: cursor.read_bool("propagated_by_seed")?,
        propagated_by_cuttings: cursor.read_bool("propagated_by_cuttings")?,
        propagated_by_bare_root: cursor.read_bool("propagated_by_bare_root")?,
        propagated_by_container: cursor.read_bool("propagated_by_container")?,
        propagated_by_sprigs: cursor.read_bool("propagated_by_sprigs")?,
        propagated_by_bulb: cursor.read_bool("propagated_by_bulb")?,
        propagated_by_sod: cursor.read_bool("propagated_by_sod")?,
        propagated_by_tubers: cursor.read_bool("propagated_by_tubers")?,
        propagated_by_corm: cursor.read_bool("propagated_by_corm")?,
        cold_stratification_required: cursor.read_bool("cold_stratification_required")?,
        vegetative_spread_rate: cursor.read("vegetative_spread_rate")?,
        seed_spread_rate: cursor.read("seed_spread_rate")?,
        propagation_method: cursor.read("propagation_method")?,
        sowing_period: cursor.read("sowing_period")?,
        harvest_period: cursor.read("harvest_period")?,
        dormancy_conditions: cursor.read("dormancy_conditions")?,
        management_types: cursor.read("management_types")?,
        fruit_type: cursor.read("fruit_type")?,
        fruit_seed_color: cursor.read("fruit_seed_color")?,
        fruit_seed_period_begin: cursor.read("fruit_seed_period_begin")?,
        fruit_seed_period_end: cursor.read("fruit_seed_period_end")?,
        fruit_seed_abundance: cursor.read("fruit_seed_abundance")?,
        fruit_seed_persistence: cursor.read_bool("fruit_seed_persistence")?,
        seed_mass_mg: cursor.read("seed_mass_mg")?,
        seed_length_mm: cursor.read("seed_length_mm")?,
        seed_germination_rate: cursor.read("seed_germination_rate")?,
        seed_dispersal_mechanism: cursor.read("seed_dispersal_mechanism")?,
        seed_storage_behaviour: cursor.read("seed_storage_behaviour")?,
        seed_dormancy_type: cursor.read("seed_dormancy_type")?,
        seed_dormancy_depth: cursor.read("seed_dormancy_depth")?,
        serotinous: cursor.read_bool("serotinous")?,
        seedbank_type: cursor.read("seedbank_type")?,
        leaf_type: cursor.read("leaf_type")?,
        leaf_compoundness: cursor.read("leaf_compoundness")?,
        leaf_shape: cursor.read("leaf_shape")?,
        sla_mm2_mg: cursor.read("sla_mm2_mg")?,
        ldmc_g_g: cursor.read("ldmc_g_g")?,
        leaf_nitrogen_mg_g: cursor.read("leaf_nitrogen_mg_g")?,
        leaf_carbon_mg_g: cursor.read("leaf_carbon_mg_g")?,
        leaf_phosphorus_mg_g: cursor.read("leaf_phosphorus_mg_g")?,
        leaf_dry_mass_mg: cursor.read("leaf_dry_mass_mg")?,
        pollination_syndrome: cursor.read("pollination_syndrome")?,
        sexual_system: cursor.read("sexual_system")?,
        mating_system: cursor.read("mating_system")?,
        self_fertile: cursor.read_bool("self_fertile")?,
        reproductive_type: cursor.read("reproductive_type")?,
        clonal_growth_form: cursor.read("clonal_growth_form")?,
        storage_organ: cursor.read("storage_organ")?,
        toxicity: cursor.read("toxicity")?,
        invasive_potential: cursor.read("invasive_potential")?,
        biogeographic_status: cursor.read("biogeographic_status")?,
        noxious_status: cursor.read_bool("noxious_status")?,
        invasive_usda: cursor.read_bool("invasive_usda")?,
        weed_potential: cursor.read_bool("weed_potential")?,
        fire_resistant: cursor.read_bool("fire_resistant")?,
        fire_tolerance: cursor.read("fire_tolerance")?,
        hedge_tolerance: cursor.read("hedge_tolerance")?,
        native_distribution: cursor.read("native_distribution")?,
        introduced_distribution: cursor.read("introduced_distribution")?,
        climate_zones: cursor.read("climate_zones")?,
        conservation_status: cursor.read("conservation_status")?,
        image_urls: cursor.read("image_urls")?,
        ellenberg_light: cursor.read("ellenberg_light")?,
        ellenberg_temperature: cursor.read("ellenberg_temperature")?,
        ellenberg_moisture: cursor.read("ellenberg_moisture")?,
        ellenberg_reaction: cursor.read("ellenberg_reaction")?,
        ellenberg_nitrogen: cursor.read("ellenberg_nitrogen")?,
        ellenberg_salt: cursor.read("ellenberg_salt")?,
        overall_confidence: cursor.read("overall_confidence")?,
        data_quality_tier: cursor.read("data_quality_tier")?,
        wood_density_g_cm3: cursor.read("wood_density_g_cm3")?,
        photosynthesis_pathway: cursor.read("photosynthesis_pathway")?,
    };

    Ok((species_id, detail))
}

#[cfg(test)]
mod tests {
    use super::super::detail_projection::detail_projection_columns;
    use super::map_detail_row;
    use rusqlite::Connection;

    #[test]
    fn maps_detail_rows_by_column_name_not_select_order() {
        let select = detail_projection_columns()
            .iter()
            .rev()
            .map(|column| match *column {
                "id" => "'sp-1' AS id".to_owned(),
                "canonical_name" => "'Malus domestica' AS canonical_name".to_owned(),
                "common_name" => "'Apple' AS common_name".to_owned(),
                "height_max_m" => "4.0 AS height_max_m".to_owned(),
                "is_perennial" => "1 AS is_perennial".to_owned(),
                _ => format!("NULL AS {column}"),
            })
            .collect::<Vec<_>>()
            .join(", ");
        let conn = Connection::open_in_memory().unwrap();
        let mut stmt = conn.prepare(&format!("SELECT {select}")).unwrap();

        let (species_id, detail) = stmt.query_row([], map_detail_row).unwrap();

        assert_eq!(species_id, "sp-1");
        assert_eq!(detail.canonical_name, "Malus domestica");
        assert_eq!(detail.common_name.as_deref(), Some("Apple"));
        assert_eq!(detail.height_max_m, Some(4.0));
        assert_eq!(detail.is_perennial, Some(true));
    }
}
