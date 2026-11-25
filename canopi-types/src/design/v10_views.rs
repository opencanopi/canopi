//! Saved view, rich text, and story v10 structs with Q69 extension bags and M481 defaults
//! matching `canopi-format/spec/v10/read-schema.json` (`2.1-Q69`, `2.1-M481`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::settings::PlantLabels;
use crate::views::{
    RichTextBlock, RichTextListItem, RichTextSpan, SavedView, SavedViewBackground, SavedViewCamera,
    SavedViewGroundSize, SavedViewHighlight, SavedViewLayers, SavedViewObject, SavedViewTerrain,
    Story, StoryImage, StoryStep,
};

/// Saved view in v10 with M481 defaults and Q69 extension bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SavedViewV10 {
    /// Stable view id.
    pub id: String,
    /// Display name (default `""`).
    #[serde(default)]
    pub name: String,
    /// Saved camera framing.
    pub camera: SavedViewCameraV10,
    /// Visible layers in this view (default all standard layers).
    #[serde(default)]
    pub visible_layers: SavedViewLayersV10,
    /// Highlighted species and objects (default empty).
    #[serde(default)]
    pub highlighted: SavedViewHighlightV10,
    /// Optional view title.
    #[serde(default)]
    pub title: Option<String>,
    /// Rich text blocks.
    #[serde(default)]
    pub text: Vec<RichTextBlockV10>,
    /// Optional plant label override.
    #[serde(default)]
    pub labels: Option<PlantLabels>,
    /// Extension bag for unknown view keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Saved view camera in v10 with M481 defaults (`bearing` defaults to `0.0`) and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SavedViewCameraV10 {
    /// Longitude in degrees.
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = -180.0, max = 180.0))
    )]
    pub lon: f64,
    /// Latitude in degrees.
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = -85.0511287798066, max = 85.0511287798066))
    )]
    pub lat: f64,
    /// MapLibre zoom level.
    #[cfg_attr(feature = "design-schema", schemars(range(min = 0.0, max = 27.0)))]
    pub zoom: f64,
    /// Degrees clockwise from north (default `0.0`).
    #[serde(default)]
    #[cfg_attr(feature = "design-schema", schemars(range(min = 0.0, max = 360.0)))]
    pub bearing: f64,
    /// Framed ground size in metres.
    pub ground_size_m: SavedViewGroundSizeV10,
    /// Extension bag for unknown camera keys (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Framed ground size in metres with Q69 extension bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SavedViewGroundSizeV10 {
    /// Ground width in metres.
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = 0.0, max = 100_000_000.0))
    )]
    pub width: f64,
    /// Ground height in metres.
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = 0.0, max = 100_000_000.0))
    )]
    pub height: f64,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Visible layers band in a v10 saved view with M481 defaults and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SavedViewLayersV10 {
    /// Map background (default `none`).
    #[serde(default)]
    pub background: SavedViewBackgroundV10,
    /// Terrain overlays (default false/false).
    #[serde(default)]
    pub terrain: SavedViewTerrainV10,
    /// Scene layer names (default all four standard layers).
    #[serde(default = "default_scene_layers")]
    pub scene_layers: Vec<String>,
    /// Site data entry ids (default empty).
    #[serde(default)]
    pub site_data: Vec<String>,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for SavedViewLayersV10 {
    fn default() -> Self {
        Self {
            background: SavedViewBackgroundV10::default(),
            terrain: SavedViewTerrainV10::default(),
            scene_layers: default_scene_layers(),
            site_data: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

/// Map background band in a v10 saved view with Q69 extension bags.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SavedViewBackgroundV10 {
    /// OpenFreeMap basemap style.
    Basemap {
        /// Basemap style id.
        style: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Satellite imagery.
    Satellite {
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// No background.
    None {
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
}

impl Default for SavedViewBackgroundV10 {
    fn default() -> Self {
        Self::None {
            extra: BTreeMap::new(),
        }
    }
}

/// Terrain overlays in a v10 saved view with M481 defaults and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SavedViewTerrainV10 {
    /// Whether contour lines are shown (default `false`).
    #[serde(default)]
    pub contours: bool,
    /// Whether hillshade is shown (default `false`).
    #[serde(default)]
    pub hillshade: bool,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Highlighted species and objects in a v10 saved view with M481 defaults and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SavedViewHighlightV10 {
    /// Canonical species names (default empty).
    #[serde(default)]
    pub species: Vec<String>,
    /// Highlighted object references (default empty).
    #[serde(default)]
    pub objects: Vec<SavedViewObjectV10>,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Highlighted object reference in a v10 saved view with Q69 extension bags.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SavedViewObjectV10 {
    /// Plant id.
    Plant {
        /// Object id.
        id: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Zone id.
    Zone {
        /// Object id.
        id: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Annotation id.
    Annotation {
        /// Object id.
        id: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Measurement guide id.
    MeasurementGuide {
        /// Object id.
        id: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Group id.
    Group {
        /// Object id.
        id: String,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
}

/// Portable rich text block in v10 with M481 defaults and Q69 extension bags.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RichTextBlockV10 {
    /// Paragraph of inline spans.
    Paragraph {
        /// Inline spans (default empty).
        #[serde(default)]
        spans: Vec<RichTextSpanV10>,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
    /// Bulleted list.
    Bullets {
        /// List items (default empty).
        #[serde(default)]
        items: Vec<RichTextListItemV10>,
        /// Extension bag (`2.1-Q69`).
        #[serde(flatten)]
        #[specta(skip)]
        extra: BTreeMap<String, serde_json::Value>,
    },
}

/// Rich text list item in v10 with M481 default and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RichTextListItemV10 {
    /// Inline spans (default empty).
    #[serde(default)]
    pub spans: Vec<RichTextSpanV10>,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Rich text span in v10 with M481 defaults and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RichTextSpanV10 {
    /// Run text (default `""`).
    #[serde(default)]
    pub text: String,
    /// Bold mark (default `false`).
    #[serde(default)]
    pub bold: bool,
    /// Italic mark (default `false`).
    #[serde(default)]
    pub italic: bool,
    /// Optional link URI.
    #[serde(default)]
    pub link: Option<String>,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Story in v10 with M481 defaults and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StoryV10 {
    /// Stable story id.
    pub id: String,
    /// Story name (default `""`).
    #[serde(default)]
    pub name: String,
    /// Ordered steps (default empty).
    #[serde(default)]
    pub steps: Vec<StoryStepV10>,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Story step in v10 with M481 defaults and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StoryStepV10 {
    /// Stable step id.
    pub id: String,
    /// Referenced `SavedViewV10::id`.
    pub view_id: String,
    /// Step title (default `""`).
    #[serde(default)]
    pub title: String,
    /// Rich text blocks (default empty).
    #[serde(default)]
    pub text: Vec<RichTextBlockV10>,
    /// Attached images (default empty).
    #[serde(default)]
    pub images: Vec<StoryImageV10>,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Story image in v10 with M481 defaults and Q69 bag.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StoryImageV10 {
    /// Image `https:` URL or `data:image/` URI.
    pub src: String,
    /// Alternative text (default `""`).
    #[serde(default)]
    pub alt: String,
    /// Extension bag (`2.1-Q69`).
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl SavedViewCameraV10 {
    pub(crate) fn to_v9(&self) -> SavedViewCamera {
        SavedViewCamera {
            lon: self.lon,
            lat: self.lat,
            zoom: self.zoom,
            bearing: self.bearing,
            ground_size_m: SavedViewGroundSize {
                width: self.ground_size_m.width,
                height: self.ground_size_m.height,
            },
        }
    }
}

impl SavedViewV10 {
    pub(crate) fn to_v9(&self) -> SavedView {
        SavedView {
            id: self.id.clone(),
            name: self.name.clone(),
            camera: self.camera.to_v9(),
            visible_layers: SavedViewLayers {
                background: match &self.visible_layers.background {
                    SavedViewBackgroundV10::Basemap { style, .. } => SavedViewBackground::Basemap {
                        style: style.clone(),
                    },
                    SavedViewBackgroundV10::Satellite { .. } => SavedViewBackground::Satellite,
                    SavedViewBackgroundV10::None { .. } => SavedViewBackground::None,
                },
                terrain: SavedViewTerrain {
                    contours: self.visible_layers.terrain.contours,
                    hillshade: self.visible_layers.terrain.hillshade,
                },
                scene_layers: self.visible_layers.scene_layers.clone(),
                site_data: self.visible_layers.site_data.clone(),
            },
            highlighted: SavedViewHighlight {
                species: self.highlighted.species.clone(),
                objects: self
                    .highlighted
                    .objects
                    .iter()
                    .map(|o| match o {
                        SavedViewObjectV10::Plant { id, .. } => {
                            SavedViewObject::Plant { id: id.clone() }
                        }
                        SavedViewObjectV10::Zone { id, .. } => {
                            SavedViewObject::Zone { id: id.clone() }
                        }
                        SavedViewObjectV10::Annotation { id, .. } => {
                            SavedViewObject::Annotation { id: id.clone() }
                        }
                        SavedViewObjectV10::MeasurementGuide { id, .. } => {
                            SavedViewObject::MeasurementGuide { id: id.clone() }
                        }
                        SavedViewObjectV10::Group { id, .. } => {
                            SavedViewObject::Group { id: id.clone() }
                        }
                    })
                    .collect(),
            },
            title: self.title.clone(),
            text: self.text.iter().map(RichTextBlockV10::to_v9).collect(),
            labels: self.labels,
        }
    }
}

impl RichTextBlockV10 {
    pub(crate) fn to_v9(&self) -> RichTextBlock {
        match self {
            Self::Paragraph { spans, .. } => RichTextBlock::Paragraph {
                spans: spans.iter().map(RichTextSpanV10::to_v9).collect(),
            },
            Self::Bullets { items, .. } => RichTextBlock::Bullets {
                items: items
                    .iter()
                    .map(|item| RichTextListItem {
                        spans: item.spans.iter().map(RichTextSpanV10::to_v9).collect(),
                    })
                    .collect(),
            },
        }
    }
}

impl RichTextSpanV10 {
    pub(crate) fn to_v9(&self) -> RichTextSpan {
        RichTextSpan {
            text: self.text.clone(),
            bold: self.bold,
            italic: self.italic,
            link: self.link.clone(),
        }
    }
}

impl StoryV10 {
    pub(crate) fn to_v9(&self) -> Story {
        Story {
            id: self.id.clone(),
            name: self.name.clone(),
            steps: self
                .steps
                .iter()
                .map(|step| StoryStep {
                    id: step.id.clone(),
                    view_id: step.view_id.clone(),
                    title: step.title.clone(),
                    text: step.text.iter().map(RichTextBlockV10::to_v9).collect(),
                    images: step
                        .images
                        .iter()
                        .map(|img| StoryImage {
                            src: img.src.clone(),
                            alt: img.alt.clone(),
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

fn default_scene_layers() -> Vec<String> {
    vec![
        "zones".to_owned(),
        "plants".to_owned(),
        "measurement-guides".to_owned(),
        "annotations".to_owned(),
    ]
}
