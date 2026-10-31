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
            host.check(app.handle(), &executor, "check"),
            host.check(app.handle(), &executor, "check")
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
        run(offer
            .host(APPIMAGE, FAST)
            .check(app.handle(), &executor, "check")),
        Ok(None)
    );

    let unbundled = UpdaterHost::new(None, None, FAST);
    assert_eq!(
        run(unbundled.check(app.handle(), &executor, "check")),
        Ok(None)
    );
    assert_eq!(offer.server.hits(), ["/stable.json"]);
}

#[test]
fn a_check_settles_offline_status_malformed_and_no_channel_entry_as_their_codes() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let check = |host: UpdaterHost| code(run(host.check(app.handle(), &executor, "check")));

    // Windows retries a SYN answered by RST for about 2 s before it reports the port refused. Two
    // timers would fire first and settle Timeout: FAST's 2 s connect timeout, and FAST's 1 s stall
    // timeout, which reqwest applies as read_timeout from the moment the request is sent, so it
    // covers the connect until headers arrive. This check gets both longer than that refusal
    // (canopi-f47t.52.228.15). The assertion stays Offline: Timeout here would be a
    // misclassification.
    let refusal = Limits {
        connect_timeout: Duration::from_secs(10),
        stall_timeout: Duration::from_secs(10),
        check_timeout: Duration::from_secs(15),
        ..FAST
    };
    assert_eq!(
        check(UpdaterHost::for_test(APPIMAGE, refusal, &closed_port_url())),
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
        code(run(offer.host(APPIMAGE, limits).check(
            app.handle(),
            &executor,
            "check"
        ))),
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
    // The payload is held back so the first download is still running when the second asks: a
    // small payload from a local server can otherwise settle first, and the second runs its own.
    offer.server.route(
        "/payload",
        Route::Slow(Duration::from_millis(500), offer.payload.clone()),
    );
    run(host.check(app.handle(), &executor, "check"))
        .unwrap()
        .unwrap();
    let (first_sink, first_heard) = sink();
    let (second_sink, second_heard) = sink();

    let (first, second) = run(async {
        tokio::join!(
            host.download(app.handle(), &executor, "download", first_sink),
            host.download(app.handle(), &executor, "download", second_sink)
        )
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
        run(host.check(app.handle(), &executor, "check"))
            .unwrap()
            .unwrap();
        let (progress, _) = sink();
        assert_eq!(
            code(run(host.download(
                app.handle(),
                &executor,
                "download",
                progress
            ))),
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
        run(host.check(app.handle(), &executor, "check"))
            .unwrap()
            .unwrap();
        let (progress, _) = sink();
        let settled = run(host.download(app.handle(), &executor, "download", progress));
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
    run(host.check(app.handle(), &executor, "check"))
        .unwrap()
        .unwrap();
    offer.server.route(
        "/payload",
        Route::Stall {
            total: 8192,
            sent: 1024,
        },
    );
    let (progress, heard) = sink();

    let (cancelled, geocoded) = run(async {
        tokio::join!(
            host.download(app.handle(), &executor, "download", progress),
            async {
                while heard.lock().unwrap().is_empty() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let geocoded = executor
                    .run(NativeOperationClass::Network, "geocoding search", || {
                        Ok("found")
                    })
                    .await;
                host.cancel("download");
                geocoded
            }
        )
    });

    assert_eq!(geocoded, Ok("found"));
    assert_eq!(code(cancelled), UpdateFailureCode::Cancelled);
    assert!(host.ops().staged.is_none());
    assert_eq!(
        code(run(host.install(app.handle(), &executor, None))),
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
    run(host.check(app.handle(), &executor, "check"))
        .unwrap()
        .unwrap();
    let (progress, _) = sink();
    assert_eq!(
        code(run(host.download(
            app.handle(),
            &executor,
            "download",
            progress
        ))),
        network(NetworkFailureKind::HostNotAllowed)
    );
    assert_eq!(server.hits(), ["/stable.json"]);
}

#[test]
fn a_redirect_off_the_allowed_hosts_is_refused() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("redirect").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };
    run(host.check(app.handle(), &executor, "check"))
        .unwrap()
        .unwrap();
    let off_host = offer.server.url("/moved").replace("127.0.0.1", "localhost");
    offer
        .server
        .route("/moved", Route::Body(offer.payload.clone()));
    offer.server.route("/payload", Route::Redirect(off_host));
    let (progress, _) = sink();
    assert_eq!(
        code(run(host.download(
            app.handle(),
            &executor,
            "download",
            progress
        ))),
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
        run(host.check(app.handle(), &executor, "check"))
            .unwrap()
            .unwrap();
        let (progress, _) = sink();
        assert_eq!(
            run(host.download(app.handle(), &executor, "download", progress)),
            Ok(UpdateDownload::LinkOnly {
                url: "https://projectcanopi.com".to_owned()
            })
        );
        assert_eq!(offer.server.hits(), ["/stable.json"]);
    }
}

/// `update_cancel` is a synchronous command and the ops are spawned, so a cancel the webview sends
/// right after starting an op can reach the host before the op does: it still cancels that op, and
/// only that one.
#[test]
fn a_cancel_that_arrives_before_its_operation_cancels_it_and_no_later_one() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("early-cancel").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };

    host.cancel("check-1");
    assert_eq!(
        code(run(host.check(app.handle(), &executor, "check-1"))),
        UpdateFailureCode::Cancelled
    );
    run(host.check(app.handle(), &executor, "check-2"))
        .unwrap()
        .unwrap();

    host.cancel("download-1");
    let (progress, heard) = sink();
    assert_eq!(
        code(run(host.download(
            app.handle(),
            &executor,
            "download-1",
            progress
        ))),
        UpdateFailureCode::Cancelled
    );
    assert!(
        heard.lock().unwrap().is_empty(),
        "the transfer never starts"
    );
    assert!(host.ops().staged.is_none());

    let (progress, _) = sink();
    assert_eq!(
        run(host.download(app.handle(), &executor, "download-2", progress)),
        Ok(UpdateDownload::Verified),
        "an earlier operation's cancel leaves a later one alone"
    );
}

