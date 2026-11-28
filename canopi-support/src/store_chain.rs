//! Local-data store migration chain runner (ADR 0026, contracts §11, 2.1-M157).
//!
//! Runs ordered frozen migration steps over [`canopi_types::store_chain::StoreFloor`]
//! and [`canopi_types::store_chain::admit`], ensuring every version bump between
//! `min_readable` and `current` has an explicit step.

use canopi_types::store_chain::{Admission, StoreFloor, admit_version};

/// One frozen migration step advancing a store from `from` to `to` (`from + 1`).
pub struct MigrationStep<Ctx, E> {
    /// Version before this step runs.
    pub from: u32,
    /// Version after this step succeeds (`from + 1`).
    pub to: u32,
    /// Human-readable step identifier for diagnostics.
    pub name: &'static str,
    /// Synchronous migration function applied to the store context.
    pub run: fn(&mut Ctx) -> Result<(), E>,
}

/// An ordered migration chain bound to one [`StoreFloor`].
pub struct StoreChain<'a, Ctx, E> {
    /// Version bounds for this store.
    pub floor: StoreFloor,
    /// Contiguous frozen steps from `floor.min_readable` to `floor.current`.
    pub steps: &'a [MigrationStep<Ctx, E>],
}

/// Outcome of admitting and (when migratable) migrating a store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainOutcome {
    /// Store did not exist yet; caller should initialize at `current`.
    Absent {
        /// Target version to initialize.
        current: u32,
    },
    /// Store is already at `current`.
    Current {
        /// Current version.
        version: u32,
    },
    /// Store was migrated across one or more frozen steps to `to`.
    Migrated {
        /// Version before migration.
        from: u32,
        /// Version after migration (`floor.current`).
        to: u32,
        /// Number of steps executed.
        steps_run: usize,
    },
    /// Store is newer than `current` but within `max_readable`; open read-only.
    NewerReadable {
        /// Stored version found.
        version: u32,
    },
}

/// Failure when validating, admitting, or migrating a store chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainError<E> {
    /// The declared step slice does not match `floor` (`min_readable..current`).
    InvalidChain {
        /// Description of the structural mismatch.
        reason: &'static str,
    },
    /// Stored version is below `min_readable` (pre-2.0 or unsupported legacy form).
    BeforeFloor {
        /// Stored version found.
        version: u32,
        /// Minimum readable version.
        min_readable: u32,
    },
    /// Stored version exceeds `max_readable` and must be refused untouched.
    RefusedNewer {
        /// Stored version found.
        version: u32,
        /// Maximum readable version.
        max_readable: u32,
    },
    /// One migration step failed; subsequent steps did not run.
    StepFailed {
        /// Version the failing step started from.
        from: u32,
        /// Version the failing step targeted.
        to: u32,
        /// Name of the failing step.
        name: &'static str,
        /// Underlying step error.
        error: E,
    },
}

