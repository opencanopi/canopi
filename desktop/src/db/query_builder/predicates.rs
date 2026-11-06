use canopi_types::species::SpeciesFilter;

use super::filters::append_structured_filters;
use super::sql::{SqlBuilder, escape_like_literal, like_predicate};
use super::text::CommonNameQuery;

pub(super) struct PredicatePlan {
    fts_join: Option<&'static str>,
    where_clauses: Vec<String>,
}

impl PredicatePlan {
    pub(super) fn for_search(
        search_term: Option<&str>,
        common_name_query: Option<&CommonNameQuery>,
        locale_placeholder: Option<&str>,
        use_common_name_token_index: bool,
        filters: &SpeciesFilter,
        sql_builder: &mut SqlBuilder,
    ) -> Self {
        let mut where_clauses = Vec::new();
        let mut text_clauses = Vec::new();
        let fts_join = search_term
            .or_else(|| common_name_query.map(|_| ""))
            .map(|term| {
                if !term.is_empty() {
                    let placeholder = sql_builder.bind_text(term);
                    text_clauses.push(format!(
                        "s.rowid IN (
                        SELECT species_search_fts.rowid
                        FROM species_search_fts
                        WHERE species_search_fts MATCH {placeholder}
                    )"
                    ));
                }
                "JOIN species_search_fts ON species_search_fts.rowid = s.rowid"
            });
        if let (Some(query), Some(locale_placeholder)) = (common_name_query, locale_placeholder)
            && use_common_name_token_index
            && !query.tokens.is_empty()
        {
            text_clauses.push(common_name_token_prefix_predicate(
                query,
                locale_placeholder,
                sql_builder,
            ));
        }
        if !text_clauses.is_empty() {
            where_clauses.push(format!("({})", text_clauses.join(" OR ")));
        }

        append_structured_filters(&mut where_clauses, sql_builder, filters);

        Self {
            fts_join,
            where_clauses,
        }
    }

    pub(super) fn push(&mut self, clause: String) {
        self.where_clauses.push(clause);
    }

    pub(super) fn fts_join_sql(&self) -> &'static str {
        self.fts_join.unwrap_or("")
    }

    pub(super) fn where_sql(&self) -> String {
        if self.where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", self.where_clauses.join(" AND "))
        }
    }
}

fn common_name_token_prefix_predicate(
    query: &CommonNameQuery,
    locale_placeholder: &str,
    sql_builder: &mut SqlBuilder,
) -> String {
    query
        .tokens
        .iter()
        .enumerate()
        .map(|(index, token)| {
            let alias = format!("scnt_match{index}");
            let token_placeholder =
                sql_builder.bind_text(format!("{}%", escape_like_literal(token)));
            let token_condition = like_predicate(&format!("{alias}.token"), &token_placeholder);
            format!(
                "EXISTS (
                    SELECT 1 FROM species_search_common_name_tokens {alias}
                    WHERE {alias}.species_id = s.id
                      AND {alias}.language = {locale_placeholder}
                      AND {token_condition}
                )"
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}
