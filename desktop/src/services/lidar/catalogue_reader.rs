//! The reader release's listing of a catalogue a newer Canopi wrote (Step 2.0.4 R2-4, canopi-f47t.52.271).
//!
//! A catalogue at version 26 or later is read through its frozen read projection, `library_items(id, kind,
//! lineage_tag, name)` (2.1-M480, `catalogue::newer_items`), and never written (2.1-M488). Every item it holds was
//! made or last kept by that newer Canopi, whose display files and job rows this build does not read, so each one
//! lists by name and type as needing a newer Canopi and is never drawn, placed, renamed or deleted (2.1-Q318). A
//! `vector` row, a literal this build does not know, and an item whose `library_jobs` row is still queued or running
//! list the same way, one row each, never refusing the whole listing; a running job is left as it is, never settled.
//!
//! This is the one decoder of catalogue 26's stored literals. Interim: N1's library reads catalogue 26 natively and
//! deletes this module with `LibraryItemSummary.newer_kind`.

use canopi_types::library::{
    Freshness, LibraryItemKind, LibraryItemRole, LibraryItemSummary, LibraryItemType, Lineage,
    RasterQuantity,
};
use canopi_types::lidar::LidarResultState;

/// A newer catalogue's items, the library's whole listing while it is open read-only. Its `Debug` gives the count
/// only, so the open status the app logs never carries an item's name.
#[derive(Clone, Default, PartialEq)]
pub struct NewerItems(pub Vec<LibraryItemSummary>);

impl std::fmt::Debug for NewerItems {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} items", self.0.len())
    }
}

/// Every row of a newer catalogue's read projection, each item needing a newer Canopi. `catalogue::newer_items` reads
/// the rows and calls it, so this decoder names no other library module (no module cycle, 2.1-M189).
pub(crate) fn decode(rows: Vec<[String; 4]>) -> NewerItems {
    NewerItems(
        rows.into_iter()
            .map(|[id, kind, lineage_tag, name]| summary(id, &kind, &lineage_tag, name))
            .collect(),
    )
}

fn summary(id: String, kind: &str, lineage_tag: &str, name: String) -> LibraryItemSummary {
    let newer_kind = LibraryItemKind::ALL
        .into_iter()
        .find(|known| known.literal() == kind);
    // An analysis result keeps its role, so a Design's Site data row for it reads as one; any other lineage,
    // a literal this build does not know included, is a source.
    let role = if lineage_tag == Lineage::Analysis.literal() {
        LibraryItemRole::Derived
    } else {
        LibraryItemRole::Source
    };
    LibraryItemSummary {
        id,
        name: Some(name),
        role,
        // Never read for a `NeedsNewer` item, which lists by `newer_kind`; the projection holds no quantity.
        item_type: LibraryItemType::Raster {
            quantity: RasterQuantity::OtherContinuous,
        },
        units: String::new(),
        state: LidarResultState::NeedsNewer,
        generation_id: None,
        bounds: None,
        value_range: None,
        display_range: None,
        resolution_m: None,
        coverage_cells: None,
        import_job: None,
        provenance: None,
        freshness: Freshness::Current,
        run: None,
        offers: Vec::new(),
        dependents: 0,
        created_at: String::new(),
        newer_kind,
    }
}
