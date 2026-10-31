//! Sampled process-tree resident memory for the representative raster runs.
//!
//! The combined-memory gate needs the working set that is actually live while a
//! raster operation runs, including the GDAL children the comparison lane
//! launches. This module samples the root process and every descendant it can
//! observe on a fixed interval, tracking `(pid, start time)` identity so a
//! recycled pid is never counted twice and a child that exits between
//! discovery and read is reported as an unreadable sample rather than as zero.
//!
//! Reported limitations, which every gate must state:
//!
//! - Sampling can miss peaks shorter than the interval; the value is a lower
//!   bound on the true peak, never an upper bound.
//! - Summing resident sets double-counts pages shared between the root and its
//!   children (copy-on-write, shared libraries, page cache), so the total is
//!   conservative.
//! - A tick with an unreadable member is counted as incomplete; incomplete
//!   ticks are not evidence of a pass.
//!
//! Only Linux `/proc` is implemented. Other platforms report
//! [`TreeMeasurement::Unsupported`], which callers must treat as unavailable
//! rather than as a passing measurement.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// Sampling interval: at most the 100 ms the contract allows.
pub(super) const SAMPLE_INTERVAL: Duration = Duration::from_millis(50);

/// What one process-tree measurement produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TreeMeasurement {
    /// Sampled totals in bytes.
    Sampled {
        /// Resident total observed before the workload started.
        baseline_bytes: u64,
        /// Whether every member of the baseline tree was readable. An incomplete
        /// baseline is not evidence, so no incremental figure can be derived.
        baseline_complete: bool,
        /// Largest total over ticks whose tree was fully readable; zero when no
        /// complete workload tick exists.
        peak_total_bytes: u64,
        /// `peak_total_bytes` over the baseline, or `None` without a complete
        /// baseline or at least one complete workload tick.
        peak_incremental_bytes: Option<u64>,
        /// Largest total over *any* tick, complete or not: with a complete
        /// baseline this is a lower bound on the workload's peak.
        peak_subtotal_bytes: u64,
        /// Complete sampling ticks taken while the workload interval was active.
        complete_ticks: u64,
        /// Ticks where at least one observed member could not be read.
        incomplete_ticks: u64,
        /// Milliseconds between samples.
        interval_ms: u64,
        /// Largest resident set observed for any *single* member of the tree,
        /// over every readable tick, the root included.
        ///
        /// This is what separates one large process from concurrency: a peak whose
        /// largest member is near the whole peak is one conversion's working set,
        /// while a peak much larger than any member is several processes resident
        /// at once. It is a lower bound for the same reason the totals are.
        peak_member_bytes: u64,
        /// Largest number of readable members seen in any one tick, the root
        /// included. This is the observed concurrency, not a configured limit.
        peak_member_count: u64,
    },
    /// This platform cannot measure the process tree.
    Unsupported(String),
}

impl TreeMeasurement {
    /// The sampled incremental peak, or `None` when the evidence is incomplete.
    pub(super) fn peak_incremental_bytes(&self) -> Option<u64> {
        match self {
            Self::Sampled {
                peak_incremental_bytes,
                ..
            } => *peak_incremental_bytes,
            Self::Unsupported(_) => None,
        }
    }

    /// A one-line report for the run log.
    pub(super) fn report(&self) -> String {
        match self {
            Self::Sampled {
                baseline_bytes,
                baseline_complete,
                peak_total_bytes,
                peak_incremental_bytes,
                peak_subtotal_bytes,
                complete_ticks,
                incomplete_ticks,
                interval_ms,
                peak_member_bytes,
                peak_member_count,
            } => {
                let incremental = match peak_incremental_bytes {
                    Some(bytes) => format!("{} MiB", bytes / (1024 * 1024)),
                    None => "unavailable (no complete workload sample)".to_string(),
                };
                format!(
                    "process tree sample every {interval_ms} ms: baseline {} MiB{}, peak total \
                     {} MiB, incremental {incremental}, largest observed subtotal {} MiB over \
                     {complete_ticks} complete and {incomplete_ticks} incomplete ticks (RSS sums \
                     double-count shared pages and sampling can miss shorter peaks)",
                    baseline_bytes / (1024 * 1024),
                    if *baseline_complete {
                        ""
                    } else {
                        " (incomplete)"
                    },
                    peak_total_bytes / (1024 * 1024),
                    peak_subtotal_bytes / (1024 * 1024),
                ) + &format!(
                    "; composition: largest single member {} MiB over {} member(s) at most \
                     (raster work runs in process; members beyond the root are GeoLibre children)",
                    peak_member_bytes / (1024 * 1024),
                    peak_member_count,
                )
            }
            Self::Unsupported(reason) => format!("process tree measurement unavailable: {reason}"),
        }
    }

