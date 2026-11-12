//! The `.canopi` format crate (ADR 0026; contracts §18 R7, F28): the one place a
//! `.canopi` file is decoded, read natively by the Desktop host and on Web
//! through `canopi-format-wasm` in the format worker (2.1-M476).
//!
//! Step 2.0.4 builds its read half: the schema walker and the v10 read
//! admission move here in R1-2. Until then the crate is empty, so its policy
//! rows (`format-crate-bans-native`, `canopi-decode-only-in-format`) hold from
//! its first commit.