/// The other order of the same race: the webview cancels op A just as it settles, and the cancel
/// reaches the host only after A settled and after op B was accepted. It names A, so B runs on.
#[test]
fn a_cancel_that_arrives_after_its_operation_settled_leaves_the_running_one_alone() {
    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let executor = NativeOperationExecutor::production();
    let host = UpdaterHost {
        appimage: Some(scratch("late-cancel").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };
    run(host.check(app.handle(), &executor, "check"))
        .unwrap()
        .unwrap();
    let (progress, _) = sink();
    assert_eq!(
        run(host.download(app.handle(), &executor, "download-a", progress)),
        Ok(UpdateDownload::Verified)
    );
    offer.server.route(
        "/payload",
        Route::Slow(Duration::from_millis(300), offer.payload.clone()),
    );

    let (progress, _) = sink();
    let (running, ()) = run(async {
        tokio::join!(
            host.download(app.handle(), &executor, "download-b", progress),
            async {
                while host.ops().download.is_none() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                host.cancel("download-a");
            }
        )
    });

    assert_eq!(
        running,
        Ok(UpdateDownload::Verified),
        "a settled operation's late cancel leaves the running one alone"
    );
}

/// canopi-f47t.52.228.15: a cancelled run settles only after its queued closure gets a Network
/// slot, so the user can press Check or Download again in between: the new op starts its own run
/// and is not dragged into the cancelled one.
#[test]
fn an_op_started_after_a_cancel_but_before_its_run_settled_runs_on_its_own() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use crate::native_operation::{NativeOperationClassLimits, NativeOperationLimits};

    let offer = Offer::signed(APPIMAGE);
    let app = mock_app(&offer.key.public_key());
    let lane = NativeOperationClassLimits::new(8, 1);
    let executor =
        NativeOperationExecutor::new(NativeOperationLimits::new(lane, lane, lane, lane, lane))
            .unwrap();
    let host = UpdaterHost {
        appimage: Some(scratch("cancel-then-restart").join("Canopi.AppImage")),
        ..offer.host(APPIMAGE, FAST)
    };
    let (host, app, executor) = (&host, &app, &executor);
    // Holds the one Network slot so run A's closure queues until `release` is set.
    let hold = |release: Arc<AtomicBool>| {
        executor.run(NativeOperationClass::Network, "held", move || {
            while !release.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(())
        })
    };
    let restart = |a: &'static str, b: &'static str| {
        let release = Arc::new(AtomicBool::new(false));
        let (held, a, b) = run(async {
            let a_is_a_check = a.starts_with("check");
            let op = |id| async move {
                if a_is_a_check {
                    host.check(app.handle(), executor, id).await.map(|_| ())
                } else {
                    let (progress, _) = sink();
                    host.download(app.handle(), executor, id, progress)
                        .await
                        .map(|_| ())
                }
            };
            tokio::join!(hold(Arc::clone(&release)), op(a), async {
                while host.cancels().running.is_empty() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                host.cancel(a);
                tokio::join!(op(b), async {
                    while host.cancels().running.len() < 2 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    release.store(true, Ordering::SeqCst);
                })
                .0
            })
        });
        assert_eq!(held, Ok(()));
        (a, b)
    };

    let (a, b) = restart("check-a", "check-b");
    assert_eq!(code(a), UpdateFailureCode::Cancelled);
    assert_eq!(
        b,
        Ok(()),
        "the check started after the cancel runs on its own"
    );
    let (a, b) = restart("download-a", "download-b");
    assert_eq!(code(a), UpdateFailureCode::Cancelled);
    assert_eq!(
        b,
        Ok(()),
        "the download started after the cancel runs on its own"
    );
    assert!(host.ops().staged.is_some());
}
