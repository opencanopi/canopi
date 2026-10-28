//! The updater's check and download driven through the real plugin: a mock app registering it
//! with the shipped settings and an ephemeral key, a local server for the channel file and the
//! payload. The install's cases sit beside it in `install.rs`.
//!
//! Test code only (the inner attribute below); a module of its own so `mod.rs` keeps under the
//! file-size limit.
#![cfg(test)]

use std::time::Duration;

use common_types::update::{
    NetworkFailureKind, UpdateArch, UpdateBundle, UpdateDownload, UpdateFailureCode, UpdateOs,
};

use super::{
    Limits, UpdaterHost,
    testkit::{
        APPIMAGE, DEB, FAST, Offer, Route, Server, TestKey, channel_file, closed_port_url, code,
        elf_payload, mock_app, network, run, scratch, sink,
    },
};
use crate::native_operation::{NativeOperationClass, NativeOperationExecutor};

#[test]
fn a_check_offers_the_newer_release_for_this_installer_once_while_a_second_check_awaits_it() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let host = offer.host(APPIMAGE, FAST);
    let executor = NativeOperationExecutor::production();
    let body = channel_file("9.0.0", &APPIMAGE.key(), &offer.server.url("/payload"), "x");
    offer.server.route(
        "/stable.json",
        Route::Slow(Duration::from_millis(300), body),
    );

    let (first, second) = run(async {
        tokio::join!(
            host.check(app.handle(), &executor),
            host.check(app.handle(), &executor)
        )
    });

    let offered = first.unwrap().unwrap();
    assert_eq!(offered.version, "9.0.0");
    assert_eq!(offered.date.as_deref(), Some("2026-11-02T00:00:00Z"));
    assert_eq!(
        offered.notes_url,
        "https://github.com/opencanopi/canopi/releases/tag/v9.0.0"
    );
    assert_eq!(second.unwrap().unwrap(), offered);
    assert_eq!(
        offer.server.hits(),
        ["/stable.json"],
        "the second check made no request"
    );
}

#[test]
fn a_release_no_newer_than_the_running_one_and_an_unbundled_build_offer_nothing() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let running = app.package_info().version.to_string();
    let same = channel_file(
        &running,
        &APPIMAGE.key(),
        &offer.server.url("/payload"),
        "x",
    );
    offer.server.route("/stable.json", Route::Body(same));
    assert_eq!(
        run(offer.host(APPIMAGE, FAST).check(app.handle(), &executor)),
        Ok(None)
    );

    let unbundled = UpdaterHost::new(None, None, FAST);
    assert_eq!(run(unbundled.check(app.handle(), &executor)), Ok(None));
    assert_eq!(offer.server.hits(), ["/stable.json"]);
}

#[test]
fn a_check_settles_offline_status_malformed_and_no_channel_entry_as_their_codes() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let check = |host: UpdaterHost| code(run(host.check(app.handle(), &executor)));

    assert_eq!(
        check(UpdaterHost::for_test(APPIMAGE, FAST, &closed_port_url())),
        network(NetworkFailureKind::Offline)
    );
    for status in [404, 500, 503] {
        offer.server.route("/stable.json", Route::Status(status));
        assert_eq!(
            check(offer.host(APPIMAGE, FAST)),
            network(NetworkFailureKind::Status)
        );
    }
    offer
        .server
        .route("/stable.json", Route::Body(b"{ not json".to_vec()));
    assert_eq!(
        check(offer.host(APPIMAGE, FAST)),
        UpdateFailureCode::Invalid
    );

    let other = channel_file("9.0.0", &DEB.key(), &offer.server.url("/payload"), "x");
    offer.server.route("/stable.json", Route::Body(other));
    assert_eq!(
        check(offer.host(APPIMAGE, FAST)),
        UpdateFailureCode::UpdateNoChannelEntry {
            os: UpdateOs::Linux,
            arch: UpdateArch::X86_64,
            bundle: UpdateBundle::Appimage,
        }
    );
}

