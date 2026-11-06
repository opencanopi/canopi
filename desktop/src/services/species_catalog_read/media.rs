use canopi_types::species::SpeciesImage;
use rusqlite::Connection;

pub(super) fn read_images_projection(
    conn: &Connection,
    canonical_name: &str,
) -> Result<Vec<SpeciesImage>, String> {
    super::detail::get_species_images(conn, canonical_name)
}
