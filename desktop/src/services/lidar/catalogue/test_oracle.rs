//! `catalogue.rs`'s test oracle: reads no production path makes, held beside the catalogue's SQL for the tests of
//! every LiDAR module.

use super::{CHUNK_ASSET_COLUMNS, ChunkAssetRow, map_chunk_row};
use rusqlite::Connection;

/// Published chunk references of one generation and role, ordered by position.
///
/// Only `published` rows are selected: an unpublished row belongs to a job
/// that has not committed, so it must never be readable.
///
/// Test oracle only: production readers page through
/// [`generation_chunk_page`] and never load a generation's whole record set.
pub fn generation_chunk_assets(
    connection: &Connection,
    generation_id: &str,
    role: &str,
) -> Result<Vec<ChunkAssetRow>, String> {
    let sql = format!(
        "{CHUNK_ASSET_COLUMNS}
     WHERE g.generation_id = ?1 AND g.role = ?2 AND g.state = 'published'
     ORDER BY g.chunk_y, g.chunk_x"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare chunk asset query: {e}"))?;
    statement
        .query_map(rusqlite::params![generation_id, role], map_chunk_row)
        .map_err(|e| format!("Failed to read chunk assets: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read chunk assets: {e}"))
}
