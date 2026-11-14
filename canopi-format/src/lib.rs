//! The `.canopi` format crate (ADR 0026; contracts §18 R7, F28): the one place a
//! `.canopi` file is decoded, read natively by the Desktop host and on Web
//! through `canopi-format-wasm` in the format worker (2.1-M476).
//!
//! Step 2.0.4 builds its read half: the schema walker ([`schema`]), which the
//! Desktop v9 decode in `desktop/src/design/format.rs` calls until 2b moves that
//! decode here, and the read admission of a version 10 or later file ([`read`])
//! by the v10 read shape ([`v10`]) into the read-only view.
#![deny(missing_docs)]

pub mod read;
pub mod schema;
pub mod v10;
