//! The v10 read admission (contracts §10, §11; 2.1-M478, 2.1-M481): a `.canopi` value of
//! version 10 or later is walked against the v10 read schema, read into the v10 read shape,
//! checked by the rules a schema cannot state, and mapped onto this build's in-memory shape as
//! a [`ReadOnlyDesign`] that no save, Draft or export path takes. Every refusal names its field
//! by the file's own path (canopi-cyqd, 2.1-M430).
//!
//! A version-10 file the read refuses is `invalid_document`; a later one is `newer_version`,
//! since a later Canopi may have changed what this build reads (2.1-M481). The Desktop host
//! reads natively through it and Web through `canopi-format-wasm` (2.1-M476); 2b's switch
//! deletes it with the read-only view.

use canopi_types::design::field_path::{FieldPath, FieldPathSegment, Refusal};
use canopi_types::design::{
    BudgetItem, CURRENT_CANOPI_FILE_VERSION, CanopiFile, DesignLoadFailureKind, ObjectGroup,
    ObjectGroupMember, PanelTarget, PlacedPlant, ReadOnlyDesign,
    admit_design_identities_and_ranges, validate_design_geometry,
};
use canopi_types::library::LibraryItemRole;
use canopi_types::lidar::{LidarPresentationEntry, LidarPresentationSection, LidarRamp};
use canopi_types::settings::PlantLabels;
use canopi_types::views::{validate_map_view, validate_views_and_stories};
use serde_json::Value;

use crate::schema::{admit_schema, fill_defaults};
use crate::v10::{
    BudgetLineRead, FileRead, GroupMemberRead, GroupRead, PlantDisplayRead, PlantRead,
    SiteDataRead, read_schema,
};

/// The first format version the read admission reads.
pub const FIRST_READ_VERSION: u32 = CURRENT_CANOPI_FILE_VERSION + 1;

/// A newer Design the read refused: why, as the load failure kind the interface maps
/// (`newer_version` or `invalid_document`), and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadRefusal {
    /// `InvalidDocument` for a version-10 file, `NewerVersion` for a later one.
    pub kind: DesignLoadFailureKind,
    /// The refused field and what was expected there, never a file value.
    pub refusal: Refusal,
}

/// Read a `.canopi` value of version 10 or later for the read-only view.
///
/// # Errors
///
/// A [`ReadRefusal`] naming the refused field: `newer_version` when the file is above
/// version 10 or its version does not fit, `invalid_document` for a version-10 file the read
/// refuses or a value that is no Design of version 10 or later.
pub fn read_newer_design(value: &Value) -> Result<ReadOnlyDesign, ReadRefusal> {
    let version = read_version(value)?;
    let refused = |refusal: Refusal| ReadRefusal {
        kind: if version == FIRST_READ_VERSION {
            DesignLoadFailureKind::InvalidDocument
        } else {
            DesignLoadFailureKind::NewerVersion
        },
        refusal,
    };
    let schema = read_schema().ok_or_else(|| {
        refused(Refusal::new(
            FieldPath::root(),
            "a read schema this build can parse",
        ))
    })?;
    admit_schema(value, schema).map_err(refused)?;
    let mut value = value.clone();
    fill_defaults(&mut value, schema);
    // The schema admitted it, so serde builds it; an error past it is a schema the read
    // shape outgrew, named at the root without serde's text.
    let file = serde_json::from_value::<FileRead>(value)
        .map_err(|_| refused(Refusal::new(FieldPath::root(), "expected a Canopi Design")))?;
    let mut view = view_of(file);
    // Checked before duplicates go, so a refused entry is named by its index in the file.
    validate_design_geometry(&view)
        .and_then(|()| admit_design_identities_and_ranges(&view))
        .and_then(|()| validate_views_and_stories(&view.views, &view.stories))
        .and_then(|()| validate_map_view(view.map_view.as_ref()))
        .map_err(|refusal| refused(in_file_names(refusal)))?;
    if let Some(section) = view.lidar.as_mut() {
        keep_lowest_order(&mut section.entries);
    }
    Ok(ReadOnlyDesign {
        view,
        saved_by_version: version,
    })
}

