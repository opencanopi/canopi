//! Native support primitives for Canopi (ADR 0023, ADR 0025; 2.1-M28, 2.1-M541).
//!
//! - [`durable`]: [`durable::DurableFs`], [`durable::publish_durably`],
//!   [`durable::remove_durably`], [`durable::move_aside_durably`], and case-folded
//!   [`durable::TargetLocks`].
//! - [`executor`]: lane-based native executor (`OpSpec`, `CancelToken`, priority queues,
//!   deadlines, structured settlement telemetry, and the one private `blocking::spawn_with_settle`).
//! - [`fault_fs`]: ALICE/lazyfs-style [`fault_fs::FaultFs`] crash and fault-injection
//!   implementation of [`durable::DurableFs`].
//! - [`fs_space`]: cross-platform free-space query backed by `fs4`.
//! - [`hash`]: SHA-256 content fingerprinting.
//! - [`time`]: wall-clock and duration helpers.

pub mod durable;
mod durable_locks;
mod durable_os;
pub mod executor;
pub mod fault_fs;
mod fault_fs_ops;
pub mod fs_space;
pub mod hash;
pub mod time;
