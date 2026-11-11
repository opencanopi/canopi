//! The exit flush: writes settle before exit, other work does not hold it.
use super::*;

#[test]
fn the_exit_flush_waits_for_a_running_write_to_settle_then_admits_no_write() {
    let executor = test_executor(2, 1);
    let (release, settled, _finished) = held_write(&executor, NativeOperationClass::Local);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        release.send(()).ok();
    });

    let drained = executor.drain_writes_before_exit(WAIT_TIMEOUT);

    let refused = tauri::async_runtime::block_on(executor.run(
        NativeOperationClass::UserData,
        "late write",
        || Ok(()),
    ));
    assert_eq!(
        (
            drained,
            settled.recv_timeout(WAIT_TIMEOUT).unwrap(),
            refused
        ),
        (
            true,
            Ok(()),
            Err("Native user-data operations are busy; try again".to_owned())
        )
    );
}

#[test]
fn the_exit_flush_gives_up_at_its_deadline_when_a_write_does_not_settle() {
    let executor = test_executor(2, 1);
    let (release, _settled, _finished) = held_write(&executor, NativeOperationClass::UserData);
    let started = Instant::now();

    let drained = executor.drain_writes_before_exit(Duration::from_millis(30));

    let waited = started.elapsed();
    release.send(()).unwrap();
    assert!(!drained);
    assert!(waited >= Duration::from_millis(30) && waited < WAIT_TIMEOUT);
}

/// canopi-f47t.52.228.15: the Windows update starts its installer, which ends Canopi, from
/// inside its own Local operation; its drain waits for every other write and not for itself.
#[test]
fn an_exit_from_inside_a_write_waits_for_the_other_writes_and_not_for_itself() {
    let executor = test_executor(2, 1);
    let (release, _settled, finished) = held_write(&executor, NativeOperationClass::UserData);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        release.send(()).ok();
    });
    let inner = executor.clone();

    let seen = tauri::async_runtime::block_on(executor.run(
        NativeOperationClass::Local,
        "update exit",
        move || {
            let drain = inner.hold_writes_for_exit(WAIT_TIMEOUT, Some(NativeOperationClass::Local));
            Ok((drain.settled(), finished.try_recv().is_ok()))
        },
    ));

    assert_eq!(seen, Ok((true, true)));
}

/// canopi-f47t.52.228.15: an installer that cannot start leaves Canopi open, saving again.
#[test]
fn a_dropped_exit_drain_admits_writes_again() {
    let executor = test_executor(2, 1);
    let drain = executor.hold_writes_for_exit(WAIT_TIMEOUT, None);
    let refused = tauri::async_runtime::block_on(executor.run(
        NativeOperationClass::UserData,
        "write while held",
        || Ok(()),
    ));

    drop(drain);

    let admitted = tauri::async_runtime::block_on(executor.run(
        NativeOperationClass::UserData,
        "write after",
        || Ok(()),
    ));
    assert_eq!((refused.is_err(), admitted), (true, Ok(())));
}

#[test]
fn the_exit_flush_does_not_wait_for_network_or_raster_work() {
    let executor = test_executor(2, 1);
    let (release, _settled, _finished) = held_write(&executor, NativeOperationClass::Network);

    let drained = executor.drain_writes_before_exit(Duration::from_millis(30));

    release.send(()).unwrap();
    assert!(drained);
}
