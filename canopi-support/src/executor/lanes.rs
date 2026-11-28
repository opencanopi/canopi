//! Executor lane table, priorities, deadlines, and `OpSpec` (ADR 0025, contracts §3).
//!
//! `canopi-support` owns the request lanes and the Job lane as one data table; it owns
//! no slot primitive and never names a job or service crate (the job runner in
//! `canopi-library` owns `Slot { Heavy, Display }` gated against [`JOB_WORKERS`]).

use canopi_types::failure::Lane as FailureLane;
use std::time::Duration;

/// Number of concurrent workers on the Job lane (contracts §3).
pub const JOB_WORKERS: usize = 2;

/// Queue bound on the Job lane (contracts §3).
pub const JOB_QUEUE_BOUND: usize = 2;

/// Reserved blocking-pool slot for the settings boot read (contracts §3).
pub const RESERVED_BOOT_READS: usize = 1;

/// Minimum blocking-pool size required to hold all lane workers plus the reserved boot read.
pub const BLOCKING_POOL_FLOOR: usize = 16;

/// One scheduling lane in the native executor (contracts §3).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum ExecutorLane {
    /// The plant catalog.
    Catalog,
    /// `user.db`: favourites, stamps, settings, recent files.
    UserData,
    /// Data library catalogue row transactions.
    Library,
    /// User files: Designs, Drafts, raster reads, header probes, exports.
    Local,
    /// HTTP requests.
    Network,
    /// Heavy LiDAR work and display preparation, admitted by the job runner's slots.
    Job,
}

impl ExecutorLane {
    /// All six lanes in table order.
    pub const ALL: [Self; 6] = [
        Self::Catalog,
        Self::UserData,
        Self::Library,
        Self::Local,
        Self::Network,
        Self::Job,
    ];

    /// Dense index into [`LANES`].
    #[must_use]
    pub const fn index(self) -> usize {
        match self {
            Self::Catalog => 0,
            Self::UserData => 1,
            Self::Library => 2,
            Self::Local => 3,
            Self::Network => 4,
            Self::Job => 5,
        }
    }

    /// Stable lowercase identifier for structured settlement logs.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Catalog => "catalog",
            Self::UserData => "user_data",
            Self::Library => "library",
            Self::Local => "local",
            Self::Network => "network",
            Self::Job => "job",
        }
    }

    /// The wire-level [`FailureLane`] for `FailureCode::Busy { lane }`.
    /// Returns `None` for [`Self::Job`], which never settles `Busy` (contracts §3).
    #[must_use]
    pub const fn failure_lane(self) -> Option<FailureLane> {
        match self {
            Self::Catalog => Some(FailureLane::Catalog),
            Self::UserData => Some(FailureLane::UserData),
            Self::Library => Some(FailureLane::Library),
            Self::Local => Some(FailureLane::Local),
            Self::Network => Some(FailureLane::Network),
            Self::Job => None,
        }
    }
}

/// Static scheduling configuration for one [`ExecutorLane`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LaneConfig {
    /// Maximum concurrent running tasks on this lane.
    pub workers: usize,
    /// Maximum queued waiters before back-pressure holds new enqueues until a slot frees or deadline expires.
    pub queue_bound: usize,
    /// Default interactive enqueue-to-start deadline (`None` for the Job lane).
    pub interactive_deadline: Option<Duration>,
    /// Running-time threshold above which a settled request marks `slow = true`.
    pub slow_budget: Duration,
    /// Optional inner-parallelism hint for heavy compute lanes (`Some` on Job).
    pub inner_parallelism: Option<usize>,
}

/// The single production lane table (contracts §3).
pub const LANES: [LaneConfig; 6] = [
    // Catalog
    LaneConfig {
        workers: 1,
        queue_bound: 8,
        interactive_deadline: Some(Duration::from_secs(2)),
        slow_budget: Duration::from_secs(2),
        inner_parallelism: None,
    },
    // UserData
    LaneConfig {
        workers: 1,
        queue_bound: 8,
        interactive_deadline: Some(Duration::from_secs(2)),
        slow_budget: Duration::from_secs(2),
        inner_parallelism: None,
    },
    // Library
    LaneConfig {
        workers: 1,
        queue_bound: 8,
        interactive_deadline: Some(Duration::from_secs(2)),
        slow_budget: Duration::from_secs(2),
        inner_parallelism: None,
    },
    // Local
    LaneConfig {
        workers: 2,
        queue_bound: 6,
        interactive_deadline: Some(Duration::from_secs(10)),
        slow_budget: Duration::from_secs(10),
        inner_parallelism: None,
    },
    // Network
    LaneConfig {
        workers: 4,
        queue_bound: 12,
        interactive_deadline: Some(Duration::from_secs(30)),
        slow_budget: Duration::from_secs(30),
        inner_parallelism: None,
    },
    // Job (2 workers, queue bound 2, Deadline::Unbounded)
    LaneConfig {
        workers: JOB_WORKERS,
        queue_bound: JOB_QUEUE_BOUND,
        interactive_deadline: None,
        slow_budget: Duration::from_secs(60),
        inner_parallelism: Some(0),
    },
];

