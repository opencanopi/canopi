//! Saved views and stories: Design Edit data carried in `.canopi` (ADR 0011).
//!
//! A saved view is a named map view; a story is an ordered list of steps that
//! each show one saved view with rich text and optional images. Positions are
//! WGS84 lon/lat like every other persisted position.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::design::field_path::{FieldPath, Refusal};
use crate::design::{GeoPoint, WEB_MERCATOR_MAX_LATITUDE_DEG};

/// Highest MapLibre zoom a saved view may hold (the workspace map's maximum).
pub const SAVED_VIEW_MAX_ZOOM: f64 = 27.0;

/// Largest ground side a saved view may frame, in metres (far beyond one world).
pub const SAVED_VIEW_MAX_GROUND_SIZE_M: f64 = 1e8;

// A named map view of a Design.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub camera: SavedViewCamera,
    pub visible_layers: SavedViewLayers,
    pub highlighted: SavedViewHighlight,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub title: Option<String>,
    #[serde(default)]
    pub text: Vec<RichTextBlock>,
    // How the view shows plant labels, recorded at capture; null (or a missing
    // key) shows the Design's labels.
    #[serde(default)]
    pub labels: Option<crate::settings::PlantLabels>,
}

// Camera of a saved view: centre, zoom and bearing (degrees clockwise from
// north, written normalised to [0, 360)), and the ground the view framed.
// Going to the view restores the centre and bearing, never snapped, and fits
// the framed ground into the window, never zooming in past the saved zoom
// (ADR 0011).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SavedViewCamera {
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = -180.0, max = 180.0))
    )]
    pub lon: f64,
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = -85.0511287798066, max = 85.0511287798066))
    )]
    pub lat: f64,
    // MapLibre zoom level.
    #[cfg_attr(feature = "design-schema", schemars(range(min = 0.0, max = 27.0)))]
    pub zoom: f64,
    // Degrees clockwise from true north.
    #[cfg_attr(feature = "design-schema", schemars(range(min = 0.0, max = 360.0)))]
    pub bearing: f64,
    // The ground the map showed when the view was saved, in metres in the
    // view's own turned frame, each side clamped to 1e8 m.
    pub ground_size_m: SavedViewGroundSize,
}

// Width (along the view's screen x axis) and height of the ground a saved view
// framed, in metres: positive, finite and at most `SAVED_VIEW_MAX_GROUND_SIZE_M`.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SavedViewGroundSize {
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = 0.0, max = 100_000_000.0))
    )]
    pub width: f64,
    #[cfg_attr(
        feature = "design-schema",
        schemars(range(min = 0.0, max = 100_000_000.0))
    )]
    pub height: f64,
}

impl SavedViewGroundSize {
    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub fn is_valid(&self) -> bool {
        [self.width, self.height]
            .iter()
            .all(|side| side.is_finite() && *side > 0.0 && *side <= SAVED_VIEW_MAX_GROUND_SIZE_M)
    }
}

impl SavedViewCamera {
    #[expect(
        missing_docs,
        reason = "undocumented before 2.1-Q217; document when this file is next touched"
    )]
    pub fn is_valid(&self) -> bool {
        GeoPoint {
            lon: self.lon,
            lat: self.lat,
        }
        .is_valid()
            && self.zoom.is_finite()
            && (0.0..=SAVED_VIEW_MAX_ZOOM).contains(&self.zoom)
            && self.bearing.is_finite()
            && (0.0..=360.0).contains(&self.bearing)
    }
}

// What a saved view shows under and around the design.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SavedViewLayers {
    pub background: SavedViewBackground,
    pub terrain: SavedViewTerrain,
    // Names of the Design layers shown.
    pub scene_layers: Vec<String>,
    // Library ids of the Design's site-data (LiDAR) presentation entries shown.
    pub site_data: Vec<String>,
}

// The map background band of a saved view.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum SavedViewBackground {
    // An OpenFreeMap basemap; `style` is a settings basemap style id.
    Basemap { style: String },
    Satellite,
    None,
}

// Terrain references shown over the background (Desktop draws them).
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SavedViewTerrain {
    pub contours: bool,
    pub hillshade: bool,
}

// Species and design objects a saved view draws attention to.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct SavedViewHighlight {
    // Canonical species names.
    pub species: Vec<String>,
    pub objects: Vec<SavedViewObject>,
}

// A typed design object reference; ids are unique only within a kind.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum SavedViewObject {
    Plant { id: String },
    // A zone, by name.
    Zone { id: String },
    Annotation { id: String },
    MeasurementGuide { id: String },
    Group { id: String },
}