#[test]
fn a_slow_channel_file_times_out() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let body = channel_file("9.0.0", &APPIMAGE.key(), &offer.server.url("/payload"), "x");
    offer
        .server
        .route("/stable.json", Route::Slow(Duration::from_secs(3), body));
    let limits = Limits {
        check_timeout: Duration::from_millis(500),
        ..FAST
    };
    assert_eq!(
        code(run(offer
            .host(APPIMAGE, limits)
            .check(app.handle(), &executor))),
        network(NetworkFailureKind::Timeout)
    );
}

#[test]
fn a_download_verifies_the_payload_and_a_second_download_joins_it_and_hears_its_progress() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let host = offer.host(APPIMAGE, FAST);
    let executor = NativeOperationExecutor::production();
    let apps = scratch("download");
    let host = UpdaterHost {
        appimage: Some(apps.join("Canopi.AppImage")),
        ..host
    };
    run(host.check(app.handle(), &executor)).unwrap().unwrap();
    let (first_sink, first_heard) = sink();
    let (second_sink, second_heard) = sink();

    let (first, second) = run(async {
        tokio::join!(host.download(app.handle(), &executor, first_sink), async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            host.download(app.handle(), &executor, second_sink).await
        })
    });

    assert_eq!(first, Ok(UpdateDownload::Verified));
    assert_eq!(second, Ok(UpdateDownload::Verified));
    let payload_hits = offer
        .server
        .hits()
        .iter()
        .filter(|hit| *hit == "/payload")
        .count();
    assert_eq!(payload_hits, 1, "the second download joined the first");
    let last = *first_heard.lock().unwrap().last().unwrap();
    assert_eq!(u64::from(last.received), offer.payload.len() as u64);
    assert_eq!(last.total, u32::try_from(offer.payload.len()).ok());
    assert!(
        second_heard.lock().unwrap().len() <= first_heard.lock().unwrap().len(),
        "the joiner hears the running download's progress"
    );
    assert!(host.ops().staged.is_some());
}

#[test]
fn a_tampered_payload_and_one_signed_for_an_older_version_are_refused_and_nothing_is_staged() {
    let payload = elf_payload(4096);
    let mut tampered = payload.clone();
    tampered[100] ^= 1;
    for offer in [
        Offer::new(APPIMAGE, tampered, &payload, "9.0.0"),
        Offer::new(APPIMAGE, payload.clone(), &payload, "2.0.3"),
    ] {
        let app = mock_app(&offer.key.public_key());
        let executor = NativeOperationExecutor::production();
        let host = UpdaterHost {
            appimage: Some(scratch("tampered").join("Canopi.AppImage")),
            ..offer.host(APPIMAGE, FAST)
        };
        run(host.check(app.handle(), &executor)).unwrap().unwrap();
        let (progress, _) = sink();
        assert_eq!(
            code(run(host.download(app.handle(), &executor, progress))),
            UpdateFailureCode::UpdateSignatureRefused
        );
        assert!(host.ops().staged.is_none());
    }
}

#[test]
fn a_payload_over_its_cap_and_one_that_stalls_end_the_download() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let folder = scratch("caps");
    let download = |limits: Limits| {
        let host = UpdaterHost {
            appimage: Some(folder.join("Canopi.AppImage")),
            ..offer.host(APPIMAGE, limits)
        };
        run(host.check(app.handle(), &executor)).unwrap().unwrap();
        let (progress, _) = sink();
        let settled = run(host.download(app.handle(), &executor, progress));
        assert!(host.ops().staged.is_none());
        code(settled)
    };

    let small = Limits {
        size_cap: 1024,
        ..FAST
    };
    assert_eq!(download(small), network(NetworkFailureKind::TooLarge));
    offer.server.route(
        "/payload",
        Route::Stall {
            total: 8192,
            sent: 1024,
        },
    );
    assert_eq!(download(FAST), network(NetworkFailureKind::Timeout));
    offer.server.route("/payload", Route::Status(404));
    assert_eq!(download(FAST), network(NetworkFailureKind::Status));
}

