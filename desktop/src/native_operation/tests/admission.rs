//! Admission order and capacity: queued and started work release their permits, classes do not starve each other.
use super::*;

#[test]
fn starts_admitted_work_in_fifo_order() {
    tauri::async_runtime::block_on(async {
        let executor = test_executor(3, 1);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let first_executor = executor.clone();
        let first = tauri::async_runtime::spawn(async move {
            first_executor
                .run(NativeOperationClass::Catalog, "fifo blocker", move || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
        });
        started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

        let (order_tx, order_rx) = mpsc::channel();
        let second_executor = executor.clone();
        let second_order = order_tx.clone();
        let second = tauri::async_runtime::spawn(async move {
            second_executor
                .run(NativeOperationClass::Catalog, "fifo second", move || {
                    second_order.send(2).unwrap();
                    Ok(())
                })
                .await
        });
        wait_until(|| executor.available_admission_for_test(NativeOperationClass::Catalog) == 1);

        let third_executor = executor.clone();
        let third = tauri::async_runtime::spawn(async move {
            third_executor
                .run(NativeOperationClass::Catalog, "fifo third", move || {
                    order_tx.send(3).unwrap();
                    Ok(())
                })
                .await
        });
        wait_until(|| executor.available_admission_for_test(NativeOperationClass::Catalog) == 0);

        release_tx.send(()).unwrap();
        assert_eq!(order_rx.recv_timeout(WAIT_TIMEOUT).unwrap(), 2);
        assert_eq!(order_rx.recv_timeout(WAIT_TIMEOUT).unwrap(), 3);
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        third.await.unwrap().unwrap();
    });
}

#[test]
fn dropping_queued_work_releases_admission_without_spawning() {
    tauri::async_runtime::block_on(async {
        let executor = test_executor(2, 1);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let first_executor = executor.clone();
        let first = tauri::async_runtime::spawn(async move {
            first_executor
                .run(NativeOperationClass::Local, "queue blocker", move || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
        });
        started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

        let queued_work_ran = Arc::new(AtomicBool::new(false));
        let queued_work_probe = Arc::clone(&queued_work_ran);
        let queued_executor = executor.clone();
        let queued = tauri::async_runtime::spawn(async move {
            queued_executor
                .run(
                    NativeOperationClass::Local,
                    "cancelled queued operation",
                    move || {
                        queued_work_probe.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
        });
        wait_until(|| executor.available_admission_for_test(NativeOperationClass::Local) == 0);

        queued.abort();
        assert!(queued.await.is_err());
        wait_until(|| executor.available_admission_for_test(NativeOperationClass::Local) == 1);
        assert!(!queued_work_ran.load(Ordering::SeqCst));

        release_tx.send(()).unwrap();
        first.await.unwrap().unwrap();
        executor
            .run(
                NativeOperationClass::Local,
                "post-cancellation operation",
                || Ok(()),
            )
            .await
            .unwrap();
    });
}

#[test]
fn dropping_started_caller_keeps_capacity_until_blocking_work_finishes() {
    tauri::async_runtime::block_on(async {
        let executor = test_executor(1, 1);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (finished_tx, finished_rx) = mpsc::sync_channel(1);
        let started_executor = executor.clone();
        let started = tauri::async_runtime::spawn(async move {
            started_executor
                .run(
                    NativeOperationClass::Network,
                    "detached started operation",
                    move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        finished_tx.send(()).unwrap();
                        Ok(())
                    },
                )
                .await
        });
        started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();

        started.abort();
        assert!(started.await.is_err());
        let rejected_work_ran = Arc::new(AtomicBool::new(false));
        let rejected_work_probe = Arc::clone(&rejected_work_ran);
        let error = executor
            .run(
                NativeOperationClass::Network,
                "while detached work runs",
                move || {
                    rejected_work_probe.store(true, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error, "Native network operations are busy; try again");
        assert!(!rejected_work_ran.load(Ordering::SeqCst));

        release_tx.send(()).unwrap();
        finished_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
        wait_until(|| executor.available_admission_for_test(NativeOperationClass::Network) == 1);
        executor
            .run(
                NativeOperationClass::Network,
                "after detached completion",
                || Ok(()),
            )
            .await
            .unwrap();
    });
}

#[test]
fn panic_and_work_error_release_capacity() {
    tauri::async_runtime::block_on(async {
        let executor = test_executor(1, 1);

        let panic_error = executor
            .run::<(), _>(NativeOperationClass::Local, "panicking operation", || {
                panic!("controlled executor panic")
            })
            .await
            .unwrap_err();
        assert_eq!(
            panic_error,
            "panicking operation native operation task failed"
        );

        let work_error = executor
            .run::<(), _>(NativeOperationClass::Local, "fallible operation", || {
                Err("domain failure".to_owned())
            })
            .await
            .unwrap_err();
        assert_eq!(work_error, "domain failure");

        executor
            .run(NativeOperationClass::Local, "after failures", || Ok(()))
            .await
            .unwrap();
    });
}

#[test]
fn a_local_operation_starts_while_raster_is_saturated() {
    tauri::async_runtime::block_on(async {
        let executor = NativeOperationExecutor::production();
        let raster = NativeOperationLimits::production().for_class(NativeOperationClass::Raster);
        let (started_tx, started_rx) = mpsc::channel();
        let mut releases = Vec::new();
        let mut raster_jobs = Vec::new();
        let mut start_raster_job = |label: &'static str| {
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            releases.push(release_tx);
            let started_tx = started_tx.clone();
            let job_executor = executor.clone();
            raster_jobs.push(tauri::async_runtime::spawn(async move {
                job_executor
                    .run(NativeOperationClass::Raster, label, move || {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    })
                    .await
            }));
        };

        for _ in 0..raster.running {
            start_raster_job("running raster operation");
        }
        for _ in 0..raster.running {
            started_rx.recv_timeout(WAIT_TIMEOUT).unwrap();
        }
        for _ in raster.running..raster.admitted {
            start_raster_job("queued raster operation");
        }
        wait_until(|| executor.available_admission_for_test(NativeOperationClass::Raster) == 0);

        let refused = executor
            .run(
                NativeOperationClass::Raster,
                "one raster operation too many",
                || Ok(()),
            )
            .await
            .unwrap_err();
        assert_eq!(refused, "Native raster operations are busy; try again");

        let (local_tx, local_rx) = mpsc::sync_channel(1);
        let local_executor = executor.clone();
        let local = tauri::async_runtime::spawn(async move {
            let result = local_executor
                .run(
                    NativeOperationClass::Local,
                    "save during raster work",
                    || Ok("saved"),
                )
                .await;
            local_tx.send(result).unwrap();
        });
        assert_eq!(
            local_rx.recv_timeout(WAIT_TIMEOUT).unwrap(),
            Ok("saved"),
            "a Local operation must not wait behind saturated Raster work",
        );
        local.await.unwrap();

        for release in releases {
            release.send(()).unwrap();
        }
        for job in raster_jobs {
            job.await.unwrap().unwrap();
        }
    });
}