// One block of portable rich text. There is no raw HTML.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub enum RichTextBlock {
    Paragraph { spans: Vec<RichTextSpan> },
    Bullets { items: Vec<RichTextListItem> },
}

#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct RichTextListItem {
    pub spans: Vec<RichTextSpan>,
}

// A run of text with inline marks. Viewers open only `https:`, `http:` and
// `mailto:` links.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct RichTextSpan {
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[cfg_attr(feature = "design-schema", schemars(default))]
    pub link: Option<String>,
}

// An ordered presentation of saved views.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct Story {
    pub id: String,
    pub name: String,
    pub steps: Vec<StoryStep>,
}

// One step of a story: the saved view it shows, with its title and text.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct StoryStep {
    pub id: String,
    // The `SavedView::id` this step shows; it must exist in the same Design.
    pub view_id: String,
    pub title: String,
    #[serde(default)]
    pub text: Vec<RichTextBlock>,
    #[serde(default)]
    pub images: Vec<StoryImage>,
}

// An image shown with a story step: an `https:` URL or a `data:image/` URI.
#[cfg_attr(feature = "design-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[expect(
    missing_docs,
    reason = "undocumented before 2.1-Q217; document when this file is next touched"
)]
pub struct StoryImage {
    pub src: String,
    #[serde(default)]
    pub alt: String,
}

/// Link schemes a viewer may open from rich text, compared without case.
pub const RICH_TEXT_LINK_SCHEMES: &[&str] = &["https:", "http:", "mailto:"];

/// Media types a story image may embed as a base64 `data:` URI. SVG is refused
/// because it can carry scripts.
pub const STORY_IMAGE_DATA_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

/// Most decoded bytes one embedded story image may hold (1 MiB).
pub const STORY_IMAGE_MAX_BYTES: usize = 1024 * 1024;

/// Most decoded bytes of embedded story images one Design may hold (10 MiB).
pub const STORY_IMAGES_MAX_TOTAL_BYTES: usize = 10 * STORY_IMAGE_MAX_BYTES;

/// Check the saved views and stories of an admitted Design: ids are unique,
/// every camera is a valid WGS84 position with an in-range zoom and bearing,
/// every recorded ground size is positive and at most 1e8 m,
/// every story step names a saved view of the same Design, rich-text links use
/// an allowed scheme, and images are `https:` links or embedded raster images
/// within the per-image and per-Design caps. A refusal names its field, never a value.
pub fn validate_views_and_stories(views: &[SavedView], stories: &[Story]) -> Result<(), Refusal> {
    let root = FieldPath::root();
    let mut view_ids = std::collections::HashSet::new();
    for (index, view) in views.iter().enumerate() {
        let path = root.field("views").index(index);
        if !view_ids.insert(view.id.as_str()) {
            return Err(Refusal::new(
                path.field("id"),
                "expected a unique saved view id",
            ));
        }
        validate_camera(&view.camera, &path.field("camera"))?;
        validate_rich_text(&view.text, &path.field("text"))?;
    }

    let mut story_ids = std::collections::HashSet::new();
    let mut embedded_bytes = 0usize;
    for (story_index, story) in stories.iter().enumerate() {
        let story_path = root.field("stories").index(story_index);
        if !story_ids.insert(story.id.as_str()) {
            return Err(Refusal::new(
                story_path.field("id"),
                "expected a unique story id",
            ));
        }
        let mut step_ids = std::collections::HashSet::new();
        for (step_index, step) in story.steps.iter().enumerate() {
            let path = story_path.field("steps").index(step_index);
            if !step_ids.insert(step.id.as_str()) {
                return Err(Refusal::new(path.field("id"), "expected a unique step id"));
            }
            if !view_ids.contains(step.view_id.as_str()) {
                let expected = "expected the id of a saved view in this Design";
                return Err(Refusal::new(path.field("view_id"), expected));
            }
            validate_rich_text(&step.text, &path.field("text"))?;
            for (image_index, image) in step.images.iter().enumerate() {
                let image_path = path.field("images").index(image_index).field("src");
                let bytes = story_image_embedded_bytes(&image.src)
                    .map_err(|reason| Refusal::new(image_path.clone(), reason))?;
                if bytes > STORY_IMAGE_MAX_BYTES {
                    let expected =
                        format!("an embedded image holds at most {STORY_IMAGE_MAX_BYTES} bytes");
                    return Err(Refusal::new(image_path, expected));
                }
                embedded_bytes += bytes;
                if embedded_bytes > STORY_IMAGES_MAX_TOTAL_BYTES {
                    let expected = format!(
                        "a Design embeds at most {STORY_IMAGES_MAX_TOTAL_BYTES} bytes of images"
                    );
                    return Err(Refusal::new(image_path, expected));
                }
            }
        }
    }
    Ok(())
}