    /// The gate's verdict for one measurement.
    pub(super) fn budget_outcome(&self) -> BudgetOutcome {
        let Self::Sampled {
            baseline_bytes,
            baseline_complete,
            peak_incremental_bytes,
            peak_subtotal_bytes,
            complete_ticks,
            incomplete_ticks,
            ..
        } = self
        else {
            return BudgetOutcome::Unavailable("this platform cannot sample the tree".to_string());
        };
        if !baseline_complete {
            return BudgetOutcome::Unavailable(
                "the idle baseline was incomplete, so no incremental total is evidence".to_string(),
            );
        }
        let over_budget =
            (*peak_subtotal_bytes).saturating_sub(*baseline_bytes) > COMBINED_MEMORY_BUDGET_BYTES;
        if over_budget {
            // A known subtotal that already exceeds the budget fails the gate
            // even when other samples are missing: missing data cannot lower a
            // measured lower bound.
            return BudgetOutcome::OverBudget {
                observed_bytes: (*peak_subtotal_bytes).saturating_sub(*baseline_bytes),
                complete_ticks: *complete_ticks,
                incomplete_ticks: *incomplete_ticks,
            };
        }
        match peak_incremental_bytes {
            Some(bytes) => BudgetOutcome::Within {
                incremental_bytes: *bytes,
                complete_ticks: *complete_ticks,
                incomplete_ticks: *incomplete_ticks,
            },
            None => BudgetOutcome::Unavailable(format!(
                "no complete sample covered the workload interval ({complete_ticks} complete, \
                 {incomplete_ticks} incomplete)"
            )),
        }
    }
}

/// The combined-memory gate's verdict for one measurement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum BudgetOutcome {
    /// The sampled peak is inside the budget.
    Within {
        incremental_bytes: u64,
        complete_ticks: u64,
        incomplete_ticks: u64,
    },
    /// An observed subtotal already exceeds the budget.
    OverBudget {
        observed_bytes: u64,
        complete_ticks: u64,
        incomplete_ticks: u64,
    },
    /// The measurement cannot support a verdict; it is not a pass.
    Unavailable(String),
}

/// Combined incremental working-memory gate for a representative run: at most
/// 1 GiB over the recorded idle baseline, root plus descendants.
pub(super) const COMBINED_MEMORY_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;

/// Report one representative run's sampled total and enforce the combined
/// budget, returning the incremental bytes for the caller's own log.
///
/// An incomplete measurement is never a pass: a missing baseline or a workload
/// interval with no complete sample is reported as unavailable, and on Linux an
/// unavailable measurement fails loudly instead of quietly succeeding. A known
/// subtotal that already exceeds the budget fails even when other samples are
/// missing.
pub(super) fn gate_combined_budget(label: &str, measurement: &TreeMeasurement) -> Option<u64> {
    println!("{label}: {}", measurement.report());
    match measurement.budget_outcome() {
        BudgetOutcome::Within {
            incremental_bytes,
            complete_ticks,
            incomplete_ticks,
        } => {
            println!(
                "{label}: {complete_ticks} complete samples, {incomplete_ticks} incomplete; \
                 the sampled peak is a lower bound, not an exhaustive maximum"
            );
            Some(incremental_bytes)
        }
        BudgetOutcome::OverBudget { observed_bytes, .. } => panic!(
            "{label} must stay inside the {} MiB combined working-memory budget: an observed subtotal \
             already reached {} MiB over baseline",
            COMBINED_MEMORY_BUDGET_BYTES / (1024 * 1024),
            observed_bytes / (1024 * 1024)
        ),
        BudgetOutcome::Unavailable(reason) => {
            if cfg!(target_os = "linux") {
                panic!("{label}: the combined-memory gate has no usable evidence: {reason}");
            }
            println!("{label}: combined-memory gate unavailable on this platform: {reason}");
            None
        }
    }
}

