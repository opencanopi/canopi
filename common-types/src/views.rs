//! Saved views and stories: Design Edit data carried in `.canopi` (ADR 0011).
//!
//! A saved view is a named map view; a story is an ordered list of steps that
//! each show one saved view with rich text and optional images. Positions are
//! WGS84 lon/lat like every other persisted position.

use serde::{Deserialize, Serialize};
use specta::Type;

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
/// within the per-image and per-Design caps.
pub fn validate_views_and_stories(views: &[SavedView], stories: &[Story]) -> Result<(), String> {
    let mut view_ids = std::collections::HashSet::new();
    for (index, view) in views.iter().enumerate() {
        if !view_ids.insert(view.id.as_str()) {
            return Err(format!(
                "$.views[{index}].id: duplicate saved view id {:?}",
                view.id
            ));
        }
        validate_camera(&view.camera, &format!("$.views[{index}].camera"))?;
        validate_rich_text(&view.text, &format!("$.views[{index}].text"))?;
    }

    let mut story_ids = std::collections::HashSet::new();
    let mut embedded_bytes = 0usize;
    for (story_index, story) in stories.iter().enumerate() {
        if !story_ids.insert(story.id.as_str()) {
            return Err(format!(
                "$.stories[{story_index}].id: duplicate story id {:?}",
                story.id
            ));
        }
        let mut step_ids = std::collections::HashSet::new();
        for (step_index, step) in story.steps.iter().enumerate() {
            let path = format!("$.stories[{story_index}].steps[{step_index}]");
            if !step_ids.insert(step.id.as_str()) {
                return Err(format!("{path}.id: duplicate step id {:?}", step.id));
            }
            if !view_ids.contains(step.view_id.as_str()) {
                return Err(format!("{path}.view_id: no saved view {:?}", step.view_id));
            }
            validate_rich_text(&step.text, &format!("{path}.text"))?;
            for (image_index, image) in step.images.iter().enumerate() {
                let image_path = format!("{path}.images[{image_index}].src");
                let bytes = story_image_embedded_bytes(&image.src)
                    .map_err(|reason| format!("{image_path}: {reason}"))?;
                if bytes > STORY_IMAGE_MAX_BYTES {
                    return Err(format!(
                        "{image_path}: an embedded image holds at most {STORY_IMAGE_MAX_BYTES} bytes"
                    ));
                }
                embedded_bytes += bytes;
                if embedded_bytes > STORY_IMAGES_MAX_TOTAL_BYTES {
                    return Err(format!(
                        "{image_path}: a Design embeds at most {STORY_IMAGES_MAX_TOTAL_BYTES} bytes of images"
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Check the view a Design was saved with (`$.map_view`) by the saved-view
/// camera rules.
pub fn validate_map_view(map_view: Option<&SavedViewCamera>) -> Result<(), String> {
    map_view.map_or(Ok(()), |camera| validate_camera(camera, "$.map_view"))
}

fn validate_camera(camera: &SavedViewCamera, path: &str) -> Result<(), String> {
    if !camera.is_valid() {
        return Err(format!(
            "{path}: expected lon in [-180, 180], a Web Mercator latitude (±{WEB_MERCATOR_MAX_LATITUDE_DEG}), zoom in [0, {SAVED_VIEW_MAX_ZOOM}] and bearing in [0, 360]"
        ));
    }
    if !camera.ground_size_m.is_valid() {
        return Err(format!(
            "{path}.ground_size_m: expected a finite width and height above 0 and at most {SAVED_VIEW_MAX_GROUND_SIZE_M} m"
        ));
    }
    Ok(())
}

fn validate_rich_text(blocks: &[RichTextBlock], path: &str) -> Result<(), String> {
    for (block_index, block) in blocks.iter().enumerate() {
        match block {
            RichTextBlock::Paragraph { spans } => {
                validate_spans(spans, &format!("{path}[{block_index}]"))?;
            }
            RichTextBlock::Bullets { items } => {
                for (item_index, item) in items.iter().enumerate() {
                    validate_spans(
                        &item.spans,
                        &format!("{path}[{block_index}].items[{item_index}]"),
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn validate_spans(spans: &[RichTextSpan], path: &str) -> Result<(), String> {
    for (span_index, span) in spans.iter().enumerate() {
        let Some(link) = &span.link else { continue };
        let allowed = RICH_TEXT_LINK_SCHEMES
            .iter()
            .any(|scheme| starts_with_ignore_case(link, scheme));
        if !allowed {
            return Err(format!(
                "{path}.spans[{span_index}].link: links must be https:, http: or mailto:"
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
mod tests {
    use super::*;
    use serde_json::json;

    fn view_value(camera: serde_json::Value) -> serde_json::Value {
        json!({
            "id": "view-1",
            "name": "Orchard",
            "camera": camera,
            "visible_layers": {
                "background": { "kind": "basemap", "style": "liberty" },
                "terrain": { "contours": false, "hillshade": true },
                "scene_layers": ["plants", "zones"],
                "site_data": ["lidar-dtm-1"]
            },
            "highlighted": {
                "species": ["Malus domestica"],
                "objects": [
                    { "kind": "plant", "id": "plant-1" },
                    { "kind": "measurement_guide", "id": "guide-1" }
                ]
            },
            "title": null,
            "text": [],
            "labels": null
        })
    }

    fn camera(lon: f64, lat: f64, zoom: f64, bearing: f64) -> serde_json::Value {
        json!({
            "lon": lon, "lat": lat, "zoom": zoom, "bearing": bearing,
            "ground_size_m": { "width": 312.5, "height": 200.25 }
        })
    }

    #[test]
    fn saved_views_round_trip_with_typed_objects_and_rich_text() {
        let mut value = view_value(camera(2.2945, 48.8584, 18.5, 0.0));
        value["text"] = json!([
            { "kind": "paragraph", "spans": [
                { "text": "Goji ", "bold": true, "italic": false, "link": null },
                { "text": "hedge", "bold": false, "italic": true, "link": "https://example.org" }
            ] },
            { "kind": "bullets", "items": [
                { "spans": [{ "text": "Year one", "bold": false, "italic": false, "link": null }] }
            ] }
        ]);
        let view: SavedView = serde_json::from_value(value.clone()).expect("view should parse");
        assert_eq!(
            view.highlighted.objects[1],
            SavedViewObject::MeasurementGuide {
                id: "guide-1".to_owned()
            }
        );
        assert_eq!(serde_json::to_value(&view).expect("serialize"), value);
    }

    #[test]
    fn a_view_keeps_the_plant_labels_it_was_saved_with_and_writes_null_when_unset() {
        let mut value = view_value(camera(2.2945, 48.8584, 18.5, 0.0));
        let unset: SavedView = serde_json::from_value(value.clone()).expect("view should parse");
        assert_eq!(unset.labels, None);
        assert_eq!(serde_json::to_value(&unset).expect("serialize"), value);

        value["labels"] = json!("codes");
        let labelled: SavedView = serde_json::from_value(value.clone()).expect("view should parse");
        assert_eq!(labelled.labels, Some(crate::settings::PlantLabels::Codes));
        assert_eq!(serde_json::to_value(&labelled).expect("serialize"), value);

        value["labels"] = json!("everything");
        assert!(serde_json::from_value::<SavedView>(value.clone()).is_err());

        let older = value.as_object_mut().expect("object");
        older.remove("labels");
        let missing: SavedView = serde_json::from_value(value).expect("view should parse");
        assert_eq!(missing.labels, None);
    }

    #[test]
    fn rich_text_marks_default_to_plain() {
        let span: RichTextSpan =
            serde_json::from_value(json!({ "text": "plain" })).expect("span should parse");
        assert!(!span.bold && !span.italic && span.link.is_none());
    }

    #[test]
    fn view_cameras_must_be_on_the_map_with_in_range_zoom_and_bearing() {
        for (lon, lat, zoom, bearing) in [
            (180.5, 0.0, 10.0, 0.0),
            (0.0, 86.0, 10.0, 0.0),
            (0.0, 0.0, 27.5, 0.0),
            (0.0, 0.0, -1.0, 0.0),
            (0.0, 0.0, 10.0, 361.0),
        ] {
            let view: SavedView =
                serde_json::from_value(view_value(camera(lon, lat, zoom, bearing)))
                    .expect("view should parse");
            let error = validate_views_and_stories(&[view], &[]).expect_err("camera is invalid");
            assert!(error.starts_with("$.views[0].camera"), "{error}");
        }
    }

    #[test]
    fn a_view_without_its_ground_size_is_refused() {
        // Every view records the ground it framed (U33): one without it, or
        // with a null one, does not load.
        for ground in [None, Some(serde_json::Value::Null)] {
            let mut value = view_value(camera(2.0, 48.0, 17.0, 0.0));
            let camera = value["camera"].as_object_mut().expect("camera object");
            camera.remove("ground_size_m");
            if let Some(ground) = ground {
                camera.insert("ground_size_m".to_owned(), ground);
            }
            assert!(serde_json::from_value::<SavedView>(value).is_err());
        }
    }

    #[test]
    fn an_older_extent_record_is_dropped_on_load() {
        let mut value = view_value(camera(2.0, 48.0, 17.0, 0.0));
        value["extent"] = json!({ "west": 1.99, "south": 47.995, "east": 2.01, "north": 48.005 });
        let view: SavedView = serde_json::from_value(value).expect("view should parse");
        let written = serde_json::to_value(&view).expect("serialize");
        assert!(written.get("extent").is_none(), "{written}");
    }

    #[test]
    fn view_ground_sizes_round_trip_and_must_be_positive_finite_and_at_most_1e8_m() {
        let mut ground = camera(2.0, 48.0, 17.0, 30.0);
        ground["ground_size_m"] = json!({ "width": 312.5, "height": 200.25 });
        let value = view_value(ground);
        let view: SavedView = serde_json::from_value(value.clone()).expect("view should parse");
        assert_eq!(
            view.camera.ground_size_m,
            SavedViewGroundSize {
                width: 312.5,
                height: 200.25
            }
        );
        assert_eq!(serde_json::to_value(&view).expect("serialize"), value);
        validate_views_and_stories(&[view], &[]).expect("a positive ground size is valid");

        let mut largest = valid_view();
        largest.camera.ground_size_m = SavedViewGroundSize {
            width: SAVED_VIEW_MAX_GROUND_SIZE_M,
            height: SAVED_VIEW_MAX_GROUND_SIZE_M,
        };
        validate_views_and_stories(&[largest], &[]).expect("1e8 m is the largest ground size");

        for (width, height) in [
            (0.0, 200.0),
            (312.0, -1.0),
            (f64::NAN, 200.0),
            (312.0, f64::INFINITY),
            (1.000_000_1e8, 200.0),
        ] {
            let mut view = valid_view();
            view.camera.ground_size_m = SavedViewGroundSize { width, height };
            let error =
                validate_views_and_stories(&[view], &[]).expect_err("ground size is invalid");
            assert!(
                error.starts_with("$.views[0].camera.ground_size_m: "),
                "{error}"
            );
        }
    }

    #[test]
    fn story_steps_must_name_a_saved_view() {
        let view: SavedView = serde_json::from_value(view_value(camera(2.0, 48.0, 17.0, 0.0)))
            .expect("view should parse");
        let story = |view_id: &str| -> Story {
            serde_json::from_value(json!({
                "id": "story-1",
                "name": "Visit",
                "steps": [{ "id": "step-1", "view_id": view_id, "title": "The site" }]
            }))
            .expect("story should parse")
        };
        validate_views_and_stories(std::slice::from_ref(&view), &[story("view-1")])
            .expect("known view is valid");
        assert_eq!(
            validate_views_and_stories(&[view], &[story("missing")]),
            Err("$.stories[0].steps[0].view_id: no saved view \"missing\"".to_owned()),
        );
    }

    fn valid_view() -> SavedView {
        serde_json::from_value(view_value(camera(2.0, 48.0, 17.0, 0.0))).expect("view should parse")
    }

    fn story_with_step(step: serde_json::Value) -> Story {
        serde_json::from_value(json!({ "id": "story-1", "name": "Visit", "steps": [step] }))
            .expect("story should parse")
    }

    fn step_with_images(images: serde_json::Value) -> serde_json::Value {
        json!({ "id": "step-1", "view_id": "view-1", "title": "Hedge", "images": images })
    }

    fn data_uri(mime: &str, decoded_bytes: usize) -> String {
        // 3 decoded bytes per 4 base64 characters; pad the tail like a real encoder.
        let full = decoded_bytes / 3;
        let rest = decoded_bytes % 3;
        let mut payload = "AAAA".repeat(full);
        match rest {
            1 => payload.push_str("AA=="),
            2 => payload.push_str("AAA="),
            _ => {}
        }
        format!("data:{mime};base64,{payload}")
    }

    #[test]
    fn saved_view_and_story_ids_are_unique() {
        let view = valid_view();
        assert_eq!(
            validate_views_and_stories(&[view.clone(), view.clone()], &[]),
            Err("$.views[1].id: duplicate saved view id \"view-1\"".to_owned()),
        );
        let story = story_with_step(json!({ "id": "step-1", "view_id": "view-1", "title": "A" }));
        assert_eq!(
            validate_views_and_stories(
                std::slice::from_ref(&view),
                &[story.clone(), story.clone()]
            ),
            Err("$.stories[1].id: duplicate story id \"story-1\"".to_owned()),
        );
        let mut twice = story;
        twice.steps.push(twice.steps[0].clone());
        assert_eq!(
            validate_views_and_stories(&[view], &[twice]),
            Err("$.stories[0].steps[1].id: duplicate step id \"step-1\"".to_owned()),
        );
    }

    #[test]
    fn rich_text_links_open_only_web_and_mail_schemes() {
        for link in [
            "https://example.org",
            "http://example.org",
            "mailto:a@example.org",
            "HTTPS://EXAMPLE.ORG",
        ] {
            let mut view = valid_view();
            view.text = serde_json::from_value(json!([
                { "kind": "paragraph", "spans": [{ "text": "x", "link": link }] }
            ]))
            .expect("text should parse");
            validate_views_and_stories(&[view], &[]).expect("allowed link scheme");
        }
        for link in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,x",
            "example.org",
            " https://x",
        ] {
            let mut view = valid_view();
            view.text = serde_json::from_value(json!([
                { "kind": "bullets", "items": [{ "spans": [{ "text": "x", "link": link }] }] }
            ]))
            .expect("text should parse");
            let error =
                validate_views_and_stories(&[view], &[]).expect_err("link scheme is refused");
            assert_eq!(
                error,
                "$.views[0].text[0].items[0].spans[0].link: links must be https:, http: or mailto:",
                "{link}"
            );
        }
        let step = story_with_step(json!({
            "id": "step-1", "view_id": "view-1", "title": "A",
            "text": [{ "kind": "paragraph", "spans": [{ "text": "x", "link": "vbscript:x" }] }]
        }));
        let error =
            validate_views_and_stories(&[valid_view()], &[step]).expect_err("step link is refused");
        assert!(
            error.starts_with("$.stories[0].steps[0].text[0].spans[0].link"),
            "{error}"
        );
    }

    #[test]
    fn story_images_are_https_links_or_embedded_raster_images() {
        for src in [
            "https://example.org/hedge.jpg".to_owned(),
            data_uri("image/png", 10),
            data_uri("image/jpeg", 11),
            data_uri("image/webp", 12),
            data_uri("image/gif", 3),
        ] {
            let story = story_with_step(step_with_images(json!([{ "src": src, "alt": "Hedge" }])));
            validate_views_and_stories(&[valid_view()], &[story]).expect("image source is allowed");
        }
        for src in [
            "http://example.org/hedge.jpg",
            "file:///tmp/hedge.jpg",
            "hedge.jpg",
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            "data:text/html;base64,PGI+PC9iPg==",
            "data:image/png,rawbytes",
            "data:image/png;base64,not base64!",
            "data:image/png;base64,AAA",
        ] {
            let story = story_with_step(step_with_images(json!([{ "src": src }])));
            let error = validate_views_and_stories(&[valid_view()], &[story])
                .expect_err("image source is refused");
            assert!(
                error.starts_with("$.stories[0].steps[0].images[0].src: "),
                "{src}: {error}"
            );
        }
    }

    #[test]
    fn an_embedded_image_holds_at_most_one_megabyte() {
        let at_cap = story_with_step(step_with_images(
            json!([{ "src": data_uri("image/jpeg", STORY_IMAGE_MAX_BYTES) }]),
        ));
        validate_views_and_stories(&[valid_view()], &[at_cap])
            .expect("an image at the cap is allowed");

        let over = story_with_step(step_with_images(
            json!([{ "src": data_uri("image/jpeg", STORY_IMAGE_MAX_BYTES + 1) }]),
        ));
        assert_eq!(
            validate_views_and_stories(&[valid_view()], &[over]),
            Err(format!(
                "$.stories[0].steps[0].images[0].src: an embedded image holds at most {STORY_IMAGE_MAX_BYTES} bytes"
            )),
        );
    }

    #[test]
    fn a_design_embeds_at_most_ten_megabytes_of_images() {
        let image = json!({ "src": data_uri("image/png", STORY_IMAGE_MAX_BYTES) });
        let steps = |count: usize, prefix: &str| -> Vec<serde_json::Value> {
            (0..count)
                .map(|index| json!({ "id": format!("{prefix}-{index}"), "view_id": "view-1", "title": "A", "images": [image.clone()] }))
                .collect()
        };
        let story = |id: &str, steps: Vec<serde_json::Value>| -> Story {
            serde_json::from_value(json!({ "id": id, "name": id, "steps": steps }))
                .expect("story should parse")
        };
        assert_eq!(STORY_IMAGES_MAX_TOTAL_BYTES, 10 * STORY_IMAGE_MAX_BYTES);
        let full = [story("a", steps(6, "a")), story("b", steps(4, "b"))];
        validate_views_and_stories(&[valid_view()], &full).expect("ten full images fit");

        let mut over = full.to_vec();
        over[1].steps[3].images.push(StoryImage {
            src: data_uri("image/png", 1),
            alt: String::new(),
        });
        assert_eq!(
            validate_views_and_stories(&[valid_view()], &over),
            Err(format!(
                "$.stories[1].steps[3].images[1].src: a Design embeds at most {STORY_IMAGES_MAX_TOTAL_BYTES} bytes of images"
            )),
        );
    }
}
