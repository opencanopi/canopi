mod builder;
mod columns;
mod cursor;
mod filters;
mod pagination;
mod predicates;
mod projection;
mod relevance;
mod species_catalog_filters;
mod sql;
mod text;

pub(crate) use crate::db::plant_filter_fields::{PlantFilterFieldKind, filter_field_kind};
pub use builder::{SpeciesSearchPlan, SpeciesSearchPlanRequest};
pub(crate) use columns::validated_column;
#[cfg(test)]
use cursor::{decode_cursor, encode_cursor};
#[cfg(test)]
use pagination::BrowseKeyValue;
pub use pagination::BrowsePosition;
pub(crate) use projection::{species_list_common_name_join_sql, species_list_select_sql};

#[cfg(test)]
mod tests {
    use super::*;
    use canopi_types::species::{
        DynamicFilter, FilterOp, Sort, SpeciesFilter, SpeciesListItem, SpeciesSearchRequest,
    };
    use rusqlite::types::Value;
    use std::collections::BTreeSet;

    fn default_filter() -> SpeciesFilter {
        SpeciesFilter::default()
    }

    fn request(
        text: Option<&str>,
        filters: SpeciesFilter,
        cursor: Option<String>,
        sort: Sort,
        limit: u32,
        include_total: bool,
    ) -> SpeciesSearchPlanRequest {
        SpeciesSearchPlanRequest {
            search: SpeciesSearchRequest {
                text: text.unwrap_or("").to_owned(),
                filters,
                cursor,
                sort,
                limit,
                include_total,
                locale: "en".to_owned(),
            },
            use_common_name_token_index: true,
            use_search_name_entry_index: false,
        }
    }

    fn list_item(canonical_name: &str) -> SpeciesListItem {
        SpeciesListItem {
            canonical_name: canonical_name.to_owned(),
            slug: canonical_name.to_lowercase().replace(' ', "-"),
            common_name: None,
            common_name_2: None,
            matched_common_name: None,
            is_name_fallback: false,
            family: None,
            genus: None,
            height_max_m: None,
            hardiness_zone_min: None,
            hardiness_zone_max: None,
            growth_rate: None,
            stratum: None,
            habit: None,
            climate_zones: Vec::new(),
            life_cycles: Vec::new(),
            edibility_rating: None,
            medicinal_rating: None,
            width_max_m: None,
            is_favorite: false,
        }
    }

    fn normalized_main_where(sql: &str) -> String {
        let main_from = sql.find("FROM species s").expect("main species FROM");
        let scoped = &sql[main_from..];
        let where_start = scoped.find("WHERE ").expect("main WHERE") + "WHERE ".len();
        let tail = &scoped[where_start..];
        let where_end = tail.find("ORDER BY").unwrap_or(tail.len());
        normalize_placeholders(&tail[..where_end])
    }