/// Returns the production [`LaneConfig`] for `lane`.
#[must_use]
pub const fn lane_config(lane: ExecutorLane) -> LaneConfig {
    LANES[lane.index()]
}

/// Total running workers across all lanes in `lanes`.
#[must_use]
pub const fn total_workers(lanes: &[LaneConfig; 6]) -> usize {
    let mut sum = 0;
    let mut i = 0;
    while i < lanes.len() {
        sum += lanes[i].workers;
        i += 1;
    }
    sum
}

/// Request priority within a lane: [`Self::Interactive`] always starts before
/// [`Self::Background`], with FIFO ordering within each priority (contracts §3).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Priority {
    /// User-facing interactive work.
    Interactive,
    /// Background / deferred work.
    Background,
}

/// Enqueue-to-start deadline for one request (contracts §3).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Deadline {
    /// Settles `FailureCode::Busy { lane }` if not started within this duration.
    Bounded(Duration),
    /// Never expires in queue; reserved for system work and Job-lane executions.
    Unbounded,
}

/// Declarative scheduling specification owned beside each facade method (ADR 0023, ADR 0025).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OpSpec {
    /// Dotted operation name (`library.delete_item`), carried in `Failure.op` and logs.
    pub op: &'static str,
    /// Target lane.
    pub lane: ExecutorLane,
    /// Queue priority within `lane`.
    pub priority: Priority,
    /// Enqueue-to-start deadline.
    pub deadline: Deadline,
    /// Running-time threshold above which settlement sets `slow = true`.
    pub slow_budget: Duration,
    /// Optional supersession key: a newer request with the same key cancels the earlier
    /// active request's token with [`super::CancelReason::Superseded`].
    pub supersede_key: Option<&'static str>,
}

impl OpSpec {
    /// Interactive request using the lane's default deadline and slow budget.
    #[must_use]
    pub const fn interactive(op: &'static str, lane: ExecutorLane) -> Self {
        let cfg = lane_config(lane);
        let deadline = match cfg.interactive_deadline {
            Some(d) => Deadline::Bounded(d),
            None => Deadline::Unbounded,
        };
        Self {
            op,
            lane,
            priority: Priority::Interactive,
            deadline,
            slow_budget: cfg.slow_budget,
            supersede_key: None,
        }
    }

    /// Background request using the lane's default deadline and slow budget.
    #[must_use]
    pub const fn background(op: &'static str, lane: ExecutorLane) -> Self {
        let cfg = lane_config(lane);
        let deadline = match cfg.interactive_deadline {
            Some(d) => Deadline::Bounded(d),
            None => Deadline::Unbounded,
        };
        Self {
            op,
            lane,
            priority: Priority::Background,
            deadline,
            slow_budget: cfg.slow_budget,
            supersede_key: None,
        }
    }

    /// System or Job-lane request with [`Deadline::Unbounded`].
    #[must_use]
    pub const fn system(op: &'static str, lane: ExecutorLane) -> Self {
        let cfg = lane_config(lane);
        Self {
            op,
            lane,
            priority: Priority::Background,
            deadline: Deadline::Unbounded,
            slow_budget: cfg.slow_budget,
            supersede_key: None,
        }
    }

    /// Overrides the enqueue-to-start deadline.
    #[must_use]
    pub const fn with_deadline(mut self, deadline: Deadline) -> Self {
        self.deadline = deadline;
        self
    }

    /// Sets a supersession key so newer requests cancel earlier ones with `Superseded`.
    #[must_use]
    pub const fn with_supersede_key(mut self, key: &'static str) -> Self {
        self.supersede_key = Some(key);
        self
    }

    /// Overrides the running-time slow threshold.
    #[must_use]
    pub const fn with_slow_budget(mut self, slow_budget: Duration) -> Self {
        self.slow_budget = slow_budget;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BLOCKING_POOL_FLOOR, ExecutorLane, JOB_QUEUE_BOUND, JOB_WORKERS, LANES,
        RESERVED_BOOT_READS, lane_config, total_workers,
    };

    #[test]
    fn lane_table_workers_plus_reserved_boot_read_fit_blocking_pool() {
        let needed = total_workers(&LANES) + RESERVED_BOOT_READS;
        assert!(
            needed <= BLOCKING_POOL_FLOOR,
            "lane workers ({}) + reserved boot read ({RESERVED_BOOT_READS}) exceeds pool floor ({BLOCKING_POOL_FLOOR})",
            total_workers(&LANES)
        );
        for lane in ExecutorLane::ALL {
            let cfg = lane_config(lane);
            assert!(cfg.workers > 0);
            assert!(cfg.queue_bound > 0);
        }
        assert_eq!(lane_config(ExecutorLane::Job).workers, JOB_WORKERS);
        assert_eq!(lane_config(ExecutorLane::Job).queue_bound, JOB_QUEUE_BOUND);
        assert!(
            lane_config(ExecutorLane::Job)
                .interactive_deadline
                .is_none()
        );
        assert!(ExecutorLane::Job.failure_lane().is_none());
    }
}