impl<Ctx, E> StoreChain<'_, Ctx, E> {
    /// Verifies that `steps` covers `floor.min_readable..floor.current` contiguously.
    pub fn validate(&self) -> Result<(), ChainError<E>> {
        let expected_steps = usize::try_from(self.floor.step_count()).unwrap_or(usize::MAX);
        if self.steps.len() != expected_steps {
            return Err(ChainError::InvalidChain {
                reason: "step count does not match floor.current - floor.min_readable",
            });
        }
        for (idx, step) in self.steps.iter().enumerate() {
            let offset = u32::try_from(idx).unwrap_or(u32::MAX);
            let expected_from = self.floor.min_readable.saturating_add(offset);
            let expected_to = expected_from.saturating_add(1);
            if step.from != expected_from || step.to != expected_to {
                return Err(ChainError::InvalidChain {
                    reason: "migration steps must be contiguous from min_readable to current",
                });
            }
        }
        Ok(())
    }

    /// Admits `stored_version` against `floor` and runs any required frozen steps in order.
    pub fn admit_and_migrate(
        &self,
        stored_version: Option<u32>,
        ctx: &mut Ctx,
    ) -> Result<ChainOutcome, ChainError<E>> {
        self.validate()?;
        match admit_version(self.floor, stored_version) {
            Admission::Absent => Ok(ChainOutcome::Absent {
                current: self.floor.current,
            }),
            Admission::Current => Ok(ChainOutcome::Current {
                version: self.floor.current,
            }),
            Admission::BeforeFloor {
                version,
                min_readable,
            } => Err(ChainError::BeforeFloor {
                version,
                min_readable,
            }),
            Admission::NewerReadable { version } => Ok(ChainOutcome::NewerReadable { version }),
            Admission::RefusedNewer {
                version,
                max_supported,
            } => Err(ChainError::RefusedNewer {
                version,
                max_readable: max_supported,
            }),
            Admission::Migratable { from } => self.run_from(from, ctx),
        }
    }

    fn run_from(&self, from: u32, ctx: &mut Ctx) -> Result<ChainOutcome, ChainError<E>> {
        let start_idx = usize::try_from(from - self.floor.min_readable).unwrap_or(usize::MAX);
        let slice = self
            .steps
            .get(start_idx..)
            .ok_or(ChainError::InvalidChain {
                reason: "migratable start index out of bounds",
            })?;
        for step in slice {
            (step.run)(ctx).map_err(|error| ChainError::StepFailed {
                from: step.from,
                to: step.to,
                name: step.name,
                error,
            })?;
        }
        Ok(ChainOutcome::Migrated {
            from,
            to: self.floor.current,
            steps_run: slice.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{ChainError, ChainOutcome, MigrationStep, StoreChain};
    use canopi_types::health::StoreId;
    use canopi_types::store_chain::StoreFloor;

    fn step_25_to_26(log: &mut Vec<&'static str>) -> Result<(), &'static str> {
        log.push("25->26");
        Ok(())
    }

    fn step_26_to_27_fail(log: &mut Vec<&'static str>) -> Result<(), &'static str> {
        log.push("26->27");
        Err("boom")
    }

    #[test]
    fn runs_migratable_steps_and_admits_absent_current_and_newer() {
        let floor = StoreFloor::from_steps(StoreId::LibraryCatalogue, 25, 1, Some(27));
        let steps = [MigrationStep {
            from: 25,
            to: 26,
            name: "v25_to_v26",
            run: step_25_to_26,
        }];
        let chain = StoreChain {
            floor,
            steps: &steps,
        };
        let mut log = Vec::new();
        assert_eq!(
            chain.admit_and_migrate(None, &mut log),
            Ok(ChainOutcome::Absent { current: 26 })
        );
        assert_eq!(
            chain.admit_and_migrate(Some(26), &mut log),
            Ok(ChainOutcome::Current { version: 26 })
        );
        assert_eq!(
            chain.admit_and_migrate(Some(27), &mut log),
            Ok(ChainOutcome::NewerReadable { version: 27 })
        );
        assert_eq!(
            chain.admit_and_migrate(Some(28), &mut log),
            Err(ChainError::RefusedNewer {
                version: 28,
                max_readable: 27
            })
        );
        assert_eq!(
            chain.admit_and_migrate(Some(24), &mut log),
            Err(ChainError::BeforeFloor {
                version: 24,
                min_readable: 25
            })
        );
        assert_eq!(
            chain.admit_and_migrate(Some(25), &mut log),
            Ok(ChainOutcome::Migrated {
                from: 25,
                to: 26,
                steps_run: 1
            })
        );
        assert_eq!(log, vec!["25->26"]);
    }

    #[test]
    fn stops_on_first_step_failure_and_rejects_mismatched_steps() {
        let floor = StoreFloor::from_steps(StoreId::LibraryCatalogue, 25, 2, None);
        let steps = [
            MigrationStep {
                from: 25,
                to: 26,
                name: "v25_to_v26",
                run: step_25_to_26,
            },
            MigrationStep {
                from: 26,
                to: 27,
                name: "v26_to_v27",
                run: step_26_to_27_fail,
            },
        ];
        let chain = StoreChain {
            floor,
            steps: &steps,
        };
        let mut log = Vec::new();
        assert_eq!(
            chain.admit_and_migrate(Some(25), &mut log),
            Err(ChainError::StepFailed {
                from: 26,
                to: 27,
                name: "v26_to_v27",
                error: "boom"
            })
        );
        assert_eq!(log, vec!["25->26", "26->27"]);

        let bad_chain = StoreChain::<Vec<&'static str>, &'static str> {
            floor,
            steps: &steps[..1],
        };
        assert!(matches!(
            bad_chain.validate(),
            Err(ChainError::InvalidChain { .. })
        ));
    }
}
