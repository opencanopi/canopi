//! Tests for `views`, a module of their own so the file keeps under the file-size limit.

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
        let view: SavedView = serde_json::from_value(view_value(camera(lon, lat, zoom, bearing)))
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
        let error = validate_views_and_stories(&[view], &[]).expect_err("ground size is invalid");
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
        validate_views_and_stories(std::slice::from_ref(&view), &[story.clone(), story.clone()]),
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
        let error = validate_views_and_stories(&[view], &[]).expect_err("link scheme is refused");
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
    validate_views_and_stories(&[valid_view()], &[at_cap]).expect("an image at the cap is allowed");

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
