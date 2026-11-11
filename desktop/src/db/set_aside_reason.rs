//! Why a database file is set aside, and what the user is told for each reason.

use canopi_types::health::{StoreHealth, StoreNotice, StoreOpenStatus};

/// Why a database file is set aside: the suffix its new name carries, its health once
/// moved, and the startup message when the move fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetAsideReason {
    Before2_0,
    Corrupt,
}

impl SetAsideReason {
    pub(super) fn suffix(self) -> &'static str {
        match self {
            Self::Before2_0 => "before-2.0",
            Self::Corrupt => "corrupt",
        }
    }

    /// The user DB's health once its file was set aside as `file`, a file name only
    /// (2.1-Q285): a pre-2.0 database is told once by a notice (ADR 0021), a damaged one by
    /// its status (NAT-02).
    pub(super) fn health(self, file: String) -> StoreHealth {
        let (status, notice) = match self {
            Self::Before2_0 => (StoreOpenStatus::Ready, Some(StoreNotice::MovedAsidePre20)),
            Self::Corrupt => (StoreOpenStatus::SetAsideDamaged { file }, None),
        };
        StoreHealth { status, notice }
    }

    /// The English pre-webview message when the move aside fails. 2.1-Q288's wording is for
    /// a damaged database only; a pre-2.0 one is healthy, so its message names no damage.
    pub fn startup_refusal(self) -> &'static str {
        match self {
            Self::Before2_0 => {
                "Canopi could not move its earlier data file aside to start fresh. \
                 Check that the Canopi data folder can be written to, then start Canopi again."
            }
            Self::Corrupt => {
                "Canopi could not start: its saved data is damaged and could not be moved aside. \
                 Free some disk space or check folder permissions, then start Canopi again."
            }
        }
    }
}
