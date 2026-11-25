//! The `.canopi` format crate (ADR 0026; contracts §10, §11, §18 R7, F28):
//! the one place a `.canopi` file or saved-stamp payload is decoded, migrated,
//! admitted and canonically encoded — natively on Desktop and via
//! `canopi-format-wasm` on Web (2.1-M476, 2.1-M539).
#![deny(missing_docs)]

pub mod chain;
pub mod core;
pub mod read;
pub mod schema;
pub mod spec_emit;
mod stamp_canopi;
pub mod stamps;
pub mod v10;

#[cfg(test)]
mod conformance_tests;
#[cfg(test)]
mod core_tests;