/// One process observed on a tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProcessFact {
    pid: u32,
    parent: u32,
    /// Kernel start time in clock ticks: identity, never reused for a pid.
    start_time: u64,
    resident_bytes: Option<u64>,
}

/// Starting a measurement either yields a running sampler or an explicit
/// platform reason, so a caller can never mistake "cannot measure" for a pass.
pub(super) enum Sampler {
    Running(ProcessTreeSampler),
    Unavailable(String),
}

impl Sampler {
    /// Sample the idle baseline, then start sampling until [`Self::finish`].
    #[cfg(test)]
    pub(super) fn start() -> Self {
        if !cfg!(target_os = "linux") {
            return Self::Unavailable(
                "process tree sampling is implemented for Linux /proc only".to_string(),
            );
        }
        match ProcessTreeSampler::start() {
            Ok(sampler) => Self::Running(sampler),
            Err(reason) => Self::Unavailable(reason),
        }
    }

    /// Stop sampling and report the measurement.
    pub(super) fn finish(self) -> TreeMeasurement {
        match self {
            Self::Running(sampler) => sampler.finish(),
            Self::Unavailable(reason) => TreeMeasurement::Unsupported(reason),
        }
    }
}

/// A running sampler; dropping it stops the sampling loop.
pub(super) struct ProcessTreeSampler {
    stop: Arc<AtomicBool>,
    /// Largest total over fully readable ticks.
    peak: Arc<AtomicU64>,
    /// Largest total over any tick.
    subtotal: Arc<AtomicU64>,
    complete: Arc<AtomicU64>,
    incomplete: Arc<AtomicU64>,
    /// Largest single member over every readable tick.
    member_peak: Arc<AtomicU64>,
    /// Largest member count over any one tick.
    member_count_peak: Arc<AtomicU64>,
    baseline_bytes: u64,
    baseline_complete: bool,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl ProcessTreeSampler {
    /// Sample the idle baseline, then start sampling until [`Self::finish`].
    #[cfg(test)]
    fn start() -> Result<Self, String> {
        // Retry briefly so a transient unreadable member at idle does not
        // disqualify the baseline; a baseline that never completes is an error
        // rather than an unmeasured zero.
        let mut last = String::from("the idle baseline could not be sampled");
        let mut baseline = None;
        for _ in 0..BASELINE_ATTEMPTS {
            match snapshot_tree() {
                Some((bytes, true)) => {
                    baseline = Some((bytes, true));
                    break;
                }
                Some((bytes, false)) => {
                    last = "the idle baseline had an unreadable member".to_string();
                    baseline = Some((bytes, false));
                }
                None => last = "the idle baseline could not be sampled".to_string(),
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let Some((baseline_bytes, baseline_complete)) = baseline else {
            return Err(last);
        };
        let stop = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(AtomicU64::new(0));
        let subtotal = Arc::new(AtomicU64::new(baseline_bytes));
        let complete = Arc::new(AtomicU64::new(0));
        let incomplete = Arc::new(AtomicU64::new(0));
        let member_peak = Arc::new(AtomicU64::new(0));
        let member_count_peak = Arc::new(AtomicU64::new(0));
        let worker = spawn_sampling_loop(
            stop.clone(),
            peak.clone(),
            subtotal.clone(),
            complete.clone(),
            incomplete.clone(),
            member_peak.clone(),
            member_count_peak.clone(),
        );
        Ok(Self {
            stop,
            peak,
            subtotal,
            complete,
            incomplete,
            member_peak,
            member_count_peak,
            baseline_bytes,
            baseline_complete,
            handle: Some(worker),
        })
    }

    /// Complete ticks so far, so a test waits for evidence instead of a fixed sleep.
    /// Its one caller is the Linux-only live sampling test.
    #[cfg(test)]
    #[cfg(target_os = "linux")]
    fn complete_ticks(&self) -> u64 {
        self.complete.load(Ordering::Relaxed)
    }

    /// Stop sampling and report the measurement.
    pub(super) fn finish(mut self) -> TreeMeasurement {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let peak_total_bytes = self.peak.load(Ordering::Relaxed);
        let complete_ticks = self.complete.load(Ordering::Relaxed);
        // Incremental evidence needs a complete baseline and at least one
        // complete sample taken while the workload interval was active.
        let peak_incremental_bytes = (self.baseline_complete && complete_ticks > 0)
            .then(|| peak_total_bytes.saturating_sub(self.baseline_bytes));
        TreeMeasurement::Sampled {
            baseline_bytes: self.baseline_bytes,
            baseline_complete: self.baseline_complete,
            peak_total_bytes,
            peak_incremental_bytes,
            peak_subtotal_bytes: self.subtotal.load(Ordering::Relaxed),
            complete_ticks,
            incomplete_ticks: self.incomplete.load(Ordering::Relaxed),
            interval_ms: u64::try_from(SAMPLE_INTERVAL.as_millis()).unwrap_or(100),
            peak_member_bytes: self.member_peak.load(Ordering::Relaxed),
            peak_member_count: self.member_count_peak.load(Ordering::Relaxed),
        }
    }
}

/// The sampling loop, on one thread this test-only module owns.
///
/// It is a free function with an explicit `#[cfg(test)]` because the
/// repository's native-execution policy forbids unmanaged threads in shipped
/// code and skips exactly such items: no production command can reach this
/// sampler.
#[cfg(test)]
fn spawn_sampling_loop(
    stop: Arc<AtomicBool>,
    peak: Arc<AtomicU64>,
    subtotal: Arc<AtomicU64>,
    complete: Arc<AtomicU64>,
    incomplete: Arc<AtomicU64>,
    member_peak: Arc<AtomicU64>,
    member_count_peak: Arc<AtomicU64>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(SAMPLE_INTERVAL);
            // A tick after stop cannot supply workload evidence: the interval it
            // would cover is already over.
            if stop.load(Ordering::Relaxed) {
                break;
            }
            sample_once(
                &peak,
                &subtotal,
                &complete,
                &incomplete,
                &member_peak,
                &member_count_peak,
            );
        }
    })
}