    fn normalize_placeholders(fragment: &str) -> String {
        let mut normalized = String::new();
        let mut chars = fragment.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '?' {
                normalized.push('?');
                while chars.peek().is_some_and(|next| next.is_ascii_digit()) {
                    chars.next();
                }
            } else if ch.is_whitespace() {
                if !normalized.ends_with(' ') {
                    normalized.push(' ');
                }
            } else {
                normalized.push(ch);
            }
        }
        normalized.trim().to_owned()
    }

    fn placeholder_numbers(sql: &str) -> BTreeSet<usize> {
        let mut placeholders = BTreeSet::new();
        let mut chars = sql.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch != '?' {
                continue;
            }

            let mut number = String::new();
            while chars.peek().is_some_and(|next| next.is_ascii_digit()) {
                number.push(chars.next().unwrap());
            }

            assert!(
                !number.is_empty(),
                "expected numbered placeholder in SQL:\n{sql}"
            );
            placeholders.insert(number.parse().expect("placeholder number"));
        }
        placeholders
    }

    fn assert_dense_statement_placeholders(statement: &builder::SqlStatementPlan) {
        let placeholders = placeholder_numbers(statement.sql());
        let expected: BTreeSet<usize> = (1..=statement.params().len()).collect();

        assert_eq!(
            placeholders,
            expected,
            "SQL placeholders should be dense and match params:\n{}\nparams: {:?}",
            statement.sql(),
            statement.params()
        );
    }

    #[test]
    fn test_cursor_round_trip() {
        let encoded = encode_cursor(1, Some("7.5"), "Lavandula angustifolia");
        let decoded = decode_cursor(&encoded).unwrap();
        assert_eq!(decoded.0, 1);
        assert_eq!(decoded.1.as_deref(), Some("7.5"));
        assert_eq!(decoded.2, "Lavandula angustifolia");

        let name_only = decode_cursor(&encode_cursor(0, None, "Acer rubrum")).unwrap();
        assert_eq!(name_only, (0, None, "Acer rubrum".to_owned()));
    }

    #[test]
    fn test_cursor_invalid_returns_none() {
        assert!(decode_cursor("not-valid-base64!!!").is_none());
    }

    #[test]
    fn test_empty_query_produces_valid_sql() {
        let plan =
            SpeciesSearchPlan::build(request(None, default_filter(), None, Sort::Name, 20, false));
        let sql = plan.list().sql();
        let params = plan.list().params();
        assert!(sql.contains("FROM species s"));
        assert!(!sql.contains("species_search_fts"));
        // locale param + limit param
        assert_eq!(params.len(), 2);
        assert!(plan.count().is_none());
    }

    #[test]
    fn test_search_plans_keep_placeholders_dense_with_params() {
        let mut filters = default_filter();
        filters.family = Some("Lamiaceae".to_owned());
        filters.climate_zones = Some(vec!["Temperate".to_owned(), "Boreal".to_owned()]);
        filters.extra = Some(vec![
            DynamicFilter {
                field: "growth_form_type".to_owned(),
                op: FilterOp::In,
                values: vec!["Tree".to_owned(), "Shrub".to_owned()],
            },
            DynamicFilter {
                field: "height_max_m".to_owned(),
                op: FilterOp::Between,
                values: vec!["1".to_owned(), "8".to_owned()],
            },
        ]);

        let mut relevance_request = request(
            Some("lin commun"),
            filters.clone(),
            Some("offset:40".to_owned()),
            Sort::Relevance,
            20,
            true,
        );
        relevance_request.search.locale = "fr".to_owned();
        let relevance_plan = SpeciesSearchPlan::build(relevance_request);
        assert_dense_statement_placeholders(relevance_plan.list());
        assert_dense_statement_placeholders(relevance_plan.count().unwrap());

        let keyset_plan = SpeciesSearchPlan::build(request(
            None,
            filters,
            Some(encode_cursor(0, Some("4.5"), "Vaccinium corymbosum")),
            Sort::Height,
            20,
            false,
        ));
        assert_dense_statement_placeholders(keyset_plan.list());
    }

    #[test]
    fn test_text_search_includes_fts_join() {
        let plan = SpeciesSearchPlan::build(request(
            Some("lavender"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        ));
        let sql = plan.list().sql();
        assert!(sql.contains("species_search_fts"));
        assert!(sql.contains("species_search_fts MATCH"));
    }

    #[test]
    fn test_fts_search_term_has_prefix_wildcard() {
        let plan = SpeciesSearchPlan::build(request(
            Some("lav"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        ));
        let params = plan.list().params();
        assert!(
            params.iter().any(|param| matches!(
                param,
                Value::Text(value)
                    if value == "{canonical_name family_genus uses_text other_text}: lav*"
            )),
            "expected FTS prefix wildcard in params, got {params:?}"
        );
    }

    #[test]
    fn test_nitrogen_fixer_true_filter() {
        let mut f = default_filter();
        f.nitrogen_fixer = Some(true);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, false));
        let sql = plan.list().sql();
        assert!(sql.contains("nitrogen_fixer = 1"));
    }

    #[test]
    fn test_nitrogen_fixer_false_is_noop() {
        let mut f = default_filter();
        f.nitrogen_fixer = Some(false);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, false));
        let sql = plan.list().sql();
        assert!(!sql.contains("nitrogen_fixer"));
    }

    #[test]
    fn test_life_cycle_filter_maps_to_boolean_columns() {
        let mut f = default_filter();
        f.life_cycle = Some(vec!["Annual".to_owned(), "Perennial".to_owned()]);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, false));
        let sql = plan.list().sql();
        assert!(sql.contains("is_annual = 1"));
        assert!(sql.contains("is_perennial = 1"));
        assert!(sql.contains(" OR "));
    }

    #[test]
    fn test_life_cycle_filter_unknown_values_are_noop() {
        let mut f = default_filter();
        f.life_cycle = Some(vec!["Unknown".to_owned()]);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, false));
        let sql = plan.list().sql();

        assert!(!sql.contains("is_annual = 1"));
        assert!(!sql.contains("is_biennial = 1"));
        assert!(!sql.contains("is_perennial = 1"));
    }

    #[test]
    fn test_climate_zone_filter_maps_to_junction_subquery() {
        let mut f = default_filter();
        f.climate_zones = Some(vec!["Temperate".to_owned(), "Boreal".to_owned()]);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, false));
        let sql = plan.list().sql();
        let params = plan.list().params();

        assert!(sql.contains("species_climate_zones cz"));
        assert!(sql.contains("cz.climate_zone IN (?"));
        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "Temperate"))
        );
        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "Boreal"))
        );
    }

    #[test]
    fn test_schema_backed_strip_filters_use_generated_columns() {
        let mut f = default_filter();
        f.habit = Some(vec!["Tree".to_owned()]);
        f.woody = Some(true);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, false));
        let sql = plan.list().sql();

        assert!(sql.contains(validated_column("habit").unwrap()));
        assert!(sql.contains(validated_column("woody").unwrap()));
    }

    #[test]
    fn test_edible_filter() {
        let mut f = default_filter();
        f.edible = Some(true);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, false));
        let sql = plan.list().sql();
        assert!(sql.contains("edibility_rating > 0"));
    }

    #[test]
    fn test_soil_tolerances_filter_uses_boolean_columns() {
        let mut f = default_filter();
        f.soil_tolerances = Some(vec!["light".to_owned(), "heavy_clay".to_owned()]);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, false));
        let sql = plan.list().sql();
        assert!(sql.contains("tolerates_light_soil = 1"));
        assert!(sql.contains("heavy_clay = 1"));
        assert!(sql.contains(" OR "));
    }

    #[test]
    fn test_cursor_clause_name_sort() {
        let cursor = encode_cursor(0, None, "Lavandula angustifolia");
        let plan = SpeciesSearchPlan::build(request(
            None,
            default_filter(),
            Some(cursor),
            Sort::Name,
            20,
            false,
        ));
        let sql = plan.list().sql();
        assert!(sql.contains("s.canonical_name >"));
    }

    #[test]
    fn test_limit_is_incremented_by_one() {
        let plan =
            SpeciesSearchPlan::build(request(None, default_filter(), None, Sort::Name, 20, false));
        let limit_val = match plan.list().params().last().unwrap() {
            Value::Integer(n) => n.to_owned(),
            _ => panic!("expected integer limit"),
        };
        assert_eq!(limit_val, 21);
    }

    #[test]
    fn test_newly_exposed_filter_fields_are_allowlisted() {
        for field in [
            "tolerates_nutritionally_poor",
            "raunkiaer_life_form",
            "photosynthesis_pathway",
            "ellenberg_light",
            "ellenberg_temperature",
            "ellenberg_moisture",
            "ellenberg_reaction",
            "ellenberg_nitrogen",
            "ellenberg_salt",
            "mating_system",
            "clonal_growth_form",
            "storage_organ",
        ] {
            assert!(
                validated_column(field).is_some(),
                "expected '{field}' to be allowlisted for dynamic filters"
            );
        }
    }

    #[test]
    fn test_relevance_sort_uses_offset_pagination() {
        let plan = SpeciesSearchPlan::build(request(
            Some("lavender"),
            default_filter(),
            Some("offset:50".to_owned()),
            Sort::Relevance,
            20,
            false,
        ));
        let sql = plan.list().sql();
        let params = plan.list().params();
        assert!(sql.contains("ORDER BY CASE"));
        assert!(sql.contains("bm25("));
        assert!(sql.contains("OFFSET ?"));
        assert!(!sql.contains("s.canonical_name >"));
        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Integer(value) if *value == 50)),
            "expected integer offset in params, got {params:?}"
        );

        let items = vec![list_item("Lavandula alpha"), list_item("Lavandula beta")];
        assert_eq!(
            plan.next_cursor(&items, None, true).as_deref(),
            Some("offset:52")
        );
        assert_eq!(plan.next_cursor(&items, None, false), None);
    }

    #[test]
    fn test_relevance_sort_prefers_active_locale_common_name_whole_token() {
        let plan = SpeciesSearchPlan::build(request(
            Some("lin"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        ));
        let sql = plan.list().sql();
        let params = plan.list().params();

        assert!(sql.contains("FROM species_search_common_name_tokens"));
        assert!(sql.contains("MIN(first_token_position) AS first_token_position"));
        assert!(sql.contains("language = ?1"));
        assert!(sql.contains("token LIKE ?"));
        assert!(sql.contains("GROUP BY species_id"));
        assert!(sql.contains(") scnt0 ON scnt0.species_id = s.id"));
        assert!(sql.contains("scnt0.species_id IS NOT NULL"));
        assert!(sql.contains("ORDER BY CASE"));
        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "lin%"))
        );
    }

    #[test]
    fn test_multi_word_relevance_sort_adds_phrase_and_all_token_tiers() {
        let plan = SpeciesSearchPlan::build(request(
            Some("lin commun"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        ));
        let sql = plan.list().sql();
        let params = plan.list().params();

        assert!(sql.contains("FROM species_search_common_name_tokens"));
        assert!(sql.contains(") scnt0 ON scnt0.species_id = s.id"));
        assert!(sql.contains(") scnt1 ON scnt1.species_id = s.id"));
        assert!(sql.contains("species_common_names scn_match"));
        assert!(sql.contains("matched_common_name"));
        assert!(sql.contains("scnt0.species_id IS NOT NULL AND scnt1.species_id IS NOT NULL"));
        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "lin%"))
        );
        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "commun%"))
        );
        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "lin commun"))
        );
    }

    #[test]
    fn test_relevance_sort_does_not_add_fallback_language_tiers() {
        let mut request = request(
            Some("lin"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        );
        request.search.locale = "fr".to_owned();
        let plan = SpeciesSearchPlan::build(request);
        let sql = plan.list().sql();

        assert!(sql.contains("FROM species_search_common_name_tokens"));
        assert!(sql.contains(") scnt0 ON scnt0.species_id = s.id"));
        assert!(sql.contains("scnt0.species_id IS NOT NULL"));
        assert!(!sql.contains("scnt_fb"));
        assert!(!sql.contains("bcn_en"));
    }

    #[test]
    fn test_common_name_token_query_normalizes_diacritics() {
        let plan = SpeciesSearchPlan::build(request(
            Some("lin léon"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        ));
        let params = plan.list().params();

        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "lin%"))
        );
        assert!(
            params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "leon%"))
        );
        assert!(
            !params
                .iter()
                .any(|param| matches!(param, Value::Text(value) if value == "léon"))
        );
    }

    #[test]
    fn test_common_name_token_query_uses_index_tokenization_rules() {
        let plan = SpeciesSearchPlan::build(request(
            Some("Carleton's soap/pod Edelweiß"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        ));
        let sql = plan.list().sql();
        let params = plan.list().params();

        assert!(sql.contains("FROM species_search_common_name_tokens"));
        assert!(sql.contains(") scnt0 ON scnt0.species_id = s.id"));
        assert!(sql.contains(") scnt3 ON scnt3.species_id = s.id"));
        assert!(!sql.contains(") scnt4 ON scnt4.species_id = s.id"));
        for expected_token in ["carleton%", "soap%", "pod%", "edelweiss%"] {
            assert!(
                params
                    .iter()
                    .any(|param| matches!(param, Value::Text(value) if value == expected_token)),
                "expected indexed Common Name token {expected_token:?} in params, got {params:?}"
            );
        }
        for raw_token in ["carleton's", "s%", "soap/pod"] {
            assert!(
                !params
                    .iter()
                    .any(|param| matches!(param, Value::Text(value) if value == raw_token)),
                "unexpected raw Common Name token {raw_token:?} in params: {params:?}"
            );
        }
    }

    #[test]
    fn test_common_name_token_query_matches_nfkd_without_ascii_transliteration() {
        let plan = SpeciesSearchPlan::build(request(
            Some("Cœur Smørrebrød Æble Łódź Ðe"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        ));
        let params = plan.list().params();

        for expected_token in ["cœur%", "smørrebrød%", "æble%", "łodz%", "ðe%"] {
            assert!(
                params
                    .iter()
                    .any(|param| matches!(param, Value::Text(value) if value == expected_token)),
                "expected indexed Common Name token {expected_token:?} in params, got {params:?}"
            );
        }
    }

    #[test]
    fn test_fts_query_uses_shared_normalized_tokens() {
        let plan = SpeciesSearchPlan::build(request(
            Some("Straße"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        ));

        assert!(plan.list().params().iter().any(|param| {
            matches!(
                param,
                Value::Text(value)
                    if value == "{canonical_name family_genus uses_text other_text}: strasse*"
            )
        }));
    }

    #[test]
    fn test_species_search_normalization_corpus_matches_query_tokens() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../canopi-types/species-search-normalization.json"
        ))
        .unwrap();

        for case in corpus["corpus"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let expected = case["query_tokens"]
                .as_array()
                .unwrap()
                .iter()
                .map(|token| {
                    let token = token.as_str().unwrap();
                    format!("{}%", sql::escape_like_literal(token))
                })
                .collect::<Vec<_>>();
            let plan = SpeciesSearchPlan::build(request(
                Some(input),
                default_filter(),
                None,
                Sort::Relevance,
                20,
                false,
            ));
            let actual = plan
                .list()
                .params()
                .iter()
                .filter_map(|param| match param {
                    Value::Text(value)
                        if value.ends_with('%')
                            && !value.starts_with('%')
                            && !value.starts_with('{') =>
                    {
                        Some(value.clone())
                    }
                    _ => None,
                })
                .take(expected.len())
                .collect::<Vec<_>>();

            assert_eq!(actual, expected, "normalization case {}", case["name"]);
        }
    }

    #[test]
    fn test_explicit_non_name_sort_skips_common_name_relevance_ordering() {
        let plan = SpeciesSearchPlan::build(request(
            Some("lin"),
            default_filter(),
            None,
            Sort::Height,
            20,
            false,
        ));
        let sql = plan.list().sql();

        assert!(sql.contains("ORDER BY s.height_max_m DESC, s.canonical_name"));
        assert!(!sql.contains("ORDER BY CASE"));
        assert!(sql.contains("species_search_common_name_tokens"));
    }

    #[test]
    fn test_empty_or_unsafe_fts_falls_back_to_keyset_plan() {
        for text in ["", "   ", "\" () + -", " -- / () ", "́", "É"] {
            let plan = SpeciesSearchPlan::build(request(
                Some(text),
                default_filter(),
                None,
                Sort::Relevance,
                20,
                true,
            ));
            assert!(!plan.list().sql().contains("species_search_fts"));
            assert!(!plan.count().unwrap().sql().contains("species_search_fts"));
            assert!(!plan.list().sql().contains("ORDER BY bm25("));
            assert!(!plan.list().sql().contains("OFFSET ?"));

            let items = vec![list_item("Lavandula alpha")];
            let position = BrowsePosition::new(0, None);
            let next_cursor = plan
                .next_cursor(&items, Some(&position), true)
                .expect("expected cursor");
            assert!(!next_cursor.starts_with("offset:"));
        }
    }

    #[test]
    fn test_count_and_list_plans_share_search_predicates() {
        let mut filters = default_filter();
        filters.family = Some("Lamiaceae".to_owned());
        filters.extra = Some(vec![DynamicFilter {
            field: "raunkiaer_life_form".to_owned(),
            op: FilterOp::Equals,
            values: vec!["Phanerophyte".to_owned()],
        }]);

        let plan = SpeciesSearchPlan::build(request(
            Some("lavender"),
            filters,
            None,
            Sort::Name,
            20,
            true,
        ));

        let count_where = normalized_main_where(plan.count().unwrap().sql());
        let list_where = normalized_main_where(plan.list().sql());
        assert_eq!(count_where, list_where);
    }

    #[test]
    fn test_count_query_no_text_no_filters() {
        let plan =
            SpeciesSearchPlan::build(request(None, default_filter(), None, Sort::Name, 20, true));
        let count = plan.count().unwrap();
        let sql = count.sql();
        let params = count.params();
        assert!(sql.contains("SELECT COUNT(*)"));
        assert!(!sql.contains("species_search_fts"));
        assert_eq!(params.len(), 0);
    }

    #[test]
    fn test_count_query_with_text() {
        let plan = SpeciesSearchPlan::build(request(
            Some("lavender"),
            default_filter(),
            None,
            Sort::Name,
            20,
            true,
        ));
        let count = plan.count().unwrap();
        let sql = count.sql();
        let params = count.params();
        assert!(sql.contains("SELECT COUNT(*)"));
        assert!(sql.contains("species_search_fts MATCH"));
        assert_eq!(params.len(), 3);
        match &params[0] {
            Value::Text(s) => assert_eq!(s, "en"),
            _ => panic!("expected text param"),
        }
        assert!(
            params.iter().any(|param| matches!(
                param,
                Value::Text(value)
                    if value == "{canonical_name family_genus uses_text other_text}: lavender*"
            )),
            "expected FTS prefix wildcard in params, got {params:?}"
        );
    }

    #[test]
    fn test_count_query_with_filters() {
        let mut f = default_filter();
        f.nitrogen_fixer = Some(true);
        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, true));
        let count = plan.count().unwrap();
        let sql = count.sql();
        let params = count.params();
        assert!(sql.contains("SELECT COUNT(*)"));
        assert!(sql.contains("nitrogen_fixer = 1"));
        assert!(!sql.contains("species_search_fts"));
        assert_eq!(params.len(), 0);
    }

    #[test]
    fn test_dynamic_filter_plan_uses_generated_allowlist() {
        let mut f = default_filter();
        f.extra = Some(vec![
            DynamicFilter {
                field: "raunkiaer_life_form".to_owned(),
                op: FilterOp::Equals,
                values: vec!["Phanerophyte".to_owned()],
            },
            DynamicFilter {
                field: "not_a_species_column".to_owned(),
                op: FilterOp::Equals,
                values: vec!["ignored".to_owned()],
            },
        ]);

        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, true));

        assert!(plan.list().sql().contains("s.raunkiaer_life_form = ?"));
        assert!(
            plan.count()
                .unwrap()
                .sql()
                .contains("s.raunkiaer_life_form = ?")
        );
        assert!(!plan.list().sql().contains("not_a_species_column"));
        assert!(!plan.count().unwrap().sql().contains("not_a_species_column"));
    }

    #[test]
    fn test_dynamic_filter_plan_uses_generated_kind_operator_support() {
        let mut f = default_filter();
        f.extra = Some(vec![
            DynamicFilter {
                field: "frost_tender".to_owned(),
                op: FilterOp::IsTrue,
                values: vec![],
            },
            DynamicFilter {
                field: "growth_form_type".to_owned(),
                op: FilterOp::In,
                values: vec!["Tree".to_owned(), "Shrub".to_owned()],
            },
            DynamicFilter {
                field: "height_max_m".to_owned(),
                op: FilterOp::Gte,
                values: vec!["2.5".to_owned()],
            },
            DynamicFilter {
                field: "medicinal_rating".to_owned(),
                op: FilterOp::Between,
                values: vec!["1".to_owned(), "4".to_owned()],
            },
            DynamicFilter {
                field: "growth_form_type".to_owned(),
                op: FilterOp::Gte,
                values: vec!["5".to_owned()],
            },
            DynamicFilter {
                field: "frost_tender".to_owned(),
                op: FilterOp::In,
                values: vec!["true".to_owned()],
            },
        ]);

        let plan = SpeciesSearchPlan::build(request(None, f, None, Sort::Name, 20, true));
        let sql = plan.list().sql();

        assert!(sql.contains("s.frost_tender = 1"));
        assert!(sql.contains("s.growth_form_type IN (?"));
        assert!(sql.contains("s.height_max_m >= ?"));
        assert!(sql.contains("s.medicinal_rating BETWEEN ?"));
        assert!(!sql.contains("s.growth_form_type >="));
        assert!(!sql.contains("s.frost_tender IN"));
    }

    #[test]
    fn test_indexed_active_search_stages_selected_language_names_before_fallbacks() {
        let mut plan_request = request(
            Some("ap"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        );
        plan_request.use_search_name_entry_index = true;

        let plan = SpeciesSearchPlan::build(plan_request);
        let sql = plan.list().sql();

        assert!(sql.contains("selected_candidate_scores AS MATERIALIZED"));
        assert!(sql.contains("selected_candidate_count AS MATERIALIZED"));
        assert!(sql.contains("fallback_name_token_0 AS"));
        assert!(sql.contains("WHERE (SELECT count FROM selected_candidate_count) <"));
        assert_dense_statement_placeholders(plan.list());
    }

    #[test]
    fn test_filtered_indexed_active_search_keeps_conservative_candidate_scan() {
        let mut filters = default_filter();
        filters.family = Some("Rosaceae".to_owned());
        let mut plan_request = request(Some("ap"), filters, None, Sort::Relevance, 20, false);
        plan_request.use_search_name_entry_index = true;

        let plan = SpeciesSearchPlan::build(plan_request);
        let sql = plan.list().sql();

        assert!(!sql.contains("selected_candidate_scores"));
        assert!(!sql.contains("selected_candidate_count"));
        assert!(sql.contains("candidate_scores AS MATERIALIZED"));
        assert!(sql.contains("'__canonical__'"));
        assert_dense_statement_placeholders(plan.list());
    }

    #[test]
    fn test_longer_indexed_active_search_keeps_broad_candidate_scan() {
        let mut plan_request = request(
            Some("apple"),
            default_filter(),
            None,
            Sort::Relevance,
            20,
            false,
        );
        plan_request.use_search_name_entry_index = true;

        let plan = SpeciesSearchPlan::build(plan_request);
        let sql = plan.list().sql();

        assert!(!sql.contains("selected_candidate_scores"));
        assert!(!sql.contains("selected_candidate_count"));
        assert!(sql.contains("candidate_scores AS MATERIALIZED"));
        assert_dense_statement_placeholders(plan.list());
    }
    fn browse_plan(sort: Sort, cursor: Option<String>) -> SpeciesSearchPlan {
        SpeciesSearchPlan::build(request(None, default_filter(), cursor, sort, 20, false))
    }

    #[test]
    fn browse_sorts_build_one_index_ordered_subquery_per_phase() {
        for (sort, phases) in [
            (
                Sort::Recommended,
                vec![
                    "s.edibility_rating >= 0",
                    "+s.edibility_rating IS NULL AND EXISTS (SELECT 1 FROM best_common_names b WHERE b.species_id = s.id AND b.language = ?1)",
                    "+s.edibility_rating IS NULL AND NOT EXISTS (SELECT 1 FROM best_common_names b WHERE b.species_id = s.id AND b.language = ?1)",
                ],
            ),
            (Sort::Name, vec![]),
            (Sort::Relevance, vec![]),
            (
                Sort::Height,
                vec!["s.height_max_m IS NOT NULL", "+s.height_max_m IS NULL"],
            ),
            (
                Sort::Edibility,
                vec!["s.edibility_rating >= 0", "+s.edibility_rating IS NULL"],
            ),
        ] {
            let plan = browse_plan(sort.clone(), None);
            let sql = normalize_placeholders(plan.list().sql());
            let phase_count = phases.len().max(1);

            assert!(plan.is_browse());
            assert!(
                sql.starts_with("WITH page AS MATERIALIZED ("),
                "{sort:?}: {sql}"
            );
            assert_eq!(
                sql.matches(" UNION ALL ").count(),
                phase_count - 1,
                "{sort:?}"
            );
            assert_eq!(
                sql.matches("FROM species s ").count(),
                phase_count,
                "{sort:?}"
            );
            for predicate in phases {
                let predicate = normalize_placeholders(predicate);
                assert!(
                    sql.contains(&predicate),
                    "{sort:?} missing {predicate}: {sql}"
                );
            }
            assert!(
                sql.contains("ORDER BY page_phase, page_sort_key DESC, canonical_name LIMIT ?")
            );
            assert!(sql.contains("page.page_phase AS page_phase"));
            assert!(sql.contains("page.page_sort_key AS page_sort_key"));
            assert!(sql.contains("JOIN species s ON s.id = page.species_id"));
            assert!(sql.ends_with(
                "ORDER BY page.page_phase, page.page_sort_key DESC, page.canonical_name"
            ));
            assert!(!sql.contains("canonical_name >"), "{sort:?} has no cursor");
            assert_dense_statement_placeholders(plan.list());
        }
    }

    #[test]
    fn browse_phases_order_by_their_key_then_canonical_name() {
        let recommended = normalize_placeholders(browse_plan(Sort::Recommended, None).list().sql());
        assert!(recommended.contains(
            "0 AS page_phase, (s.edibility_rating * 36 + COALESCE(s.other_uses_rating, 0) * 6 + COALESCE(s.medicinal_rating, 0)) AS page_sort_key"
        ));
        assert!(recommended.contains(
            "ORDER BY (s.edibility_rating * 36 + COALESCE(s.other_uses_rating, 0) * 6 + COALESCE(s.medicinal_rating, 0)) DESC, s.canonical_name LIMIT ?"
        ));
        assert!(recommended.contains("1 AS page_phase, NULL AS page_sort_key"));
        assert!(recommended.contains("2 AS page_phase, NULL AS page_sort_key"));

        let height = normalize_placeholders(browse_plan(Sort::Height, None).list().sql());
        assert!(height.contains("ORDER BY s.height_max_m DESC, s.canonical_name LIMIT ?"));
        assert!(height.contains("ORDER BY s.canonical_name LIMIT ?"));

        let edibility = normalize_placeholders(browse_plan(Sort::Edibility, None).list().sql());
        assert!(edibility.contains("ORDER BY s.edibility_rating DESC, s.canonical_name LIMIT ?"));

        let name = normalize_placeholders(browse_plan(Sort::Name, None).list().sql());
        assert!(name.contains("0 AS page_phase, NULL AS page_sort_key"));
        assert!(name.contains("ORDER BY s.canonical_name LIMIT ?"));
    }

    #[test]
    fn key_phase_cursor_keeps_the_index_range_scan_and_binds_numbers() {
        let plan = browse_plan(
            Sort::Height,
            Some(encode_cursor(0, Some("4.5"), "Malus domestica")),
        );
        let sql = normalize_placeholders(plan.list().sql());
        let params = plan.list().params();

        assert!(
            sql.contains("s.height_max_m <= ? AND (s.height_max_m < ? OR s.canonical_name > ?)")
        );
        assert!(!sql.contains("(s.height_max_m, s.canonical_name)"));
        assert_eq!(sql.matches("canonical_name > ?").count(), 1);
        assert!(sql.contains("+s.height_max_m IS NULL"), "later phase stays");
        assert!(params.contains(&Value::Real(4.5)));
        assert!(params.contains(&Value::Text("Malus domestica".to_owned())));
        assert_dense_statement_placeholders(plan.list());

        let plan = browse_plan(
            Sort::Recommended,
            Some(encode_cursor(0, Some("199"), "Malus domestica")),
        );
        let sql = normalize_placeholders(plan.list().sql());
        assert!(sql.contains(
            "(s.edibility_rating * 36 + COALESCE(s.other_uses_rating, 0) * 6 + COALESCE(s.medicinal_rating, 0)) <= ? AND ((s.edibility_rating * 36 + COALESCE(s.other_uses_rating, 0) * 6 + COALESCE(s.medicinal_rating, 0)) < ? OR s.canonical_name > ?)"
        ));
        assert!(plan.list().params().contains(&Value::Integer(199)));
        assert_dense_statement_placeholders(plan.list());
    }

    #[test]
    fn cursor_in_a_later_phase_skips_earlier_phases() {
        let plan = browse_plan(
            Sort::Recommended,
            Some(encode_cursor(1, None, "Crataegus monogyna")),
        );
        let sql = normalize_placeholders(plan.list().sql());

        assert!(!sql.contains("s.edibility_rating >= 0"));
        assert!(!sql.contains("0 AS page_phase"));
        assert!(sql.contains("1 AS page_phase"));
        assert!(sql.contains("2 AS page_phase"));
        assert_eq!(sql.matches(" UNION ALL ").count(), 1);
        assert_eq!(sql.matches("s.canonical_name > ?").count(), 1);
        let cursor_at = sql.find("s.canonical_name > ?").unwrap();
        assert!(cursor_at < sql.find("2 AS page_phase").unwrap());
        assert!(
            plan.list()
                .params()
                .contains(&Value::Text("Crataegus monogyna".to_owned()))
        );
        assert_dense_statement_placeholders(plan.list());

        let plan = browse_plan(Sort::Height, Some(encode_cursor(1, None, "Prunus")));
        let sql = normalize_placeholders(plan.list().sql());
        assert!(!sql.contains("s.height_max_m IS NOT NULL"));
        assert!(!sql.contains(" UNION ALL "));
    }

    #[test]
    fn cursors_that_do_not_fit_the_sort_restart_the_browse() {
        for cursor in [
            encode_cursor(5, None, "Malus domestica"),
            encode_cursor(0, None, "Malus domestica"),
            encode_cursor(0, Some("tall"), "Malus domestica"),
            encode_cursor(1, Some("4.5"), "Malus domestica"),
            "not-a-cursor".to_owned(),
        ] {
            let plan = browse_plan(Sort::Height, Some(cursor));
            let sql = plan.list().sql();
            assert!(!sql.contains("canonical_name >"), "{sql}");
            assert!(sql.contains("0 AS page_phase"));
            assert!(sql.contains("1 AS page_phase"));
        }
    }

    #[test]
    fn browse_next_cursor_records_the_last_row_phase_and_key() {
        let item = list_item("Malus domestica");
        for (sort, position, expected) in [
            (
                Sort::Height,
                BrowsePosition::new(0, Some(BrowseKeyValue::Real(7.5))),
                (0, Some("7.5".to_owned())),
            ),
            (
                Sort::Recommended,
                BrowsePosition::new(0, Some(BrowseKeyValue::Integer(199))),
                (0, Some("199".to_owned())),
            ),
            (Sort::Recommended, BrowsePosition::new(2, None), (2, None)),
            (Sort::Name, BrowsePosition::new(0, None), (0, None)),
        ] {
            let plan = browse_plan(sort, None);
            let cursor = plan
                .next_cursor(std::slice::from_ref(&item), Some(&position), true)
                .expect("expected cursor");
            let (phase, key, canonical_name) = decode_cursor(&cursor).unwrap();
            assert_eq!((phase, key), expected);
            assert_eq!(canonical_name, "Malus domestica");
            assert_eq!(
                plan.next_cursor(std::slice::from_ref(&item), Some(&position), false),
                None
            );
        }
    }
}