#[test]
fn a_cancelled_download_stages_nothing_and_a_geocoder_lookup_runs_while_a_download_does() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let limits = Limits {
        stall_timeout: Duration::from_secs(20),
        ..FAST
    };
    let host = UpdaterHost {
        appimage: Some(scratch("cancel").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, limits)
    };
    run(host.check(app.handle(), &executor)).unwrap().unwrap();
    offer.server.route(
        "/payload",
        Route::Stall {
            total: 8192,
            sent: 1024,
        },
    );
    let (progress, heard) = sink();

    let (cancelled, geocoded) = run(async {
        tokio::join!(host.download(app.handle(), &executor, progress), async {
            while heard.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let geocoded = executor
                .run(NativeOperationClass::Network, "geocoding search", || {
                    Ok("found")
                })
                .await;
            host.cancel();
            geocoded
        })
    });

    assert_eq!(geocoded, Ok("found"));
    assert_eq!(code(cancelled), UpdateFailureCode::Cancelled);
    assert!(host.ops().staged.is_none());
    assert_eq!(
        code(run(host.install(app.handle(), &executor))),
        UpdateFailureCode::Invalid,
        "a cancelled download leaves nothing to install"
    );
}

#[test]
fn a_payload_on_a_host_outside_the_endpoint_table_is_refused_before_it_is_requested() {
    let key = TestKey::generate();
    let server = Server::start();
    let payload = elf_payload(1024);
    let elsewhere = server.url("/payload").replace("127.0.0.1", "localhost");
    server.route(
        "/stable.json",
        Route::Body(channel_file(
            "9.0.0",
            &APPIMAGE.key(),
            &elsewhere,
            &key.sign(&payload, "9.0.0"),
        )),
    );
    let app = mock_app(&key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("hosts").join("Canopi.AppImage")),
        ..UpdaterHost::for_test(APPIMAGE, FAST, &server.url("/stable.json"))
    };
    run(host.check(app.handle(), &executor)).unwrap().unwrap();
    let (progress, _) = sink();
    assert_eq!(
        code(run(host.download(app.handle(), &executor, progress))),
        network(NetworkFailureKind::HostNotAllowed)
    );
    assert_eq!(server.hits(), ["/stable.json"]);
}

#[test]
#[ignore = "expected to fail until the updater client gets a redirect policy in http.rs (http-client-only-in-http needs a user Q row); owner F6, canopi-f47t.52.228.15"]
fn a_redirect_off_the_allowed_hosts_is_refused() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("redirect").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };
    run(host.check(app.handle(), &executor)).unwrap().unwrap();
    let off_host = offer.server.url("/moved").replace("127.0.0.1", "localhost");
    offer
        .server
        .route("/moved", Route::Body(offer.payload.clone()));
    offer.server.route("/payload", Route::Redirect(off_host));
    let (progress, _) = sink();
    assert_eq!(
        code(run(host.download(app.handle(), &executor, progress))),
        network(NetworkFailureKind::HostNotAllowed)
    );
}

#[test]
fn a_deb_without_pkexec_and_an_unwritable_appimage_folder_answer_link_only_without_a_download() {
    for (installation, appimage) in [
        (DEB, None),
        (APPIMAGE, Some("/proc/Canopi.AppImage".into())),
    ] {
        let offer = Offer::signed(installation);
        let app = mock_app(&offer.key.public_key());
        let executor = NativeOperationExecutor::production();
        let host = UpdaterHost {
            appimage,
            ..offer.host(installation, FAST)
        };
        run(host.check(app.handle(), &executor)).unwrap().unwrap();
        let (progress, _) = sink();
        assert_eq!(
            run(host.download(app.handle(), &executor, progress)),
            Ok(UpdateDownload::LinkOnly {
                url: "https://projectcanopi.com".to_owned()
            })
        );
        assert_eq!(offer.server.hits(), ["/stable.json"]);
    }
}