/// Check the view a Design was saved with (`$.map_view`) by the saved-view
/// camera rules.
pub fn validate_map_view(map_view: Option<&SavedViewCamera>) -> Result<(), Refusal> {
    map_view.map_or(Ok(()), |camera| {
        validate_camera(camera, &FieldPath::root().field("map_view"))
    })
}

/// A camera's leaf at fault, in the schema's sorted field order; its ground size as a whole,
/// as the Web names it.
fn validate_camera(camera: &SavedViewCamera, path: &FieldPath) -> Result<(), Refusal> {
    let in_range =
        |value: f64, min: f64, max: f64| value.is_finite() && (min..=max).contains(&value);
    if !in_range(camera.bearing, 0.0, 360.0) {
        return Err(Refusal::new(
            path.field("bearing"),
            "expected bearing in [0, 360]",
        ));
    }
    let ground = path.field("ground_size_m");
    if !camera.ground_size_m.is_valid() {
        let expected = format!(
            "expected a finite width and height above 0 and at most {SAVED_VIEW_MAX_GROUND_SIZE_M} m"
        );
        return Err(Refusal::new(ground, expected));
    }
    let lat = WEB_MERCATOR_MAX_LATITUDE_DEG;
    if !in_range(camera.lat, -lat, lat) {
        let expected = format!("expected a Web Mercator latitude in [-{lat}, {lat}]");
        return Err(Refusal::new(path.field("lat"), expected));
    }
    if !in_range(camera.lon, -180.0, 180.0) {
        return Err(Refusal::new(
            path.field("lon"),
            "expected lon in [-180, 180]",
        ));
    }
    if !in_range(camera.zoom, 0.0, SAVED_VIEW_MAX_ZOOM) {
        let expected = format!("expected zoom in [0, {SAVED_VIEW_MAX_ZOOM}]");
        return Err(Refusal::new(path.field("zoom"), expected));
    }
    Ok(())
}

fn validate_rich_text(blocks: &[RichTextBlock], path: &FieldPath) -> Result<(), Refusal> {
    for (block_index, block) in blocks.iter().enumerate() {
        let block_path = path.index(block_index);
        match block {
            RichTextBlock::Paragraph { spans } => validate_spans(spans, &block_path)?,
            RichTextBlock::Bullets { items } => {
                for (item_index, item) in items.iter().enumerate() {
                    validate_spans(&item.spans, &block_path.field("items").index(item_index))?;
                }
            }
        }
    }
    Ok(())
}

fn validate_spans(spans: &[RichTextSpan], path: &FieldPath) -> Result<(), Refusal> {
    for (span_index, span) in spans.iter().enumerate() {
        let Some(link) = &span.link else { continue };
        let allowed = RICH_TEXT_LINK_SCHEMES
            .iter()
            .any(|scheme| starts_with_ignore_case(link, scheme));
        if !allowed {
            let link_path = path.field("spans").index(span_index).field("link");
            return Err(Refusal::new(
                link_path,
                "links must be https:, http: or mailto:",
            ));
        }
    }
    Ok(())
}

/// Decoded bytes an image source embeds: 0 for an `https:` link, the payload
/// size for a base64 raster `data:` URI, an error for anything else.
fn story_image_embedded_bytes(src: &str) -> Result<usize, &'static str> {
    if starts_with_ignore_case(src, "https:") {
        return Ok(0);
    }
    let Some(rest) = src.strip_prefix("data:") else {
        return Err("images must be https: links or embedded PNG, JPEG, WebP or GIF data");
    };
    let Some((media_type, payload)) = rest.split_once(";base64,") else {
        return Err("an embedded image must be base64 data");
    };
    if !STORY_IMAGE_DATA_TYPES.contains(&media_type) {
        return Err("images must be https: links or embedded PNG, JPEG, WebP or GIF data");
    }
    base64_decoded_len(payload).ok_or("an embedded image must be valid base64 data")
}

fn base64_decoded_len(payload: &str) -> Option<usize> {
    let bytes = payload.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2 {
        return None;
    }
    let body = &bytes[..bytes.len() - padding];
    if !body
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
    {
        return None;
    }
    Some(bytes.len() / 4 * 3 - padding)
}

fn starts_with_ignore_case(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

#[cfg(test)]
mod tests;
