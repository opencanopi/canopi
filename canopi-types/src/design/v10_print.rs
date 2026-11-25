//! Typed PDF print setup addition for `.canopi` v10 (`2.1-Q36`, `2.1-M90`, `2.1-M161`, `2.1-Q356`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::design::deserialize_json_u32;
use crate::design::v10_nested::GeoPointV10;

/// Typed PDF print setup addition in v10 (`2.1-Q36`, `2.1-M90`, `2.1-M161`, `2.1-Q356`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct PrintSetupV10 {
    /// Shared split definitions referenced by `SplitSheet` pages.
    #[serde(default)]
    pub splits: Vec<PrintSplitV10>,
    /// Print pages in print order.
    #[serde(default)]
    pub pages: Vec<PrintPageV10>,
    /// Extension bag for paper/print options (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// A split pivot and angle shared by tiled `SplitSheet` pages (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PrintSplitV10 {
    /// Stable split id referenced by `PrintAreaV10::SplitSheet.split`.
    pub id: String,
    /// WGS84 pivot position whose ground scale sizes every sheet in the split.
    pub pivot: GeoPointV10,
    /// Clockwise angle in degrees.
    pub angle_deg: f64,
    /// Extension bag for unknown split keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Ground dimensions in metres for a print box or split sheet (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PrintSizeM {
    /// Ground width in metres (> 0).
    pub width_m: f64,
    /// Ground height in metres (> 0).
    pub height_m: f64,
    /// Extension bag for unknown size keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Offset along a split sheet's page axes from its split pivot (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AlongPageM {
    /// Distance right along the page axis in metres.
    pub right_m: f64,
    /// Distance down along the page axis in metres.
    pub down_m: f64,
    /// Extension bag for unknown offset keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Fallback box used by `WholeDesign` when a Design has no placed geometry (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PrintBoxFallback {
    /// Fallback WGS84 centre.
    pub centre: GeoPointV10,
    /// Fallback ground dimensions in metres.
    pub size: PrintSizeM,
    /// Extension bag for unknown fallback keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Area specification for a [`PrintPageV10`] (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrintAreaV10 {
    /// Explicit rotated box centred at `centre` using `centre`'s ground scale.
    Box {
        /// WGS84 box centre.
        centre: GeoPointV10,
        /// Ground dimensions in metres.
        size: PrintSizeM,
        /// Clockwise rotation in degrees.
        angle_deg: f64,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Frames the entire Design with an optional fallback when empty.
    WholeDesign {
        /// Clockwise rotation in degrees.
        angle_deg: f64,
        /// Optional fallback box when the Design has no objects.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback: Option<PrintBoxFallback>,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// One tiled sheet belonging to a declared [`PrintSplitV10`].
    SplitSheet {
        /// Id of the owning [`PrintSplitV10`].
        split: String,
        /// Offset from the split pivot along the page axes.
        along_page: AlongPageM,
        /// Ground dimensions in metres.
        size: PrintSizeM,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
}

/// Printed scale specification for a [`PrintPageV10`] (`2.1-M161`, `2.1-Q356`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrintScaleV10 {
    /// Fit the page area to the printable paper area.
    Fit {
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Fixed metric ratio `1 : denominator` (e.g. `1:200`).
    Ratio {
        /// Scale denominator (> 0).
        #[serde(deserialize_with = "deserialize_json_u32")]
        denominator: u32,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// US customary architectural/engineering scale (`inches` on paper = `feet` on ground, `2.1-Q356`).
    Customary {
        /// Paper inches (> 0).
        inches: f64,
        /// Ground feet (> 0).
        feet: f64,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
}

/// Optional framing overrides for a [`PrintPageV10`] (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct PrintFramingV10 {
    /// Optional paper size identifier (e.g. `"A4"`, `"A3"`, `"Letter"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper: Option<String>,
    /// Optional orientation (`"portrait"` or `"landscape"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    /// Extension bag for unknown framing options (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// One print page in [`PrintSetupV10`] (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PrintPageV10 {
    /// Stable page id.
    pub id: String,
    /// User-visible page name.
    pub name: String,
    /// Ground area printed on this page.
    pub area: PrintAreaV10,
    /// Optional paper/framing overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framing: Option<PrintFramingV10>,
    /// Printed scale (`fit`, `ratio`, or `customary`).
    pub scale: PrintScaleV10,
    /// Extension bag for unknown page keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Validates a `print_setup` block under v10 admission (`2.1-M161`).
pub(super) fn admit_print_setup(
    setup: &PrintSetupV10,
    root: &super::field_path::FieldPath,
) -> Result<(), super::field_path::Refusal> {
    use std::collections::HashSet;

    use super::admission::check_point_v10;
    use super::field_path::Refusal;

    const FINITE: &str = "expected a finite number";
    let ps = root.field("print_setup");
    let mut split_ids = HashSet::new();
    for (i, split) in setup.splits.iter().enumerate() {
        let sp = ps.field("splits").index(i);
        if split.id.is_empty() {
            return Err(Refusal::new(sp.field("id"), "expected a non-empty id"));
        }
        if !split_ids.insert(split.id.as_str()) {
            return Err(Refusal::new(sp.field("id"), "expected a unique id"));
        }
        check_point_v10(&split.pivot, &sp.field("pivot"))?;
        if !split.angle_deg.is_finite() {
            return Err(Refusal::new(sp.field("angle_deg"), FINITE));
        }
    }
    let mut page_ids = HashSet::new();
    for (i, page) in setup.pages.iter().enumerate() {
        let pp = ps.field("pages").index(i);
        admit_print_page(page, &pp, &split_ids, &mut page_ids)?;
    }
    Ok(())
}

fn admit_print_page<'a>(
    page: &'a PrintPageV10,
    pp: &super::field_path::FieldPath,
    split_ids: &std::collections::HashSet<&str>,
    page_ids: &mut std::collections::HashSet<&'a str>,
) -> Result<(), super::field_path::Refusal> {
    use super::admission::check_point_v10;
    use super::field_path::Refusal;

    const FINITE: &str = "expected a finite number";
    if page.id.is_empty() {
        return Err(Refusal::new(pp.field("id"), "expected a non-empty id"));
    }
    if !page_ids.insert(page.id.as_str()) {
        return Err(Refusal::new(pp.field("id"), "expected a unique id"));
    }
    match &page.area {
        PrintAreaV10::Box {
            centre,
            size,
            angle_deg,
            ..
        } => {
            check_point_v10(centre, &pp.field("area").field("centre"))?;
            if !(size.width_m.is_finite() && size.width_m > 0.0) {
                return Err(Refusal::new(
                    pp.field("area").field("size").field("width_m"),
                    "expected a finite number above 0",
                ));
            }
            if !(size.height_m.is_finite() && size.height_m > 0.0) {
                return Err(Refusal::new(
                    pp.field("area").field("size").field("height_m"),
                    "expected a finite number above 0",
                ));
            }
            if !angle_deg.is_finite() {
                return Err(Refusal::new(pp.field("area").field("angle_deg"), FINITE));
            }
        }
        PrintAreaV10::WholeDesign {
            angle_deg,
            fallback,
            ..
        } => {
            if !angle_deg.is_finite() {
                return Err(Refusal::new(pp.field("area").field("angle_deg"), FINITE));
            }
            if let Some(fb) = fallback {
                check_point_v10(
                    &fb.centre,
                    &pp.field("area").field("fallback").field("centre"),
                )?;
            }
        }
        PrintAreaV10::SplitSheet {
            split,
            along_page,
            size,
            ..
        } => {
            if !split_ids.contains(split.as_str()) {
                return Err(Refusal::new(
                    pp.field("area").field("split"),
                    "expected an existing print_setup split id",
                ));
            }
            if !(along_page.right_m.is_finite() && along_page.down_m.is_finite()) {
                return Err(Refusal::new(pp.field("area").field("along_page"), FINITE));
            }
            if !(size.width_m.is_finite()
                && size.width_m > 0.0
                && size.height_m.is_finite()
                && size.height_m > 0.0)
            {
                return Err(Refusal::new(
                    pp.field("area").field("size"),
                    "expected positive finite dimensions",
                ));
            }
        }
    }
    match &page.scale {
        PrintScaleV10::Fit { .. } => {}
        PrintScaleV10::Ratio { denominator: 0, .. } => {
            return Err(Refusal::new(
                pp.field("scale").field("denominator"),
                "expected a positive denominator",
            ));
        }
        PrintScaleV10::Ratio { .. } => {}
        PrintScaleV10::Customary { inches, feet, .. }
            if !(inches.is_finite() && *inches > 0.0 && feet.is_finite() && *feet > 0.0) =>
        {
            return Err(Refusal::new(
                pp.field("scale"),
                "expected positive finite customary scale values",
            ));
        }
        PrintScaleV10::Customary { .. } => {}
    }
    Ok(())
}
