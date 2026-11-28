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
    /// Optional paper size identifier (`"A4"` or `"Letter"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper: Option<String>,
    /// Optional printable layer override; absent means default visible exportable layers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layers: Option<Vec<String>>,
    /// Optional print-only plant colour mode (`"design"`, `"grayscale"`, `"black"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plant_colors: Option<String>,
    /// Whether map pages print the north arrow and ground scale bar (default true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub north_arrow: Option<bool>,
    /// Overview page clockwise angle in degrees (default 0, North up).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview_angle_deg: Option<f64>,
    /// Overview page printed scale (default Fit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview_scale: Option<PrintScaleV10>,
    /// Overview page framing overrides (orientation and pan offset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview_framing: Option<PrintFramingV10>,
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
    /// Optional horizontal pan offset in plan metres.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_x_m: Option<f64>,
    /// Optional vertical pan offset in plan metres.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_y_m: Option<f64>,
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
    if let Some(angle) = setup.overview_angle_deg
        && !angle.is_finite()
    {
        return Err(Refusal::new(ps.field("overview_angle_deg"), FINITE));
    }
    if let Some(scale) = &setup.overview_scale {
        admit_print_scale(scale, &ps.field("overview_scale"))?;
    }
    if let Some(framing) = &setup.overview_framing {
        admit_print_framing(framing, &ps.field("overview_framing"))?;
    }
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
    if let Some(framing) = &page.framing {
        admit_print_framing(framing, &pp.field("framing"))?;
    }
    admit_print_scale(&page.scale, &pp.field("scale"))?;
    Ok(())
}

fn admit_print_framing(
    framing: &PrintFramingV10,
    fp: &super::field_path::FieldPath,
) -> Result<(), super::field_path::Refusal> {
    use super::field_path::Refusal;
    const FINITE: &str = "expected a finite number";
    if let Some(x) = framing.offset_x_m
        && !x.is_finite()
    {
        return Err(Refusal::new(fp.field("offset_x_m"), FINITE));
    }
    if let Some(y) = framing.offset_y_m
        && !y.is_finite()
    {
        return Err(Refusal::new(fp.field("offset_y_m"), FINITE));
    }
    Ok(())
}

fn admit_print_scale(
    scale: &PrintScaleV10,
    sp: &super::field_path::FieldPath,
) -> Result<(), super::field_path::Refusal> {
    use super::field_path::Refusal;
    match scale {
        PrintScaleV10::Fit { .. } => {}
        PrintScaleV10::Ratio { denominator: 0, .. } => {
            return Err(Refusal::new(
                sp.field("denominator"),
                "expected a positive denominator",
            ));
        }
        PrintScaleV10::Ratio { .. } => {}
        PrintScaleV10::Customary { inches, feet, .. }
            if !(inches.is_finite() && *inches > 0.0 && feet.is_finite() && *feet > 0.0) =>
        {
            return Err(Refusal::new(
                sp.clone(),
                "expected positive finite customary scale values",
            ));
        }
        PrintScaleV10::Customary { .. } => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::design::field_path::FieldPath;

    #[test]
    fn print_setup_v10_round_trips_options_splits_and_scales() {
        let setup = PrintSetupV10 {
            paper: Some("Letter".to_string()),
            layers: Some(vec!["plants".to_string(), "zones".to_string()]),
            plant_colors: Some("grayscale".to_string()),
            north_arrow: Some(true),
            overview_angle_deg: Some(0.0),
            overview_scale: Some(PrintScaleV10::Customary {
                inches: 1.0,
                feet: 20.0,
                extra: BTreeMap::new(),
            }),
            overview_framing: Some(PrintFramingV10 {
                paper: None,
                orientation: Some("landscape".to_string()),
                offset_x_m: Some(1.5),
                offset_y_m: Some(-2.25),
                extra: BTreeMap::new(),
            }),
            splits: vec![PrintSplitV10 {
                id: "split-1".to_string(),
                pivot: GeoPointV10 {
                    lon: 2.3522,
                    lat: 48.8566,
                    extra: BTreeMap::new(),
                },
                angle_deg: 32.0,
                extra: BTreeMap::new(),
            }],
            pages: vec![PrintPageV10 {
                id: "p1".to_string(),
                name: "Sheet 1".to_string(),
                area: PrintAreaV10::SplitSheet {
                    split: "split-1".to_string(),
                    along_page: AlongPageM {
                        right_m: 12.0,
                        down_m: 0.0,
                        extra: BTreeMap::new(),
                    },
                    size: PrintSizeM {
                        width_m: 20.0,
                        height_m: 15.0,
                        extra: BTreeMap::new(),
                    },
                    extra: BTreeMap::new(),
                },
                framing: Some(PrintFramingV10 {
                    paper: Some("Letter".to_string()),
                    orientation: Some("portrait".to_string()),
                    offset_x_m: Some(0.5),
                    offset_y_m: Some(0.0),
                    extra: BTreeMap::new(),
                }),
                scale: PrintScaleV10::Ratio {
                    denominator: 200,
                    extra: BTreeMap::new(),
                },
                extra: BTreeMap::new(),
            }],
            extra: BTreeMap::new(),
        };
        admit_print_setup(&setup, &FieldPath::root()).expect("valid print_setup admitted");
        let encoded = serde_json::to_string(&setup).expect("serialize print_setup");
        let decoded: PrintSetupV10 = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded.paper.as_deref(), Some("Letter"));
        assert_eq!(decoded.overview_angle_deg, Some(0.0));
        assert_eq!(decoded.splits.len(), 1);
        assert_eq!(decoded.pages.len(), 1);
        assert_eq!(
            decoded.pages[0].scale,
            PrintScaleV10::Ratio {
                denominator: 200,
                extra: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn print_setup_v10_refuses_non_finite_overview_angle_and_missing_split() {
        let bad_angle = PrintSetupV10 {
            overview_angle_deg: Some(f64::NAN),
            ..Default::default()
        };
        let err = admit_print_setup(&bad_angle, &FieldPath::root()).unwrap_err();
        assert_eq!(
            err.field_path.to_string(),
            "$.print_setup.overview_angle_deg"
        );

        let bad_split = PrintSetupV10 {
            pages: vec![PrintPageV10 {
                id: "p1".to_string(),
                name: "Orphan".to_string(),
                area: PrintAreaV10::SplitSheet {
                    split: "missing".to_string(),
                    along_page: AlongPageM {
                        right_m: 0.0,
                        down_m: 0.0,
                        extra: BTreeMap::new(),
                    },
                    size: PrintSizeM {
                        width_m: 10.0,
                        height_m: 10.0,
                        extra: BTreeMap::new(),
                    },
                    extra: BTreeMap::new(),
                },
                framing: None,
                scale: PrintScaleV10::Fit {
                    extra: BTreeMap::new(),
                },
                extra: BTreeMap::new(),
            }],
            ..Default::default()
        };
        let err = admit_print_setup(&bad_split, &FieldPath::root()).unwrap_err();
        assert_eq!(
            err.field_path.to_string(),
            "$.print_setup.pages[0].area.split"
        );
    }
}