/// Attempts to capture a complete idle baseline before giving up.
const BASELINE_ATTEMPTS: u32 = 5;

/// Sample the tree, folding complete ticks into `peak`.
///
/// A tick where any observed member could not be read is counted as incomplete
/// and never contributes to the peak: an unreadable sample is not a low
/// measurement to compare against a budget.
fn sample_once(
    peak: &AtomicU64,
    subtotal: &AtomicU64,
    complete: &AtomicU64,
    incomplete: &AtomicU64,
    member_peak: &AtomicU64,
    member_count_peak: &AtomicU64,
) -> Option<u64> {
    let processes = read_processes();
    let Some((total, complete_tree, largest_member, member_count)) =
        tree_total(&processes, std::process::id())
    else {
        incomplete.fetch_add(1, Ordering::Relaxed);
        return None;
    };
    // The decomposition is recorded for every readable tick, complete or not,
    // because it answers a different question than the budget verdict: what the
    // peak is made of, not whether the peak is admissible.
    member_peak.fetch_max(largest_member, Ordering::Relaxed);
    member_count_peak.fetch_max(member_count, Ordering::Relaxed);
    // Every tick's readable subtotal is a lower bound; only a fully readable
    // tick may become the sampled peak.
    subtotal.fetch_max(total, Ordering::Relaxed);
    if complete_tree {
        peak.fetch_max(total, Ordering::Relaxed);
        complete.fetch_add(1, Ordering::Relaxed);
    } else {
        incomplete.fetch_add(1, Ordering::Relaxed);
    }
    Some(total)
}

