//! Typed PDF print setup addition for `.canopi` v10 (`2.1-Q36`, `2.1-M90`, `2.1-M161`, `2.1-Q356`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::design::{GeoPoint, deserialize_json_u32};

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
    pub pivot: GeoPoint,
    /// Clockwise angle in degrees.
    pub angle_deg: f64,
    /// Extension bag for unknown split keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Ground dimensions in metres for a print box or split sheet (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct PrintSizeM {
    /// Ground width in metres (> 0).
    pub width_m: f64,
    /// Ground height in metres (> 0).
    pub height_m: f64,
}

/// Offset along a split sheet's page axes from its split pivot (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct AlongPageM {
    /// Distance right along the page axis in metres.
    pub right_m: f64,
    /// Distance down along the page axis in metres.
    pub down_m: f64,
}

/// Fallback box used by `WholeDesign` when a Design has no placed geometry (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct PrintBoxFallback {
    /// Fallback WGS84 centre.
    pub centre: GeoPoint,
    /// Fallback ground dimensions in metres.
    pub size: PrintSizeM,
}

/// Area specification for a [`PrintPageV10`] (`2.1-M161`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrintAreaV10 {
    /// Explicit rotated box centred at `centre` using `centre`'s ground scale.
    Box {
        /// WGS84 box centre.
        centre: GeoPoint,
        /// Ground dimensions in metres.
        size: PrintSizeM,
        /// Clockwise rotation in degrees.
        angle_deg: f64,
    },
    /// Frames the entire Design with an optional fallback when empty.
    WholeDesign {
        /// Clockwise rotation in degrees.
        angle_deg: f64,
        /// Optional fallback box when the Design has no objects.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback: Option<PrintBoxFallback>,
    },
    /// One tiled sheet belonging to a declared [`PrintSplitV10`].
    SplitSheet {
        /// Id of the owning [`PrintSplitV10`].
        split: String,
        /// Offset from the split pivot along the page axes.
        along_page: AlongPageM,
        /// Ground dimensions in metres.
        size: PrintSizeM,
    },
}

/// Printed scale specification for a [`PrintPageV10`] (`2.1-M161`, `2.1-Q356`).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrintScaleV10 {
    /// Fit the page area to the printable paper area.
    Fit,
    /// Fixed metric ratio `1 : denominator` (e.g. `1:200`).
    Ratio {
        /// Scale denominator (> 0).
        #[serde(deserialize_with = "deserialize_json_u32")]
        denominator: u32,
    },
    /// US customary architectural/engineering scale (`inches` on paper = `feet` on ground, `2.1-Q356`).
    Customary {
        /// Paper inches (> 0).
        inches: f64,
        /// Ground feet (> 0).
        feet: f64,
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
