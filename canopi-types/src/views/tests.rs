//! Tests for `views`, an out-of-line test module so `views.rs` keeps under the file-size limit.

use super::*;
use serde_json::json;

/// The views and stories check with its refusal as the text a log reads.
fn views_and_stories(views: &[SavedView], stories: &[Story]) -> Result<(), String> {
    validate_views_and_stories(views, stories).map_err(|refusal| refusal.to_string())
}

/// The map view check with its refusal as the text a log reads.
fn map_view_check(map_view: Option<&SavedViewCamera>) -> Result<(), String> {
    validate_map_view(map_view).map_err(|refusal| refusal.to_string())
}

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
    for (lon, lat, zoom, bearing, leaf) in [
        (180.5, 0.0, 10.0, 0.0, "lon"),
        (0.0, 86.0, 10.0, 0.0, "lat"),
        (0.0, 0.0, 27.5, 0.0, "zoom"),
        (0.0, 0.0, -1.0, 0.0, "zoom"),
        (0.0, 0.0, 10.0, 361.0, "bearing"),
        (180.5, 86.0, 27.5, 0.0, "lat"),
    ] {
        let view: SavedView = serde_json::from_value(view_value(camera(lon, lat, zoom, bearing)))
            .expect("view should parse");
        let refusal = validate_views_and_stories(&[view], &[]).expect_err("camera is invalid");
        assert_eq!(
            refusal.field_path.to_string(),
            format!("$.views[0].camera.{leaf}")
        );
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
    views_and_stories(&[view], &[]).expect("a positive ground size is valid");

    let mut largest = valid_view();
    largest.camera.ground_size_m = SavedViewGroundSize {
        width: SAVED_VIEW_MAX_GROUND_SIZE_M,
        height: SAVED_VIEW_MAX_GROUND_SIZE_M,
    };
    views_and_stories(&[largest], &[]).expect("1e8 m is the largest ground size");

    for (width, height) in [
        (0.0, 200.0),
        (312.0, -1.0),
        (f64::NAN, 200.0),
        (312.0, f64::INFINITY),
        (1.000_000_1e8, 200.0),
    ] {
        let mut view = valid_view();
        view.camera.ground_size_m = SavedViewGroundSize { width, height };
        let error = views_and_stories(&[view], &[]).expect_err("ground size is invalid");
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
    views_and_stories(std::slice::from_ref(&view), &[story("view-1")])
        .expect("known view is valid");
    assert_eq!(
        views_and_stories(&[view], &[story("missing")]),
        Err(
            "$.stories[0].steps[0].view_id: expected the id of a saved view in this Design"
                .to_owned()
        ),
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
        views_and_stories(&[view.clone(), view.clone()], &[]),
        Err("$.views[1].id: expected a unique saved view id".to_owned()),
    );
    let story = story_with_step(json!({ "id": "step-1", "view_id": "view-1", "title": "A" }));
    assert_eq!(
        views_and_stories(std::slice::from_ref(&view), &[story.clone(), story.clone()]),
        Err("$.stories[1].id: expected a unique story id".to_owned()),
    );
    let mut twice = story;
    twice.steps.push(twice.steps[0].clone());
    assert_eq!(
        views_and_stories(&[view], &[twice]),
        Err("$.stories[0].steps[1].id: expected a unique step id".to_owned()),
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
        views_and_stories(&[view], &[]).expect("allowed link scheme");
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
        let error = views_and_stories(&[view], &[]).expect_err("link scheme is refused");
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
    let error = views_and_stories(&[valid_view()], &[step]).expect_err("step link is refused");
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
        views_and_stories(&[valid_view()], &[story]).expect("image source is allowed");
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
        let error =
            views_and_stories(&[valid_view()], &[story]).expect_err("image source is refused");
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
    views_and_stories(&[valid_view()], &[at_cap]).expect("an image at the cap is allowed");

    let over = story_with_step(step_with_images(
        json!([{ "src": data_uri("image/jpeg", STORY_IMAGE_MAX_BYTES + 1) }]),
    ));
    assert_eq!(
        views_and_stories(&[valid_view()], &[over]),
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
    views_and_stories(&[valid_view()], &full).expect("ten full images fit");

    let mut over = full.to_vec();
    over[1].steps[3].images.push(StoryImage {
        src: data_uri("image/png", 1),
        alt: String::new(),
    });
    assert_eq!(
        views_and_stories(&[valid_view()], &over),
        Err(format!(
            "$.stories[1].steps[3].images[1].src: a Design embeds at most {STORY_IMAGES_MAX_TOTAL_BYTES} bytes of images"
        )),
    );
}

#[test]
fn a_story_image_whose_base64_holds_plus_and_slash_is_admitted_and_one_outside_base64_is_refused_canopi_f47t_52_228()
 {
    let image = |payload: &str| {
        story_with_step(step_with_images(
            json!([{ "src": format!("data:image/png;base64,{payload}") }]),
        ))
    };
    for payload in ["A+/A", "+/+/", "AB+=", "A/=="] {
        views_and_stories(&[valid_view()], &[image(payload)])
            .unwrap_or_else(|error| panic!("{payload}: {error}"));
    }
    // Each the length of whole base64 quads, so only the alphabet refuses it.
    for payload in ["AA-A", "AA_A", "AA A", "AA.A", "AAé", "A=AA"] {
        assert_eq!(
            views_and_stories(&[valid_view()], &[image(payload)]),
            Err(
                "$.stories[0].steps[0].images[0].src: an embedded image must be valid base64 data"
                    .to_owned()
            ),
            "{payload}"
        );
    }
}

#[test]
fn two_embedded_images_of_1_mib_are_admitted_and_eleven_are_refused_canopi_f47t_52_228() {
    let images = |count: usize| {
        let image = json!({ "src": data_uri("image/png", STORY_IMAGE_MAX_BYTES) });
        story_with_step(step_with_images(serde_json::Value::Array(vec![
            image;
            count
        ])))
    };
    views_and_stories(&[valid_view()], &[images(2)]).expect("two 1 MiB images fit");
    assert_eq!(
        views_and_stories(&[valid_view()], &[images(11)]),
        Err(format!(
            "$.stories[0].steps[0].images[10].src: a Design embeds at most {STORY_IMAGES_MAX_TOTAL_BYTES} bytes of images"
        )),
    );
}

#[test]
fn a_map_view_at_latitude_89_with_zoom_above_the_maximum_or_ground_size_0_is_refused_canopi_f47t_52_228()
 {
    let map_view = |camera: serde_json::Value| -> SavedViewCamera {
        serde_json::from_value(camera).expect("camera should parse")
    };
    map_view_check(Some(&map_view(camera(2.0, 48.0, SAVED_VIEW_MAX_ZOOM, 0.0))))
        .expect("a map view at the maximum zoom is admitted");
    map_view_check(None).expect("a Design without a map view is admitted");
    let off_map = format!(
        "$.map_view.lat: expected a Web Mercator latitude in [-{WEB_MERCATOR_MAX_LATITUDE_DEG}, {WEB_MERCATOR_MAX_LATITUDE_DEG}]"
    );
    let too_close = format!("$.map_view.zoom: expected zoom in [0, {SAVED_VIEW_MAX_ZOOM}]");
    for (camera, expected) in [
        (camera(2.0, 89.0, 17.0, 0.0), &off_map),
        (camera(2.0, -89.0, 17.0, 0.0), &off_map),
        (
            camera(2.0, 48.0, SAVED_VIEW_MAX_ZOOM + 0.5, 0.0),
            &too_close,
        ),
    ] {
        assert_eq!(
            map_view_check(Some(&map_view(camera))),
            Err(expected.clone())
        );
    }
    let ground_size = format!(
        "$.map_view.ground_size_m: expected a finite width and height above 0 and at most {SAVED_VIEW_MAX_GROUND_SIZE_M} m"
    );
    for size in [
        json!({ "width": 0.0, "height": 200.0 }),
        json!({ "width": 312.5, "height": 0.0 }),
    ] {
        let mut zero = camera(2.0, 48.0, 17.0, 0.0);
        zero["ground_size_m"] = size.clone();
        assert_eq!(
            map_view_check(Some(&map_view(zero))),
            Err(ground_size.clone()),
            "{size}"
        );
    }
}