/// The file's version, which the caller found at or above [`FIRST_READ_VERSION`].
fn read_version(value: &Value) -> Result<u32, ReadRefusal> {
    let path = FieldPath::root().field("version");
    let raw = value.get("version");
    let integral_float = raw
        .and_then(Value::as_f64)
        .filter(|version| version.is_finite() && version.fract() == 0.0 && *version >= 0.0);
    // Saturating: a float past u64 is past u32 too, refused as newer just below.
    let version = raw
        .and_then(Value::as_u64)
        .or_else(|| integral_float.map(|version| version as u64));
    match version {
        Some(version) if version < u64::from(FIRST_READ_VERSION) => Err(ReadRefusal {
            kind: DesignLoadFailureKind::InvalidDocument,
            refusal: Refusal::new(path, "expected a version of 10 or later"),
        }),
        Some(version) => u32::try_from(version).map_err(|_| ReadRefusal {
            kind: DesignLoadFailureKind::NewerVersion,
            refusal: Refusal::new(path, "expected an unsigned 32-bit integer"),
        }),
        None => Err(ReadRefusal {
            kind: DesignLoadFailureKind::InvalidDocument,
            refusal: Refusal::new(path, "expected an integer version of 10 or later"),
        }),
    }
}

/// The read file in this build's in-memory shape, v10 names mapped back to v9's so no 2.0
/// code changes; never written. Its `version` is this build's, the file's being
/// [`ReadOnlyDesign::saved_by_version`].
fn view_of(file: FileRead) -> CanopiFile {
    let mut extra = std::collections::HashMap::new();
    if let Some(display) = file.plant_display {
        extra.insert("plant_display".to_owned(), stored_display(display));
    }
    let budget = budget_of(file.budget, &file.budget_currency);
    CanopiFile {
        version: CURRENT_CANOPI_FILE_VERSION,
        name: file.name,
        description: file.description,
        plant_species_colors: file.plant_species_colors,
        plant_species_symbols: file.plant_species_symbols,
        plant_species_codes: file.plant_species_codes,
        layers: file.layers,
        plants: file.plants.into_iter().map(plant_of).collect(),
        zones: file.zones,
        annotations: file.annotations,
        measurement_guides: file.measurement_guides,
        consortiums: file.consortiums,
        groups: file.groups.into_iter().map(group_of).collect(),
        timeline: file.timeline,
        budget,
        budget_currency: file.budget_currency,
        lidar: file.site_data.map(site_data_of),
        views: file.views,
        stories: file.stories,
        map_view: file.map_view,
        created_at: file.created_at,
        updated_at: file.updated_at,
        extra,
    }
}

/// The display options as v9 stores them in `extra.plant_display`, every option present: an
/// absent one, an unknown `color_by` or `labels` literal, or a `one_color` that is no
/// `#RRGGBB` reads as v9's default (`plant-display.ts`), so the 2.0 reader repairs nothing.
fn stored_display(display: PlantDisplayRead) -> Value {
    let color_by = display
        .color_by
        .filter(|mode| ["species", "stratum", "one_color"].contains(&mode.as_str()));
    let one_color = display.one_color.filter(|color| {
        let color = color.trim();
        color.len() == 7
            && color.starts_with('#')
            && color[1..].chars().all(|digit| digit.is_ascii_hexdigit())
    });
    let labels = display
        .labels
        .and_then(|literal| serde_json::from_value::<PlantLabels>(Value::String(literal)).ok())
        .unwrap_or_default();
    let mut stored = serde_json::json!({
        "color_by": color_by.as_deref().unwrap_or("species"),
        "one_color": one_color.as_deref().unwrap_or("#27231D"),
        "symbol_scale": display.symbol_scale.unwrap_or(1.0),
        "outline": display.outline.unwrap_or(true),
        "labels": labels,
    });
    if let Some(colors) = display.stratum_colors {
        stored["stratum_colors"] = serde_json::json!(colors);
    }
    stored
}

fn plant_of(plant: PlantRead) -> PlacedPlant {
    PlacedPlant {
        id: plant.id,
        locked: plant.locked,
        canonical_name: plant.canonical_name,
        common_name: plant.common_name,
        color: plant.color,
        symbol: plant.symbol,
        pinned_name: plant.pinned_name,
        position: plant.position,
        rotation: plant.rotation,
        scale: plant.canopy_spread_m,
        notes: plant.notes,
        planted_date: plant.planted_date,
        quantity: plant.quantity,
    }
}