/// Resident total and completeness of one instantaneous snapshot.
///
/// `None` means the root itself could not be read, which is not a measurement.
fn snapshot_tree() -> Option<(u64, bool)> {
    let (total, complete, _largest_member, _member_count) =
        tree_total(&read_processes(), std::process::id())?;
    Some((total, complete))
}

/// Sum the root and every observed live descendant, each counted once, and
/// report whether every member of that tree was readable.
///
/// `None` means the root itself could not be read, which is not a measurement.
/// A tree member that exited between discovery and read makes `complete`
/// false: its resident size is unknown, so the sum undercounts and that tick
/// must not stand as evidence.
fn tree_total(processes: &BTreeMap<u32, ProcessFact>, root: u32) -> Option<(u64, bool, u64, u64)> {
    let root_fact = processes.get(&root)?;
    let mut total = root_fact.resident_bytes?;
    let mut largest_member = total;
    let mut member_count = 1u64;
    let mut complete = true;
    // Children may be discovered in any order and may themselves be parents of
    // processes launched from worker threads, so the tree is walked, not
    // assumed to be one level deep.
    let mut queue = vec![root];
    let mut seen: BTreeSet<u32> = BTreeSet::new();
    seen.insert(root);
    while let Some(pid) = queue.pop() {
        for (child, fact) in processes.iter() {
            if fact.parent != pid || seen.contains(child) {
                continue;
            }
            seen.insert(*child);
            match fact.resident_bytes {
                Some(bytes) => {
                    total = total.saturating_add(bytes);
                    largest_member = largest_member.max(bytes);
                    member_count = member_count.saturating_add(1);
                }
                None => complete = false,
            }
            queue.push(*child);
        }
    }
    Some((total, complete, largest_member, member_count))
}

/// Read one fact per live process, including identity and resident bytes.
fn read_processes() -> BTreeMap<u32, ProcessFact> {
    let mut processes = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return processes;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((parent, start_time)) = parse_stat(&stat) else {
            continue;
        };
        let resident_bytes = std::fs::read_to_string(format!("/proc/{pid}/status"))
            .ok()
            .and_then(|status| resident_bytes(&status));
        processes.insert(
            pid,
            ProcessFact {
                pid,
                parent,
                start_time,
                resident_bytes,
            },
        );
    }
    processes
}

/// `(parent pid, start time)` from `/proc/<pid>/stat`.
///
/// The command name is parenthesised and may itself contain spaces and
/// parentheses, so parsing starts after the last `)`.
fn parse_stat(stat: &str) -> Option<(u32, u64)> {
    let tail = &stat[stat.rfind(')')? + 1..];
    let mut fields = tail.split_whitespace();
    let state = fields.next()?;
    if state.is_empty() {
        return None;
    }
    let parent = fields.next()?.parse::<u32>().ok()?;
    // Fields after the parent: pgrp, session, tty, tpgid, flags, minflt,
    // cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority, nice,
    // threads, itrealvalue, starttime.
    let start_time = fields.nth(17)?.parse::<u64>().ok()?;
    Some((parent, start_time))
}

