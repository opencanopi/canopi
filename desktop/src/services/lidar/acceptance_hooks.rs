//! Thread-local, one-shot fault boundaries for acceptance tests only.
use super::LidarLibrary;
use std::cell::RefCell;
use std::path::Path;

type SampleHook = Box<dyn FnOnce(&LidarLibrary)>;
type BlockHook = Box<dyn FnOnce(&Path, bool)>;
thread_local! {
    static TARGET: RefCell<Option<SampleHook>> = RefCell::new(None);
    static READ: RefCell<Option<SampleHook>> = RefCell::new(None);
    static BLOCK: RefCell<Option<BlockHook>> = RefCell::new(None);
}
pub(super) fn on_target(hook: SampleHook) -> Guard {
    TARGET.with(|slot| *slot.borrow_mut() = Some(hook));
    Guard
}
pub(super) fn on_read(hook: SampleHook) -> Guard {
    READ.with(|slot| *slot.borrow_mut() = Some(hook));
    Guard
}
pub(super) fn on_block(hook: BlockHook) -> Guard {
    BLOCK.with(|slot| *slot.borrow_mut() = Some(hook));
    Guard
}
pub(super) fn after_target(library: &LidarLibrary) {
    let hook = TARGET.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook(library);
    }
}
pub(super) fn after_read(library: &LidarLibrary) {
    let hook = READ.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook(library);
    }
}
pub(super) fn after_block(scratch: &Path, has_output: bool) {
    let hook = BLOCK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook(scratch, has_output);
    }
}
pub(super) struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        TARGET.with(|slot| slot.borrow_mut().take());
        READ.with(|slot| slot.borrow_mut().take());
        BLOCK.with(|slot| slot.borrow_mut().take());
        super::paths::capacity_probe::set(None);
    }
}

/// A hook run as each batch of sampling work starts on the executor, for one
/// library only (tests run in parallel, and executor work is not on the
/// test's thread).
type WorkHook = std::sync::Arc<dyn Fn() + Send + Sync>;
static SAMPLE_WORK: std::sync::Mutex<Vec<(std::path::PathBuf, WorkHook)>> =
    std::sync::Mutex::new(Vec::new());
pub(super) fn on_sample_work(library: &LidarLibrary, hook: WorkHook) -> SampleWorkGuard {
    let root = library.inner.paths.root().to_path_buf();
    SAMPLE_WORK.lock().unwrap().push((root.clone(), hook));
    SampleWorkGuard(root)
}
pub(super) fn sample_work_started(library: &LidarLibrary) {
    let root = library.inner.paths.root();
    let hook = SAMPLE_WORK
        .lock()
        .unwrap()
        .iter()
        .find(|(owner, _)| owner == root)
        .map(|(_, hook)| hook.clone());
    if let Some(hook) = hook {
        hook();
    }
}
pub(super) struct SampleWorkGuard(std::path::PathBuf);
impl Drop for SampleWorkGuard {
    fn drop(&mut self) {
        if let Ok(mut hooks) = SAMPLE_WORK.lock() {
            hooks.retain(|(owner, _)| owner != &self.0);
        }
    }
}

/// A one-shot hook run once an import job has copied a source into one
/// library, before it reads it, on whichever thread runs the job.
type StagedHook = Box<dyn FnOnce(&LidarLibrary) + Send>;
static SOURCE_STAGED: std::sync::Mutex<Vec<(std::path::PathBuf, StagedHook)>> =
    std::sync::Mutex::new(Vec::new());
pub(super) fn on_source_staged(library: &LidarLibrary, hook: StagedHook) {
    let root = library.inner.paths.root().to_path_buf();
    SOURCE_STAGED.lock().unwrap().push((root, hook));
}
pub(super) fn after_source_staged(library: &LidarLibrary) {
    let root = library.inner.paths.root();
    let hook = {
        let mut hooks = SOURCE_STAGED.lock().unwrap();
        let at = hooks.iter().position(|(owner, _)| owner == root);
        at.map(|at| hooks.swap_remove(at).1)
    };
    if let Some(hook) = hook {
        hook(library);
    }
}