/// A group without its measurement guide members, which this build's groups cannot hold;
/// the view never writes, so nothing is normalised.
fn group_of(group: GroupRead) -> ObjectGroup {
    let members = group
        .members
        .into_iter()
        .filter_map(|member| match member {
            GroupMemberRead::Plant { id } => Some(ObjectGroupMember::Plant { id }),
            GroupMemberRead::Zone { id } => Some(ObjectGroupMember::Zone { id }),
            GroupMemberRead::Annotation { id } => Some(ObjectGroupMember::Annotation { id }),
            GroupMemberRead::MeasurementGuide { .. } => None,
        })
        .collect();
    ObjectGroup {
        id: group.id,
        locked: group.locked,
        name: group.name,
        members,
    }
}

/// The species lines as this build's plant lines; a line whose target is not a species, or
/// a species line without its name, is skipped (2.1-M491).
fn budget_of(lines: Vec<BudgetLineRead>, currency: &str) -> Vec<BudgetItem> {
    lines
        .into_iter()
        .filter(|line| line.target.kind == "species")
        .filter_map(|line| {
            let canonical_name = line.target.canonical_name?;
            Some(BudgetItem {
                target: PanelTarget::Species {
                    canonical_name: canonical_name.clone(),
                },
                category: "plants".to_owned(),
                description: canonical_name,
                quantity: 0.0,
                unit_cost: line.unit_cost,
                currency: currency.to_owned(),
            })
        })
        .collect()
}

/// The Site data section as this build's LiDAR section: an entry's role follows its id
/// (`lyr-` a source layer, otherwise a derived item, 2.1-M493) and an unknown ramp reads as
/// the item's default.
fn site_data_of(section: SiteDataRead) -> LidarPresentationSection {
    let entries = section
        .entries
        .into_iter()
        .map(|entry| LidarPresentationEntry {
            kind: if entry.id.starts_with("lyr-") {
                LibraryItemRole::Source
            } else {
                LibraryItemRole::Derived
            },
            ramp: entry.ramp.as_deref().and_then(ramp_of),
            id: entry.id,
            name: entry.name,
            visible: entry.visible,
            opacity: entry.opacity,
            order: entry.order,
            reversed: entry.reversed,
            range: entry.range,
        })
        .collect();
    LidarPresentationSection {
        visible: section.visible,
        entries,
    }
}

/// Of two entries with one id, the one with the lowest `order` (the first of equals) stays,
/// where the first of them stood.
fn keep_lowest_order(entries: &mut Vec<LidarPresentationEntry>) {
    let mut kept: Vec<LidarPresentationEntry> = Vec::with_capacity(entries.len());
    for entry in entries.drain(..) {
        match kept.iter_mut().find(|other| other.id == entry.id) {
            Some(other) if entry.order < other.order => *other = entry,
            Some(_) => {}
            None => kept.push(entry),
        }
    }
    *entries = kept;
}

fn ramp_of(literal: &str) -> Option<LidarRamp> {
    serde_json::from_value(Value::String(literal.to_owned())).ok()
}

/// A refusal of the mapped view named by the file's v10 path: `lidar` is `site_data` and a
/// plant's `scale` its `canopy_spread_m`.
fn in_file_names(refusal: Refusal) -> Refusal {
    let mut path = FieldPath::root();
    let mut in_plant = false;
    for (index, segment) in refusal.field_path.segments().iter().enumerate() {
        path = match *segment {
            FieldPathSegment::Field("lidar") if index == 0 => path.field("site_data"),
            FieldPathSegment::Field("scale") if in_plant && index == 2 => {
                path.field("canopy_spread_m")
            }
            FieldPathSegment::Field(name) => {
                in_plant = index == 0 && name == "plants";
                path.field(name)
            }
            FieldPathSegment::Index(item) => path.index(item),
            FieldPathSegment::MapValue => path.map_value(),
        };
    }
    Refusal::new(path, refusal.expected)
}

#[cfg(test)]
mod tests;
