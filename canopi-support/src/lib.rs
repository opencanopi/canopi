//! Native support primitives for Canopi (ADR 0023; 2.1-M541, 2.1-M542).
//!
//! Phase 2b keeps `canopi-support` narrow (no `tokio` until Phase 3 N1):
//! - [`durable`]: [`durable::DurableFs`], [`durable::publish_durably`],
//!   [`durable::remove_durably`], [`durable::move_aside_durably`], and case-folded
//!   [`durable::TargetLocks`].
//! - [`fault_fs`]: ALICE/lazyfs-style [`fault_fs::FaultFs`] crash and fault-injection
//!   implementation of [`durable::DurableFs`].
//! - [`fs_space`]: cross-platform free-space query backed by `fs4`.
//! - [`hash`]: SHA-256 content fingerprinting.

pub mod durable;
mod durable_locks;
mod durable_os;
pub mod fault_fs;
mod fault_fs_ops;
pub mod fs_space;
pub mod hash;