/// `VmRSS` in bytes from `/proc/<pid>/status`.
fn resident_bytes(status: &str) -> Option<u64> {
    status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u64>().ok())
        .map(|kilobytes| kilobytes * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(pid: u32, parent: u32, resident: Option<u64>) -> ProcessFact {
        ProcessFact {
            pid,
            parent,
            start_time: u64::from(pid),
            resident_bytes: resident,
        }
    }

    #[test]
    fn the_tree_total_sums_root_and_every_observed_descendant_once() {
        let processes: BTreeMap<u32, ProcessFact> = [
            (10, fact(10, 1, Some(10))),
            // Two children of the root and one grandchild launched from a
            // worker thread: every level contributes.
            (20, fact(20, 10, Some(20))),
            (30, fact(30, 10, Some(30))),
            (40, fact(40, 20, Some(20))),
            // An unrelated process and a duplicate row must not be counted.
            (50, fact(50, 1, Some(1000))),
        ]
        .into_iter()
        .collect();
        // Root 10 + children 20 and 30 + grandchild 20 = 80 over four members,
        // and the largest single member is the 30-byte child. The unrelated
        // 1000-byte process is not a descendant and contributes nothing.
        assert_eq!(tree_total(&processes, 10), Some((80, true, 30, 4)));
        // A cycle or repeated row cannot double-count a member.
        let mut twice = processes.clone();
        twice.insert(60, fact(60, 40, Some(5)));
        // The extra 5-byte child of the 20-byte grandchild is summed once, so
        // the total rises to 85 over five members while the largest member stays
        // the 30-byte child.
        assert_eq!(tree_total(&twice, 10), Some((85, true, 30, 5)));
    }

    /// The authored summation the gate depends on: root 10 plus two children of
    /// 20 and 30 is 60, not the largest member and not a per-level maximum.
    #[test]
    fn the_tree_total_adds_the_root_and_its_children() {
        let processes: BTreeMap<u32, ProcessFact> = [
            (1, fact(1, 0, Some(10))),
            (2, fact(2, 1, Some(20))),
            (3, fact(3, 1, Some(30))),
        ]
        .into_iter()
        .collect();
        assert_eq!(tree_total(&processes, 1), Some((60, true, 30, 3)));
    }

    /// A child's lifetime is per tick: once it exits it is no longer summed, and
    /// a recycled pid with a new start time is a different process.
    #[test]
    fn a_child_lifetime_ends_at_its_exit_and_pids_are_never_reused_silently() {
        let early: BTreeMap<u32, ProcessFact> =
            [(1, fact(1, 0, Some(10))), (2, fact(2, 1, Some(50)))]
                .into_iter()
                .collect();
        assert_eq!(tree_total(&early, 1), Some((60, true, 50, 2)));
        // The child exited: only the root remains, and nothing negative or
        // stale is carried over.
        let late: BTreeMap<u32, ProcessFact> = [(1, fact(1, 0, Some(12)))].into_iter().collect();
        assert_eq!(tree_total(&late, 1), Some((12, true, 12, 1)));
        // The same pid now belongs to an unrelated process with a new start
        // time, which is not a descendant and must not be summed.
        let recycled: BTreeMap<u32, ProcessFact> = [
            (1, fact(1, 0, Some(12))),
            (
                2,
                ProcessFact {
                    pid: 2,
                    parent: 1,
                    start_time: 9_999,
                    resident_bytes: Some(400),
                },
            ),
        ]
        .into_iter()
        .collect();
        // It is a live descendant of the root, so it is summed once: identity
        // matters for reporting, not for inventing or dropping members.
        assert_eq!(tree_total(&recycled, 1), Some((412, true, 400, 2)));
    }

    /// A real child process appears in the live tree while it runs.
    // Samples Linux /proc; other platforms report Unsupported (tested below).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_running_child_is_discovered_in_the_live_tree() {
        let Ok(mut child) = std::process::Command::new("sleep").arg("0.4").spawn() else {
            // A host without `sleep` cannot demonstrate this; the authored
            // lifetime test above still covers the arithmetic.
            return;
        };
        let child_pid = child.id();
        let mut saw_child = false;
        for _ in 0..20 {
            let processes = read_processes();
            if let Some(fact) = processes.get(&child_pid) {
                assert_eq!(fact.parent, std::process::id());
                saw_child = fact.resident_bytes.is_some();
                if saw_child {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.wait();
        assert!(saw_child, "a live child is observed with its resident size");
        // After it exits the tree no longer contains it.
        let processes = read_processes();
        assert!(
            !processes.contains_key(&child_pid)
                || processes[&child_pid].parent != std::process::id(),
            "an exited child is gone from the tree"
        );
    }

    #[test]
    fn a_missing_root_is_not_an_empty_measurement() {
        let processes: BTreeMap<u32, ProcessFact> =
            [(50, fact(50, 1, Some(1000)))].into_iter().collect();
        assert_eq!(tree_total(&processes, 10), None);
        // A member that exits mid-scan leaves the tick incomplete rather than
        // silently smaller: the sum is reported, but it is not evidence.
        let exiting: BTreeMap<u32, ProcessFact> =
            [(1, fact(1, 0, Some(10))), (2, fact(2, 1, None))]
                .into_iter()
                .collect();
        assert_eq!(tree_total(&exiting, 1), Some((10, false, 10, 1)));
        // An unreadable process outside the tree does not spoil a complete
        // tree: only members of the measured tree are evidence.
        let unrelated: BTreeMap<u32, ProcessFact> = [
            (1, fact(1, 0, Some(10))),
            (2, fact(2, 1, Some(20))),
            (9, fact(9, 99, None)),
        ]
        .into_iter()
        .collect();
        assert_eq!(tree_total(&unrelated, 1), Some((30, true, 20, 2)));
    }

    #[test]
    fn stat_parsing_survives_spaces_and_parentheses_in_the_command_name() {
        // `comm` is parenthesised, so splitting on whitespace is only safe
        // after the final `)`.
        let stat = "4242 (geolibre slope (x)) S 1 4242 4242 0 -1 4194560 100 0 0 0 \
                    5 3 0 0 20 0 7 0 987654 1000 200";
        assert_eq!(parse_stat(stat), Some((1, 987654)));
        assert_eq!(
            resident_bytes("Name:\tcanopi\nVmRSS:\t  2048 kB\n"),
            Some(2 * 1024 * 1024)
        );
        assert_eq!(resident_bytes("Name:\tcanopi\n"), None);
    }

    fn measured(
        baseline_bytes: u64,
        baseline_complete: bool,
        peak_total: Option<u64>,
        peak_subtotal_bytes: u64,
        complete_ticks: u64,
        incomplete_ticks: u64,
    ) -> TreeMeasurement {
        TreeMeasurement::Sampled {
            baseline_bytes,
            baseline_complete,
            peak_total_bytes: peak_total.unwrap_or(0),
            peak_incremental_bytes: peak_total.map(|peak| peak.saturating_sub(baseline_bytes)),
            peak_subtotal_bytes,
            complete_ticks,
            incomplete_ticks,
            interval_ms: 50,
            peak_member_bytes: peak_total.unwrap_or(0),
            peak_member_count: 1,
        }
    }

    #[test]
    fn a_complete_baseline_and_one_complete_sample_can_pass() {
        let measurement = measured(10, true, Some(20), 20, 1, 0);
        assert_eq!(
            measurement.budget_outcome(),
            BudgetOutcome::Within {
                incremental_bytes: 10,
                complete_ticks: 1,
                incomplete_ticks: 0,
            }
        );
        assert_eq!(measurement.peak_incremental_bytes(), Some(10));
    }

    #[test]
    fn incomplete_ticks_without_one_complete_sample_never_pass() {
        // The reported reproduction: ten incomplete ticks and no complete
        // workload sample must not become an incremental zero.
        let measurement = measured(100, true, None, 100, 0, 10);
        assert!(matches!(
            measurement.budget_outcome(),
            BudgetOutcome::Unavailable(_)
        ));
        assert_eq!(measurement.peak_incremental_bytes(), None);
        // Zero ticks are the same: no evidence is not a pass.
        let measurement = measured(100, true, None, 0, 0, 0);
        assert!(matches!(
            measurement.budget_outcome(),
            BudgetOutcome::Unavailable(_)
        ));
    }

    #[test]
    fn an_incomplete_baseline_is_not_evidence() {
        let outcome = measured(100, false, Some(700), 700, 3, 2).budget_outcome();
        assert!(
            matches!(outcome, BudgetOutcome::Unavailable(ref reason) if reason.contains("baseline")),
            "{outcome:?}"
        );
    }

    #[test]
    fn an_observed_over_budget_subtotal_fails_despite_missing_samples() {
        // A later healthy tick plus an incomplete tick whose known subtotal
        // already exceeds the budget: the violation survives missing data.
        let outcome = measured(
            100,
            true,
            Some(200),
            COMBINED_MEMORY_BUDGET_BYTES + 512,
            1,
            4,
        )
        .budget_outcome();
        assert!(
            matches!(outcome, BudgetOutcome::OverBudget { .. }),
            "{outcome:?}"
        );
        // A partial low subtotal never promotes to a passing peak.
        let outcome = measured(100, true, None, 150, 0, 3).budget_outcome();
        assert!(
            matches!(outcome, BudgetOutcome::Unavailable(_)),
            "{outcome:?}"
        );
    }

    // Samples Linux /proc; other platforms report Unsupported (tested below).
    #[cfg(target_os = "linux")]
    #[test]
    fn sampling_reports_a_baseline_and_a_peak_of_the_live_tree() {
        let sampler = match Sampler::start() {
            Sampler::Running(sampler) => sampler,
            Sampler::Unavailable(reason) => panic!("this platform samples /proc: {reason}"),
        };
        // Allocate a measurable amount so a later tick must exceed the baseline.
        let ballast = vec![7u8; 32 * 1024 * 1024];
        // canopi-1tl7: wait for complete ticks, not a fixed 150 ms, which a
        // loaded machine could pass without scheduling the sampling thread. A
        // tick under way at the allocation may have read /proc before it, so
        // wait for two more: the second began after the ballast existed.
        let ticks_at_allocation = sampler.complete_ticks();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while sampler.complete_ticks() < ticks_at_allocation + 2
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let measurement = sampler.finish();
        std::hint::black_box(&ballast);
        match measurement {
            TreeMeasurement::Sampled {
                baseline_bytes,
                baseline_complete,
                peak_total_bytes,
                peak_incremental_bytes,
                complete_ticks,
                interval_ms,
                ..
            } => {
                assert!(
                    baseline_bytes > 0,
                    "the idle baseline is a real measurement"
                );
                assert!(baseline_complete, "an idle tree is fully readable");
                assert!(complete_ticks > 0, "at least one complete tick completed");
                assert!(peak_total_bytes >= baseline_bytes);
                assert_eq!(
                    peak_incremental_bytes,
                    Some(peak_total_bytes - baseline_bytes),
                    "incremental is exactly the baseline-relative peak"
                );
                assert!(interval_ms <= 100, "the interval stays within the contract");
            }
            other => panic!("expected a sampled measurement: {other:?}"),
        }
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn other_platforms_report_the_measurement_as_unavailable_not_as_a_number() {
        let measurement = Sampler::start().finish();
        assert!(
            matches!(measurement, TreeMeasurement::Unsupported(_)),
            "no /proc means no sampled figure: {measurement:?}"
        );
    }

    // Samples Linux /proc; other platforms report Unsupported (tested below).
    #[cfg(target_os = "linux")]
    #[test]
    fn stopping_before_the_first_tick_invents_no_workload_evidence() {
        let sampler = match Sampler::start() {
            Sampler::Running(sampler) => sampler,
            Sampler::Unavailable(reason) => panic!("this platform samples /proc: {reason}"),
        };
        // Finish immediately: no interval has completed, so there is no
        // workload sample and the gate cannot pass.
        let measurement = sampler.finish();
        match &measurement {
            TreeMeasurement::Sampled {
                complete_ticks,
                incomplete_ticks,
                peak_incremental_bytes,
                ..
            } => {
                assert_eq!(*complete_ticks, 0, "a stopped sampler adds no tick");
                assert_eq!(*incomplete_ticks, 0);
                assert_eq!(*peak_incremental_bytes, None);
            }
            other => panic!("expected a sampled measurement: {other:?}"),
        }
        assert!(matches!(
            measurement.budget_outcome(),
            BudgetOutcome::Unavailable(_)
        ));
    }
}
